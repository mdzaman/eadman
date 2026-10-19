import { dirname, join, normalize } from "node:path/posix";
import { findingFingerprint, levelToSeverity, type Finding, type Level, type Severity } from "@docops/core";
import { frontmatterList, type ParsedPage } from "@docops/markdown";

export interface PageRuleContext {
  /** Repository-relative docs root ("docs"). */
  docsRoot: string;
  pagesByPath: ReadonlyMap<string, ParsedPage>;
  /** Does a non-page file (image, asset) exist? Path is relative to the docs root. */
  assetExists: (docsRelativePath: string) => boolean;
}

export type RuleEmitter = (level: Level, f: Omit<Finding, "severity" | "origin" | "fingerprint"> & { fingerprintParts?: Array<string | number | undefined> }) => void;

export function createEmitter(out: Finding[]): RuleEmitter {
  return (level, { fingerprintParts, ...f }) => {
    const severity: Severity | null = levelToSeverity(level);
    if (!severity) return;
    out.push({ ...f, severity, origin: "deterministic", fingerprint: findingFingerprint(fingerprintParts ?? [f.ruleId, f.file, f.line, f.message]) });
  };
}

export function repoPath(docsRoot: string, pagePath: string): string {
  return docsRoot && docsRoot !== "." ? `${docsRoot.replace(/\/$/, "")}/${pagePath}` : pagePath;
}

/** links/broken-internal and links/broken-anchor (GitHub-compatible anchors). */
export function checkInternalLinks(page: ParsedPage, ctx: PageRuleContext, level: Level, emit: RuleEmitter): void {
  for (const link of page.links) {
    if (link.kind !== "internal" && link.kind !== "anchor") continue;
    const [rawPath = "", rawAnchor] = link.url.split("#");
    const anchor = rawAnchor ? decodeURIComponent(rawAnchor) : undefined;
    let target: ParsedPage | undefined = page;
    let targetPath = page.path;
    if (link.kind === "internal" && rawPath) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(rawPath.split("?")[0] ?? rawPath);
      } catch {
        decoded = rawPath;
      }
      targetPath = decoded.startsWith("/") ? normalize(decoded.slice(1)) : normalize(join(dirname(page.path), decoded));
      const candidates = [targetPath, `${targetPath}.md`, `${targetPath}.mdx`, `${targetPath.replace(/\/$/, "")}/index.md`, join(targetPath, "README.md")];
      target = candidates.map((c) => ctx.pagesByPath.get(c)).find(Boolean);
      if (!target) {
        if (/\.(md|mdx)$/.test(targetPath) || !ctx.assetExists(targetPath)) {
          emit(level, {
            ruleId: "links/broken-internal",
            category: "links",
            message: `${link.isImage ? "Image" : "Link"} target \`${link.url}\` does not exist (resolved to ${repoPath(ctx.docsRoot, targetPath)}).`,
            file: repoPath(ctx.docsRoot, page.path),
            line: link.line,
            evidence: { url: link.url, resolved: targetPath },
            fingerprintParts: ["links/broken-internal", page.path, link.url],
          });
        }
        continue;
      }
    }
    if (anchor && target && !target.anchors.has(anchor)) {
      const suggestions = [...target.anchors].filter((a) => a.includes(anchor) || anchor.includes(a)).slice(0, 3);
      emit(level, {
        ruleId: "links/broken-anchor",
        category: "links",
        message: `Anchor \`#${anchor}\` does not exist in ${repoPath(ctx.docsRoot, target.path)}${suggestions.length ? ` (did you mean ${suggestions.map((s) => `#${s}`).join(", ")}?)` : ""}.`,
        file: repoPath(ctx.docsRoot, page.path),
        line: link.line,
        evidence: { url: link.url, anchors: [...target.anchors].slice(0, 50) },
        fingerprintParts: ["links/broken-anchor", page.path, link.url],
      });
    }
  }
}

/** frontmatter/missing-field, frontmatter/invalid. */
export function checkFrontmatter(page: ParsedPage, docsRoot: string, required: readonly string[], level: Level, emit: RuleEmitter): void {
  const file = repoPath(docsRoot, page.path);
  if (page.frontmatterError) {
    emit(level, { ruleId: "frontmatter/invalid", category: "frontmatter", message: `Frontmatter is not valid YAML: ${page.frontmatterError}`, file, line: 1, evidence: {} });
    return;
  }
  for (const field of required) {
    const value = page.frontmatter[field];
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
      emit(level, {
        ruleId: "frontmatter/missing-field",
        category: "frontmatter",
        message: `Required frontmatter field \`${field}\` is missing.`,
        file,
        line: 1,
        evidence: { field },
        fingerprintParts: ["frontmatter/missing-field", page.path, field],
      });
    }
  }
  for (const ticket of frontmatterList(page, "tickets")) {
    if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(ticket)) {
      emit(level, { ruleId: "frontmatter/invalid", category: "frontmatter", message: `\`${ticket}\` is not a valid ticket key (expected e.g. PAY-123).`, file, line: 1, evidence: { ticket } });
    }
  }
}

const INCLUSIVE: Array<{ term: RegExp; suggest: string }> = [
  { term: /\bwhitelist(s|ed|ing)?\b/gi, suggest: "allowlist" },
  { term: /\bblacklist(s|ed|ing)?\b/gi, suggest: "denylist" },
  { term: /\bmaster\b(?=\s+(node|server|branch|database|db|replica))/gi, suggest: "primary / main" },
  { term: /\bslaves?\b/gi, suggest: "replica" },
  { term: /\bsanity[ -]check(s)?\b/gi, suggest: "confidence check" },
  { term: /\bdummy\s+(value|data|variable)/gi, suggest: "placeholder" },
  { term: /\bman[ -]hours?\b/gi, suggest: "person-hours" },
  { term: /\bgrandfathered\b/gi, suggest: "legacy / exempt" },
];

