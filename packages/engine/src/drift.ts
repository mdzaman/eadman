import {
  findingFingerprint,
  levelToSeverity,
  type EntityChange,
  type EntityDefinition,
  type Finding,
  type Level,
} from "@docops/core";
import type { ParsedPage } from "@docops/markdown";
import { describeChange, formatValue } from "./diff.ts";
import type { ReferenceIndex } from "./references.ts";

export interface DriftInput {
  changes: readonly EntityChange[];
  /** Head pages indexed against BASE entities: finds references to things that changed. */
  baseRefs: ReferenceIndex;
  /** Head pages indexed against HEAD entities: coverage of new entities. */
  headRefs: ReferenceIndex;
  pages: readonly ParsedPage[];
  /** Repository-relative docs root, used to build finding file paths. */
  docsRoot: string;
  /** Repository-relative paths changed between base and head. */
  changedFiles: ReadonlySet<string>;
  /** sourceKey -> repository-relative source path. */
  sourcePaths: ReadonlyMap<string, string>;
  levels: { drift: Level; changedEntity: Level; schemaChange: Level; newEntities: Level };
  coverageKinds: readonly string[];
  includeDeprecated: boolean;
  /** The schema-change waiver label is present on the change. */
  waived?: boolean | undefined;
  minConfidence?: number | undefined;
  /** Base and head entity snapshots (used to find operations that use a changed schema). */
  baseEntities?: readonly EntityDefinition[] | undefined;
  headEntities?: readonly EntityDefinition[] | undefined;
}

const LITERAL_LEAVES = new Set(["default", "enum", "const", "minimum", "maximum", "type", "format"]);

