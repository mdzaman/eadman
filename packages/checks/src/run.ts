import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DOCOPS_VERSION,
  findingFingerprint,
  gateBlocked,
  levelToSeverity,
  matchesGlob,
  sortFindings,
  type CheckReport,
  type CoverageReport,
  type EntityChange,
  type EntityDefinition,
  type Finding,
  type Level,
} from "@docops/core";
import type { LoadedConfig } from "@docops/config";
import { buildReferenceIndex, computeCoverage, detectDrift, diffEntities, type ReferenceIndex } from "@docops/engine";
import { extractSource } from "@docops/extractors";
import { frontmatterList, isIgnored, loadPages, syncIncludes, type ParsedPage } from "@docops/markdown";
import { ownersFor, parseCodeowners } from "./codeowners.ts";
import {
  checkA11y,
  checkFreshness,
  checkFrontmatter,
  checkInternalLinks,
  checkSecrets,
  checkStyle,
  createEmitter,
  repoPath,
} from "./rules.ts";
import { checkUrl, type LinkCheckResult } from "./ssrf.ts";

/** Reads a repository-relative file at some revision; null when it does not exist. */
export type FileReader = (repoPath: string) => Promise<string | null>;

export interface RunChecksInput {
  repoRoot: string;
  loaded: LoadedConfig;
  /** Reader for the head revision (the working tree in CI). */
  readHead?: FileReader;
  head?: { ref: string; sha: string | null } | undefined;
  base?: { ref: string; sha: string | null; read: FileReader } | undefined;
  /** Repository-relative files changed between base and head (required for drift gates). */
  changedFiles?: ReadonlySet<string> | undefined;
  /** The PR carries the schema-change waiver label. */
  waived?: boolean | undefined;
  /** Restrict to rule groups (`drift`) or rule ids (`links/broken-anchor`). */
  only?: readonly string[] | undefined;
  /** Fingerprints dismissed on the platform (suppressed). */
  dismissed?: ReadonlySet<string> | undefined;
  failOn?: "error" | "warning" | "never" | undefined;
  now?: Date | undefined;
  checkExternalUrl?: ((url: string) => Promise<LinkCheckResult>) | undefined;
}

export interface RunChecksResult {
  report: CheckReport;
  pages: ParsedPage[];
  snippets: Map<string, ParsedPage>;
  headEntities: EntityDefinition[];
  baseEntities?: EntityDefinition[] | undefined;
  headRefs: ReferenceIndex;
  changes: EntityChange[];
  coverage: CoverageReport;
  sources: Array<{ key: string; format: string; path: string; extractor?: string | undefined; extractorVersion?: string | undefined }>;
  suppressed: number;
}

const workingTreeReader =
  (root: string): FileReader =>
  async (path) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return null;
    }
  };

function selected(only: readonly string[] | undefined, ruleId: string): boolean {
  if (!only || only.length === 0) return true;
  const group = ruleId.split("/")[0] ?? ruleId;
  return only.some((o) => o === ruleId || o === group || (o === "schema" && group === "schema"));
}

