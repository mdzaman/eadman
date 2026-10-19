import type { CheckReport, Finding } from "@docops/core";

export type ReportFormat = "text" | "json" | "sarif" | "markdown" | "junit" | "codequality" | "github";
export const REPORT_FORMATS: readonly ReportFormat[] = ["text", "json", "sarif", "markdown", "junit", "codequality", "github"];

export const STICKY_MARKER = "<!-- docops:comment:v1 -->";
const RULE_HELP = "https://docs.docops.example/rules/";

const RULE_TITLES: Record<string, string> = {
  "links/broken-internal": "Internal link target does not exist",
  "links/broken-anchor": "Link anchor does not exist",
  "links/broken-external": "External link is broken",
  "coverage/undocumented-entity": "New public entity has no documentation",
  "coverage/below-threshold": "Documentation coverage below minimum",
  "schema/changed-without-docs": "Schema changed without a documentation update",
  "drift/stale-reference": "Docs reference a removed or renamed entity",
  "drift/stale-value": "Docs state an outdated value",
  "drift/changed-entity": "Referenced entity changed; page not updated",
  "drift/semantic": "Statement contradicted by the change (AI)",
  "doctest/failed": "Code sample failed",
  "style/inclusive-language": "Non-inclusive language",
  "style/non-descriptive-link-text": "Non-descriptive link text",
  "a11y/img-alt": "Image without alternative text",
  "a11y/heading-order": "Heading levels out of order",
  "frontmatter/missing-field": "Required frontmatter field missing",
  "frontmatter/invalid": "Invalid frontmatter",
  "freshness/overdue-review": "Page overdue for review",
  "ownership/missing-owner": "Page has no owner",
  "secrets/detected": "Possible secret in documentation",
  "includes/out-of-date": "Included source is out of date",
  "config/invalid-source": "Reference source could not be extracted",
};

export function ruleTitle(ruleId: string): string {
  return RULE_TITLES[ruleId] ?? ruleId;
}

function location(f: Finding): string {
  return f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "(project)";
}

// ---------------------------------------------------------------------------- text