const NON_DESCRIPTIVE = /^(click here|here|this|link|read more|more|this link|learn more)$/i;

/** style/inclusive-language, style/non-descriptive-link-text. */
export function checkStyle(page: ParsedPage, docsRoot: string, levels: { inclusive: Level; linkText: Level }, emit: RuleEmitter): void {
  const file = repoPath(docsRoot, page.path);
  for (const block of page.textBlocks) {
    for (const rule of INCLUSIVE) {
      for (const match of block.text.matchAll(rule.term)) {
        emit(levels.inclusive, {
          ruleId: "style/inclusive-language",
          category: "style",
          message: `Consider replacing "${match[0]}" with "${rule.suggest}".`,
          file,
          line: block.line,
          evidence: { term: match[0], suggestion: rule.suggest },
          fingerprintParts: ["style/inclusive-language", page.path, block.line, match[0].toLowerCase()],
        });
      }
    }
  }
  for (const link of page.links) {
    if (!link.isImage && NON_DESCRIPTIVE.test(link.text.trim())) {
      emit(levels.linkText, {
        ruleId: "style/non-descriptive-link-text",
        category: "style",
        message: `Link text "${link.text}" does not describe its destination (WCAG 2.4.4).`,
        file,
        line: link.line,
        evidence: { url: link.url },
        fingerprintParts: ["style/non-descriptive-link-text", page.path, link.url],
      });
    }
  }
}

/** a11y/img-alt, a11y/heading-order (source-level; rendered-output checks run in the renderer). */
export function checkA11y(page: ParsedPage, docsRoot: string, level: Level, emit: RuleEmitter): void {
  const file = repoPath(docsRoot, page.path);
  for (const link of page.links) {
    if (link.isImage && !link.text.trim()) {
      emit(level, { ruleId: "a11y/img-alt", category: "a11y", message: `Image \`${link.url}\` has no alternative text.`, file, line: link.line, evidence: { url: link.url } });
    }
  }
  const h1s = page.headings.filter((h) => h.depth === 1);
  if (h1s.length > 1) {
    emit(level, { ruleId: "a11y/heading-order", category: "a11y", message: `Page has ${h1s.length} level-1 headings; use one.`, file, line: h1s[1]?.line, evidence: {} });
  }
  let previous = 0;
  for (const h of page.headings) {
    if (previous > 0 && h.depth > previous + 1) {
      emit(level, {
        ruleId: "a11y/heading-order",
        category: "a11y",
        message: `Heading level jumps from h${previous} to h${h.depth} ("${h.text}").`,
        file,
        line: h.line,
        evidence: { from: previous, to: h.depth },
      });
    }
    previous = h.depth;
  }
}

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "AWS access key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { name: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: "Stripe live key", re: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "DocOps API token", re: /\bdop_[A-Za-z0-9]{24,}\b/g },
  { name: "Private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/g },
];

/** secrets/detected: high-confidence patterns only; the secret itself is never echoed. */
export function checkSecrets(page: ParsedPage, docsRoot: string, level: Level, emit: RuleEmitter): void {
  const file = repoPath(docsRoot, page.path);
  page.source.split("\n").forEach((text, i) => {
    for (const pattern of SECRET_PATTERNS) {
      for (const match of text.matchAll(pattern.re)) {
        emit(level, {
          ruleId: "secrets/detected",
          category: "secrets",
          message: `Possible ${pattern.name} (${match[0].slice(0, 4)}…redacted). Remove it and rotate the credential.`,
          file,
          line: i + 1,
          evidence: { type: pattern.name },
          fingerprintParts: ["secrets/detected", page.path, i + 1, pattern.name],
        });
      }
    }
  });
}

/** freshness/overdue-review: frontmatter `reviewed:` older than the SLA for the page type. */
export function checkFreshness(
  page: ParsedPage,
  docsRoot: string,
  sla: { defaultDays: number; byPageType: Record<string, number>; overrideDays?: number | undefined },
  now: Date,
  level: Level,
  emit: RuleEmitter,
): void {
  if (page.pageType === "adr" || page.pageType === "release_notes" || page.pageType === "postmortem") return; // point-in-time records
  const raw = page.frontmatter.reviewed;
  const reviewed = raw instanceof Date ? raw : typeof raw === "string" ? new Date(raw) : undefined;
  if (!reviewed || Number.isNaN(reviewed.getTime())) return;
  const pageSla = typeof page.frontmatter.sla_days === "number" ? page.frontmatter.sla_days : undefined;
  const days = pageSla ?? sla.overrideDays ?? sla.byPageType[page.pageType] ?? sla.defaultDays;
  const age = Math.floor((now.getTime() - reviewed.getTime()) / 86_400_000);
  if (age > days) {
    emit(level, {
      ruleId: "freshness/overdue-review",
      category: "freshness",
      message: `Last reviewed ${age} days ago (${reviewed.toISOString().slice(0, 10)}); the SLA for ${page.pageType} pages is ${days} days.`,
      file: repoPath(docsRoot, page.path),
      line: 1,
      evidence: { reviewed: reviewed.toISOString().slice(0, 10), ageDays: age, slaDays: days },
      fingerprintParts: ["freshness/overdue-review", page.path, reviewed.toISOString().slice(0, 10)],
    });
  }
}