async function extractAll(loaded: LoadedConfig, read: FileReader, findings: Finding[] | null) {
  const entities: EntityDefinition[] = [];
  const sources: RunChecksResult["sources"] = [];
  for (const source of loaded.config.sources) {
    const content = await read(source.path);
    if (content === null) {
      findings?.push({
        ruleId: "config/invalid-source",
        category: "config",
        severity: "error",
        origin: "deterministic",
        message: `Source \`${source.id}\` (${source.type}) not found at ${source.path}.`,
        file: loaded.path,
        evidence: { source: source.id },
        fingerprint: findingFingerprint(["config/invalid-source", source.id, "missing"]),
      });
      continue;
    }
    try {
      const result = extractSource(source.type, { sourceKey: source.id, path: source.path, content, visibility: source.visibility });
      entities.push(...result.entities);
      sources.push({ key: source.id, format: source.type, path: source.path, extractor: result.extractor?.id, extractorVersion: result.extractor?.version });
      if (result.warning) {
        findings?.push({
          ruleId: "config/invalid-source",
          category: "config",
          severity: "info",
          origin: "deterministic",
          message: `Source \`${source.id}\`: ${result.warning}.`,
          file: loaded.path,
          evidence: { source: source.id },
          fingerprint: findingFingerprint(["config/invalid-source", source.id, "unsupported"]),
        });
      }
    } catch (error) {
      findings?.push({
        ruleId: "config/invalid-source",
        category: "config",
        severity: "error",
        origin: "deterministic",
        message: `Source \`${source.id}\` could not be extracted: ${(error as Error).message}`,
        file: source.path,
        evidence: { source: source.id },
        fingerprint: findingFingerprint(["config/invalid-source", source.id, "error"]),
      });
    }
  }
  return { entities, sources };
}

/**
 * Run every configured quality gate. Shared by the CLI (in customer CI) and hosted workers,
 * so a finding looks the same wherever it is produced (ADR-0010).
 */