const ANSI = { red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", reset: "\x1b[0m" };

export function formatText(report: CheckReport, options: { color?: boolean } = {}): string {
  const c = (code: keyof typeof ANSI, s: string) => (options.color ? `${ANSI[code]}${s}${ANSI.reset}` : s);
  const lines: string[] = [];
  lines.push(
    `DocOps ${report.tool.version} · ${report.project.id} · ${report.stats.pages} pages · ${report.stats.entities} entities · ${report.stats.references} references`,
  );
  if (report.base) {
    const counts = new Map<string, number>();
    for (const ch of report.changes) counts.set(ch.type, (counts.get(ch.type) ?? 0) + 1);
    lines.push(
      `Base ${report.base.ref}${report.base.sha ? ` (${report.base.sha.slice(0, 7)})` : ""} → ${report.head.ref}: ${[...counts]
        .map(([t, n]) => `${n} ${t}`)
        .join(", ") || "no entity changes"}`,
    );
  }
  lines.push("");
  for (const f of report.findings) {
    const icon = f.severity === "error" ? c("red", "✖") : f.severity === "warning" ? c("yellow", "⚠") : c("cyan", "ℹ");
    lines.push(`${icon} ${c("bold", f.ruleId)}  ${c("dim", location(f))}${f.origin === "ai" ? c("cyan", "  [AI]") : ""}`);
    lines.push(`    ${f.message}`);
    if (f.suggestion?.replacement !== undefined) lines.push(`    ${c("green", "suggestion:")} ${f.suggestion.replacement.trim()}`);
  }
  if (report.findings.length > 0) lines.push("");
  const cov = report.summary.coverage;
  if (cov?.percentL2 !== undefined) lines.push(`Coverage (L2): ${cov.percentL2}%${cov.percentL1 !== undefined ? ` · L1: ${cov.percentL1}%` : ""}`);
  const { error, warning, info } = report.summary.counts;
  const gate = report.summary.gate.blocked ? c("red", "FAILED") : c("green", "PASSED");
  lines.push(`${error} error${error === 1 ? "" : "s"} · ${warning} warning${warning === 1 ? "" : "s"} · ${info} info · gate: ${gate} · ${report.stats.durationMs} ms`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------- SARIF 2.1.0

export function formatSarif(report: CheckReport): string {
  const ruleIds = [...new Set(report.findings.map((f) => f.ruleId))].sort();
  const level = (s: Finding["severity"]) => (s === "error" ? "error" : s === "warning" ? "warning" : "note");
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "DocOps",
            version: report.tool.version,
            informationUri: "https://docs.docops.example",
            rules: ruleIds.map((id) => ({
              id,
              name: id.replace(/[/-](\w)/g, (_m, ch: string) => ch.toUpperCase()),
              shortDescription: { text: ruleTitle(id) },
              helpUri: `${RULE_HELP}${id}`,
            })),
          },
        },
        results: report.findings.map((f) => ({
          ruleId: f.ruleId,
          ruleIndex: ruleIds.indexOf(f.ruleId),
          level: level(f.severity),
          message: { text: f.message },
          locations: f.file
            ? [{ physicalLocation: { artifactLocation: { uri: f.file }, ...(f.line ? { region: { startLine: f.line, ...(f.endLine ? { endLine: f.endLine } : {}) } } : {}) } }]
            : [],
          partialFingerprints: { "docops/v1": f.fingerprint },
          properties: { origin: f.origin, category: f.category, ...(f.entityKey ? { entityKey: f.entityKey } : {}) },
        })),
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}

// ---------------------------------------------------------------------------- GitLab Code Quality

export function formatCodeQuality(report: CheckReport): string {
  const severity = (s: Finding["severity"]) => (s === "error" ? "major" : s === "warning" ? "minor" : "info");
  return `${JSON.stringify(
    report.findings.map((f) => ({
      description: `${f.ruleId}: ${f.message}`,
      check_name: f.ruleId,
      fingerprint: f.fingerprint,
      severity: severity(f.severity),
      location: { path: f.file ?? "docops.yaml", lines: { begin: f.line ?? 1 } },
    })),
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------------------- JUnit

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatJunit(report: CheckReport): string {
  const groups = new Map<string, Finding[]>();
  for (const f of report.findings) groups.set(f.category, [...(groups.get(f.category) ?? []), f]);
  const suites = [...groups].map(([category, findings]) => {
    const failures = findings.filter((f) => f.severity === "error").length;
    const cases = findings.map((f) => {
      const name = xml(`${f.ruleId} ${location(f)}`);
      return f.severity === "error"
        ? `    <testcase classname="docops.${xml(category)}" name="${name}"><failure message="${xml(f.message)}" type="${f.ruleId}">${xml(f.message)}</failure></testcase>`
        : `    <testcase classname="docops.${xml(category)}" name="${name}"><system-out>${xml(`${f.severity}: ${f.message}`)}</system-out></testcase>`;
    });
    return `  <testsuite name="docops.${xml(category)}" tests="${findings.length}" failures="${failures}">\n${cases.join("\n")}\n  </testsuite>`;
  });
  if (suites.length === 0) suites.push('  <testsuite name="docops" tests="1" failures="0">\n    <testcase classname="docops" name="all quality gates passed"/>\n  </testsuite>');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="docops" tests="${Math.max(1, report.findings.length)}" failures="${report.summary.counts.error}">\n${suites.join("\n")}\n</testsuites>\n`;
}

// ---------------------------------------------------------------------------- GitHub workflow commands

function ghEscapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function ghEscapeProperty(s: string): string {
  return ghEscapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export function formatGithubCommands(report: CheckReport): string {
  return report.findings
    .map((f) => {
      const cmd = f.severity === "error" ? "error" : f.severity === "warning" ? "warning" : "notice";
      const props = [f.file ? `file=${ghEscapeProperty(f.file)}` : "", f.line ? `line=${f.line}` : "", `title=${ghEscapeProperty(f.ruleId)}`].filter(Boolean).join(",");
      return `::${cmd} ${props}::${ghEscapeData(f.message)}`;
    })
    .join("\n")
    .concat(report.findings.length ? "\n" : "");
}

// ---------------------------------------------------------------------------- Markdown (PR comment)

export interface MarkdownOptions {
  previewUrl?: string | undefined;
  /** Prefix for file links, e.g. https://github.com/acme/payments/blob/<sha>/ */
  fileUrlPrefix?: string | undefined;
  maxLength?: number | undefined;
}

export function formatMarkdown(report: CheckReport, options: MarkdownOptions = {}): string {
  const { error, warning, info } = report.summary.counts;
  const status = report.summary.gate.blocked ? "❌ **Docs gate failed**" : warning > 0 ? "⚠️ **Docs gate passed with warnings**" : "✅ **Docs gate passed**";
  const link = (f: Finding) => {
    const loc = location(f);
    return options.fileUrlPrefix && f.file ? `[\`${loc}\`](${options.fileUrlPrefix}${f.file}${f.line ? `#L${f.line}` : ""})` : `\`${loc}\``;
  };
  const out: string[] = [STICKY_MARKER, `### DocOps · ${report.project.id}`, "", status, ""];
  out.push("| Errors | Warnings | Info | Coverage (L2) | Entity changes |", "|---:|---:|---:|---:|---:|");
  out.push(`| ${error} | ${warning} | ${info} | ${report.summary.coverage?.percentL2 ?? "—"}% | ${report.changes.length} |`, "");
  if (options.previewUrl) out.push(`🔎 **Preview:** ${options.previewUrl}`, "");
  for (const severity of ["error", "warning", "info"] as const) {
    const items = report.findings.filter((f) => f.severity === severity);
    if (items.length === 0) continue;
    const heading = severity === "error" ? "Blocking" : severity === "warning" ? "Warnings" : "Info";
    out.push(severity === "error" ? `#### ${heading} (${items.length})` : `<details><summary>${heading} (${items.length})</summary>\n`);
    for (const f of items) {
      out.push(`- **${f.ruleId}** ${link(f)}${f.origin === "ai" ? " _(AI, advisory)_" : ""}  \n  ${f.message.replace(/\n/g, " ")}`);
      if (f.suggestion?.replacement !== undefined) {
        out.push("", "  ```diff", ...(f.suggestion.original !== undefined ? [`  - ${f.suggestion.original}`] : []), `  + ${f.suggestion.replacement}`, "  ```");
      }
    }
    out.push(severity === "error" ? "" : "\n</details>\n");
  }
  if (report.changes.length > 0) {
    out.push("<details><summary>Entity changes in this PR</summary>\n");
    for (const ch of report.changes.slice(0, 50)) {
      out.push(`- \`${ch.type}\` ${ch.entityKey}${ch.to ? ` → ${ch.to}` : ""}${ch.breaking ? " **(breaking)**" : ""}`);
    }
    out.push("\n</details>\n");
  }
  out.push(`<sub>Dismiss a finding with a reason in DocOps, or add \`<!-- docops-ignore <rule> -->\` above the block. Rules: ${RULE_HELP}</sub>`);
  let text = `${out.join("\n")}\n`;
  const max = options.maxLength ?? 60_000;
  if (text.length > max) text = `${text.slice(0, max - 200)}\n\n_…truncated; see the full report in the check run._\n`;
  return text;
}

export function formatReport(report: CheckReport, format: ReportFormat, options: { color?: boolean; markdown?: MarkdownOptions } = {}): string {
  switch (format) {
    case "text":
      return formatText(report, { color: options.color });
    case "json":
      return `${JSON.stringify(report, null, 2)}\n`;
    case "sarif":
      return formatSarif(report);
    case "markdown":
      return formatMarkdown(report, options.markdown);
    case "junit":
      return formatJunit(report);
    case "codequality":
      return formatCodeQuality(report);
    case "github":
      return formatGithubCommands(report);
  }
}
