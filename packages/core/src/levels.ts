import type { Finding, Level, Severity } from "./types.ts";

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

export function levelToSeverity(level: Level): Severity | null {
  if (level === "off") return null;
  return level === "block" ? "error" : "warning";
}

export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

/** Does this set of findings fail the gate for `failOn`? */
export function gateBlocked(findings: readonly Finding[], failOn: "error" | "warning" | "never"): boolean {
  if (failOn === "never") return false;
  const threshold: Severity = failOn === "warning" ? "warning" : "error";
  return findings.some((f) => compareSeverity(f.severity, threshold) >= 0);
}

export function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort(
    (a, b) =>
      compareSeverity(b.severity, a.severity) ||
      (a.file ?? "").localeCompare(b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.ruleId.localeCompare(b.ruleId),
  );
}