export async function runChecks(input: RunChecksInput): Promise<RunChecksResult> {
  const started = Date.now();
  const { config } = input.loaded;
  const checks = config.checks;
  const docsRoot = config.docs.root.replace(/\/$/, "");
  const docsAbs = join(input.repoRoot, docsRoot);
  const readHead = input.readHead ?? workingTreeReader(input.repoRoot);
  const now = input.now ?? new Date();
  const findings: Finding[] = [];
  const emit = createEmitter(findings);

  const { pages, snippets } = await loadPages(docsAbs, {
    include: config.docs.include,
    exclude: config.docs.exclude,
    snippetsDir: config.docs.snippets,
    defaultPageType: config.docs.defaultPageType,
  });
  const pagesByPath = new Map(pages.map((p) => [p.path, p]));

  // Entities and references.
  const head = await extractAll(input.loaded, readHead, findings);
  const referenceOutDirs = new Map(
    config.sources.filter((s) => s.reference?.enabled !== false && s.reference?.outDir).map((s) => [s.id, s.reference?.outDir ?? ""]),
  );
  const indexOptions = { mentions: checks.drift.mentions, referenceOutDirs };
  const headRefs = buildReferenceIndex(pages, head.entities, indexOptions);

  let changes: EntityChange[] = [];
  let baseEntities: EntityDefinition[] | undefined;
  if (input.base) {
    baseEntities = (await extractAll(input.loaded, input.base.read, null)).entities;
    const baseRefs = buildReferenceIndex(pages, baseEntities, indexOptions);
    changes = diffEntities(baseEntities, head.entities);
    findings.push(
      ...detectDrift({
        changes,
        baseRefs,
        headRefs,
        pages,
        docsRoot,
        changedFiles: input.changedFiles ?? new Set(),
        sourcePaths: new Map(config.sources.map((s) => [s.id, s.path])),
        levels: {
          drift: checks.drift.level,
          changedEntity: checks.drift.level === "off" ? "off" : checks.drift.changedEntityLevel,
          schemaChange: checks.schemaChange.level,
          newEntities: checks.coverage.level === "off" ? "off" : checks.coverage.newEntities,
        },
        coverageKinds: checks.coverage.kinds,
        includeDeprecated: checks.coverage.includeDeprecated,
        waived: input.waived,
        baseEntities,
        headEntities: head.entities,
      }),
    );
  }

  // Coverage.
  const coverage = computeCoverage(head.entities, headRefs, {
    kinds: checks.coverage.kinds,
    includeDeprecated: checks.coverage.includeDeprecated,
    referenceSources: new Set(referenceOutDirs.keys()),
  });
  const measured = checks.coverage.measure === "l1" ? coverage.totals.percentL1 : coverage.totals.percentL2;
  if (checks.coverage.minimum > 0 && coverage.totals.publicEntities > 0 && measured < checks.coverage.minimum) {
    emit(checks.coverage.level, {
      ruleId: "coverage/below-threshold",
      category: "coverage",
      message: `Coverage (${checks.coverage.measure.toUpperCase()}, ${checks.coverage.kinds.join(", ")}) is ${measured}%, below the minimum of ${checks.coverage.minimum}%. Undocumented: ${coverage.undocumented
        .slice(0, 5)
        .map((u) => u.key.split(":").slice(2).join(":"))
        .join(", ")}${coverage.undocumented.length > 5 ? ", …" : ""}`,
      file: input.loaded.path,
      evidence: { measured, minimum: checks.coverage.minimum, undocumented: coverage.undocumented.length },
      fingerprintParts: ["coverage/below-threshold", config.project.id],
    });
  }

  // Unknown explicit entity references.
  for (const unresolved of headRefs.unresolved) {
    emit(checks.frontmatter.level, {
      ruleId: "frontmatter/invalid",
      category: "frontmatter",
      message: `Unknown entity reference \`${unresolved.ref}\` in \`entities:\`.`,
      file: repoPath(docsRoot, unresolved.pagePath),
      line: unresolved.line,
      evidence: { ref: unresolved.ref },
      fingerprintParts: ["frontmatter/invalid", unresolved.pagePath, unresolved.ref],
    });
  }

  // Ownership sources.
  const codeownersFile =
    config.ownership.codeowners === false
      ? null
      : typeof config.ownership.codeowners === "string" && config.ownership.codeowners !== "auto"
        ? config.ownership.codeowners
        : ["CODEOWNERS", ".github/CODEOWNERS", `${docsRoot}/CODEOWNERS`].find((f) => existsSync(join(input.repoRoot, f))) ?? null;
  const codeowners = codeownersFile ? parseCodeowners((await readHead(codeownersFile)) ?? "") : [];

  // Page rules.
  const styleLevel = checks.style.level;
  const ruleLevel = (id: string, fallback: Level): Level => checks.style.rules[id] ?? fallback;
  const ctx = { docsRoot, pagesByPath, assetExists: (p: string) => existsSync(join(docsAbs, p)) };
  const external: Array<{ page: ParsedPage; url: string; line: number }> = [];
  for (const page of pages) {
    checkInternalLinks(page, ctx, checks.links.level, emit);
    checkFrontmatter(page, docsRoot, checks.frontmatter.required, checks.frontmatter.level, emit);
    checkStyle(page, docsRoot, { inclusive: ruleLevel("style/inclusive-language", styleLevel), linkText: ruleLevel("style/non-descriptive-link-text", styleLevel) }, emit);
    checkA11y(page, docsRoot, checks.a11y.level, emit);
    checkSecrets(page, docsRoot, checks.secrets.level, emit);
    const rule = config.ownership.rules.find((r) => matchesGlob(page.path, r.pattern));
    checkFreshness(page, docsRoot, { defaultDays: checks.freshness.defaultSlaDays, byPageType: checks.freshness.byPageType, overrideDays: rule?.slaDays }, now, checks.freshness.level, emit);
    const owners = [...frontmatterList(page, "owners"), ...ownersFor(codeowners, repoPath(docsRoot, page.path)), ...(rule?.owners ?? [])];
    if (owners.length === 0) {
      emit(checks.ownership.level, {
        ruleId: "ownership/missing-owner",
        category: "ownership",
        message: "No owner from frontmatter `owners`, CODEOWNERS or docops.yaml ownership rules.",
        file: repoPath(docsRoot, page.path),
        line: 1,
        evidence: {},
      });
    }
    if (checks.includes.level !== "off" && page.source.includes("docops:include")) {
      const result = await syncIncludes(join(docsAbs, page.path), page.source, async (abs) => readFileSync(abs, "utf8"));
      for (const inc of result.includes.filter((i) => !i.upToDate)) {
        emit(checks.includes.level, {
          ruleId: "includes/out-of-date",
          category: "includes",
          message: `Included file \`${inc.path}\` changed; run \`docops sync\` to update this block.`,
          file: repoPath(docsRoot, page.path),
          line: inc.line,
          evidence: { path: inc.path },
          fingerprintParts: ["includes/out-of-date", page.path, inc.path],
        });
      }
    }
    if (checks.links.level !== "off" && checks.links.external.enabled) {
      for (const link of page.links) {
        if (link.kind === "external" && !checks.links.external.ignore.some((g) => matchesGlob(link.url, g))) external.push({ page, url: link.url, line: link.line });
      }
    }
  }

  // External links (bounded concurrency, cached per URL).
  if (external.length > 0) {
    const check = input.checkExternalUrl ?? ((url: string) => checkUrl(url, checks.links.external.timeoutMs));
    const cache = new Map<string, Promise<LinkCheckResult>>();
    const queue = [...external];
    const workers = Array.from({ length: Math.min(checks.links.external.concurrency, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const pending = cache.get(item.url) ?? check(item.url);
        cache.set(item.url, pending);
        const result = await pending;
        if (!result.ok) {
          emit(checks.links.external.level, {
            ruleId: "links/broken-external",
            category: "links",
            message: `External link ${item.url} failed: ${result.status ? `HTTP ${result.status}` : result.error}.`,
            file: repoPath(docsRoot, item.page.path),
            line: item.line,
            evidence: { url: item.url, status: result.status },
            fingerprintParts: ["links/broken-external", item.page.path, item.url],
          });
        }
      }
    });
    await Promise.all(workers);
  }

  // Suppression: rule filter, inline pragmas, platform dismissals.
  let suppressed = 0;
  const kept = findings.filter((f) => {
    if (!selected(input.only, f.ruleId)) return false;
    if (input.dismissed?.has(f.fingerprint)) {
      suppressed++;
      return false;
    }
    if (f.file?.startsWith(`${docsRoot}/`)) {
      const page = pagesByPath.get(f.file.slice(docsRoot.length + 1));
      if (page && isIgnored(page, f.ruleId, f.line)) {
        suppressed++;
        return false;
      }
    }
    return true;
  });
  sortFindings(kept);

  const failOn = input.failOn ?? checks.failOn;
  const counts = { error: 0, warning: 0, info: 0 };
  const byCategory: Record<string, number> = {};
  for (const f of kept) {
    counts[f.severity]++;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  }
  const blocked = gateBlocked(kept, failOn);
  const severityWord = failOn === "warning" ? "warning or error" : "error";
  const report: CheckReport = {
    schema: "docops.report.v1",
    tool: { name: "docops", version: DOCOPS_VERSION },
    project: { id: config.project.id, repository: config.project.repository },
    base: input.base ? { ref: input.base.ref, sha: input.base.sha } : undefined,
    head: input.head ?? { ref: "WORKTREE", sha: null },
    summary: {
      counts,
      byCategory,
      coverage: { percentL1: coverage.totals.percentL1, percentL2: coverage.totals.percentL2 },
      gate: { blocked, reasons: blocked ? [`${kept.filter((f) => (failOn === "warning" ? f.severity !== "info" : f.severity === "error")).length} finding(s) at ${severityWord} level (failOn=${failOn})`] : [] },
    },
    changes: changes.map((c) => ({ entityKey: c.key, type: c.type, to: c.renamedTo, breaking: c.breaking, userVisible: c.userVisible })),
    findings: kept,
    coverage,
    stats: { pages: pages.length, entities: head.entities.length, references: headRefs.references.length, durationMs: Date.now() - started },
  };
  return { report, pages, snippets, headEntities: head.entities, baseEntities, headRefs, changes, coverage, sources: head.sources, suppressed };
}

export { levelToSeverity };