function pagePathOf(docsRoot: string, pagePath: string): string {
  return docsRoot && docsRoot !== "." ? `${docsRoot.replace(/\/$/, "")}/${pagePath}` : pagePath;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalRegExp(value: string): RegExp {
  return /^-?\d+(\.\d+)?$/.test(value)
    ? new RegExp(`(^|[^\\d.])${escapeRegExp(value)}(?![\\d.]*\\d)`)
    : new RegExp(`(^|[^\\w-])${escapeRegExp(value)}(?![\\w-])`);
}

/** Text of the Markdown block (table row, paragraph, list item) that contains `line`. */
function blockTextAt(page: ParsedPage, line: number): { text: string; startLine: number; endLine: number } {
  const lines = page.source.split("\n");
  const block = page.textBlocks.find((b) => b.kind !== "heading" && line >= b.line && line <= b.endLine && b.endLine - b.line < 8);
  if (block) return { text: lines.slice(block.line - 1, block.endLine).join("\n"), startLine: block.line, endLine: block.endLine };
  return { text: lines[line - 1] ?? "", startLine: line, endLine: line };
}

/** Replace a surface form on one line, preferring code-span or quoted occurrences. */
function replaceOnLine(lineText: string, from: string, to: string): string | undefined {
  for (const [open, close] of [["`", "`"], ['"', '"'], ["'", "'"]] as const) {
    const quoted = `${open}${from}${close}`;
    if (lineText.includes(quoted)) return lineText.replaceAll(quoted, `${open}${to}${close}`);
  }
  const re = new RegExp(`(^|[^\\w/])${escapeRegExp(from)}(?![\\w])`, "g");
  if (!re.test(lineText)) return undefined;
  return lineText.replace(re, (_m, pre: string) => `${pre}${to}`);
}

function renamedForm(before: EntityDefinition, after: EntityDefinition, matched: string): string | undefined {
  const i = before.surfaceForms.indexOf(matched);
  if (i >= 0 && after.surfaceForms[i]) return after.surfaceForms[i];
  if (matched === before.name) return after.name;
  return undefined;
}

/** Deterministic drift rules (docs/07-ai-design.md §3.3). */
export function detectDrift(input: DriftInput): Finding[] {
  const findings: Finding[] = [];
  const minConfidence = input.minConfidence ?? 0.6;
  const pageByPath = new Map(input.pages.map((p) => [p.path, p]));
  const usable = (refs: ReferenceIndex, key: string) =>
    (refs.byEntity.get(key) ?? []).filter((r) => r.kind !== "generated" && r.confidence >= minConfidence && pageByPath.has(r.pagePath));
  const add = (level: Level, f: Omit<Finding, "severity" | "origin">) => {
    const severity = levelToSeverity(level);
    if (severity) findings.push({ ...f, severity, origin: "deterministic" });
  };
  const staleValueSeen = new Set<string>();

  // drift/stale-reference: removed or renamed entities still referenced.
  for (const change of input.changes) {
    if (change.type !== "removed" && change.type !== "renamed") continue;
    const seen = new Set<string>();
    for (const ref of usable(input.baseRefs, change.key)) {
      const id = `${ref.pagePath}:${ref.line}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const page = pageByPath.get(ref.pagePath);
      const matched = ref.matchedText ?? change.before?.name ?? change.key;
      let suggestion: Finding["suggestion"];
      if (change.type === "renamed" && change.before && change.after && page && ref.line) {
        const to = renamedForm(change.before, change.after, matched);
        const lineText = page.source.split("\n")[ref.line - 1] ?? "";
        const replacement = to ? replaceOnLine(lineText, matched, to) : undefined;
        if (replacement && replacement !== lineText) suggestion = { kind: "replacement", line: ref.line, replacement, original: lineText };
      }
      add(input.levels.drift, {
        ruleId: "drift/stale-reference",
        category: "drift",
        message:
          change.type === "renamed"
            ? `\`${matched}\` refers to ${change.key}, which was renamed to \`${change.after?.name}\`.`
            : `\`${matched}\` refers to ${change.key}, which was removed.`,
        file: pagePathOf(input.docsRoot, ref.pagePath),
        line: ref.line,
        entityKey: change.key,
        evidence: { change: describeChange(change), referenceKind: ref.kind, confidence: ref.confidence, renamedTo: change.renamedTo },
        suggestion,
        fingerprint: findingFingerprint(["drift/stale-reference", ref.pagePath, ref.line, change.key]),
      });
    }
  }

  // drift/stale-value: an old literal value still appears next to a reference.
  for (const change of input.changes) {
    if (change.type !== "modified") continue;
    const literalDeltas = change.deltas.filter((d) => LITERAL_LEAVES.has(d.path.split(".").pop() ?? ""));
    if (literalDeltas.length === 0) continue;
    for (const ref of usable(input.baseRefs, change.key)) {
      const page = pageByPath.get(ref.pagePath);
      if (!page || !ref.line) continue;
      const block = blockTextAt(page, ref.line);
      for (const delta of literalDeltas) {
        const stale: string[] = Array.isArray(delta.before)
          ? delta.before.filter((v) => !(Array.isArray(delta.after) && delta.after.includes(v))).map(String)
          : delta.before === undefined || delta.before === null
            ? []
            : [String(delta.before)];
        for (const oldValue of stale) {
          if (!oldValue || oldValue === ref.matchedText || !literalRegExp(oldValue).test(block.text)) continue;
          const id = `${ref.pagePath}|${change.key}|${oldValue}`;
          if (staleValueSeen.has(id)) continue;
          staleValueSeen.add(id);
          const lines = page.source.split("\n");
          const lineIndex = lines.findIndex((l, i) => i >= block.startLine - 1 && i <= block.endLine - 1 && literalRegExp(oldValue).test(l));
          const line = lineIndex >= 0 ? lineIndex + 1 : ref.line;
          const newValue = Array.isArray(delta.after) ? undefined : delta.after;
          const lineText = lines[line - 1] ?? "";
          const replacement =
            newValue !== undefined && newValue !== null
              ? lineText.replace(literalRegExp(oldValue), (m, pre: string) => `${pre}${String(newValue)}${m.slice(pre.length + oldValue.length)}`)
              : undefined;
          add(input.levels.drift, {
            ruleId: "drift/stale-value",
            category: "drift",
            message: `${change.kind} ${change.after?.name ?? change.key}: ${delta.path} changed from ${formatValue(delta.before)} to ${formatValue(delta.after)}, but this ${line === ref.line ? "line" : "passage"} still says ${oldValue}.`,
            file: pagePathOf(input.docsRoot, ref.pagePath),
            line,
            entityKey: change.key,
            evidence: { path: delta.path, before: delta.before, after: delta.after, referenceLine: ref.line },
            suggestion: replacement && replacement !== lineText ? { kind: "replacement", line, replacement, original: lineText } : undefined,
            fingerprint: findingFingerprint(["drift/stale-value", ref.pagePath, change.key, delta.path, oldValue]),
          });
        }
      }
    }
  }

  // drift/changed-entity: user-visible change, referencing page untouched.
  for (const change of input.changes) {
    if (change.type !== "modified" || !change.userVisible) continue;
    const byPage = new Map<string, number | undefined>();
    for (const ref of usable(input.baseRefs, change.key)) {
      if (!byPage.has(ref.pagePath)) byPage.set(ref.pagePath, ref.line);
    }
    for (const [pagePath, line] of byPage) {
      const file = pagePathOf(input.docsRoot, pagePath);
      if (input.changedFiles.has(file)) continue;
      if ([...staleValueSeen].some((s) => s.startsWith(`${pagePath}|${change.key}|`))) continue;
      add(input.levels.changedEntity, {
        ruleId: "drift/changed-entity",
        category: "drift",
        message: `${describeChange(change)}. This page references it and was not updated in this change.`,
        file,
        line,
        entityKey: change.key,
        evidence: { deltas: change.deltas, breaking: change.breaking },
        fingerprint: findingFingerprint(["drift/changed-entity", pagePath, change.key, change.after?.fingerprint]),
      });
    }
  }

  // schema/changed-without-docs: user-visible changes, and no referencing page was updated.
  const opsUsingSchema = new Map<string, Set<string>>();
  for (const e of [...(input.baseEntities ?? []), ...(input.headEntities ?? [])]) {
    if (e.kind !== "api.operation") continue;
    for (const schemaKey of e.related ?? []) {
      const set = opsUsingSchema.get(schemaKey) ?? new Set<string>();
      set.add(e.key);
      opsUsingSchema.set(schemaKey, set);
    }
  }
  const bySource = new Map<string, EntityChange[]>();
  for (const change of input.changes) {
    if (!change.userVisible || change.type === "added") continue;
    const source = (change.before ?? change.after)?.sourceKey ?? "";
    bySource.set(source, [...(bySource.get(source) ?? []), change]);
  }
  for (const [sourceKey, changes] of bySource) {
    const pages = new Set<string>();
    for (const change of changes) {
      const entity = change.before ?? change.after;
      const keys = new Set([change.key, change.renamedTo, entity?.parentKey].filter((k): k is string => Boolean(k)));
      // Pages about an operation describe its request/response schemas and their properties.
      for (const schemaKey of [change.key, entity?.parentKey]) {
        for (const opKey of opsUsingSchema.get(schemaKey ?? "") ?? []) keys.add(opKey);
      }
      for (const key of keys) {
        for (const ref of [...usable(input.baseRefs, key), ...usable(input.headRefs, key)]) pages.add(ref.pagePath);
      }
    }
    if (pages.size === 0) continue;
    const touched = [...pages].filter((p) => input.changedFiles.has(pagePathOf(input.docsRoot, p)));
    if (touched.length > 0) continue;
    const first = changes[0]?.after ?? changes[0]?.before;
    const sourcePath = input.sourcePaths.get(sourceKey) ?? first?.location?.file;
    const summary = changes.slice(0, 3).map(describeChange).join("; ");
    const waived = Boolean(input.waived);
    const severity = waived ? "info" : levelToSeverity(input.levels.schemaChange);
    if (!severity) continue;
    findings.push({
      ruleId: "schema/changed-without-docs",
      category: "schema",
      severity,
      origin: "deterministic",
      message: `${changes.length} user-visible change(s) in ${sourcePath} (${summary}${changes.length > 3 ? "; …" : ""}); none of the ${pages.size} page(s) that reference them were updated: ${[...pages].sort().join(", ")}${waived ? " (waived by label)" : ""}`,
      file: sourcePath,
      line: first?.location?.line,
      entityKey: changes[0]?.key,
      evidence: { changes: changes.map((c) => ({ key: c.key, type: c.type, breaking: c.breaking })), pages: [...pages].sort(), waived },
      fingerprint: findingFingerprint(["schema/changed-without-docs", sourceKey, changes.map((c) => c.key).sort().join(",")]),
    });
  }

  // coverage/undocumented-entity: new public entities with no docs.
  for (const change of input.changes) {
    if (change.type !== "added" || !change.after) continue;
    const e = change.after;
    if (!input.coverageKinds.includes(e.kind)) continue;
    if (e.visibility === "internal" || (e.visibility === "deprecated" && !input.includeDeprecated)) continue;
    if (usable(input.headRefs, e.key).length > 0) continue;
    add(input.levels.newEntities, {
      ruleId: "coverage/undocumented-entity",
      category: "coverage",
      message: `New public ${e.kind} ${e.kind === "api.operation" ? String(e.attributes.method) + " " + String(e.attributes.path) : e.name} is not referenced by any page.`,
      file: e.location?.file ?? input.sourcePaths.get(e.sourceKey),
      line: e.location?.line,
      entityKey: e.key,
      evidence: { kind: e.kind, visibility: e.visibility },
      fingerprint: findingFingerprint(["coverage/undocumented-entity", e.key]),
    });
  }

  return findings;
}
