import { matchesGlob } from "@docops/core";

export interface CodeownersRule {
  pattern: string;
  owners: string[];
  line: number;
}

/** Parse a CODEOWNERS file (GitHub syntax). */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) return;
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern) rules.push({ pattern, owners, line: i + 1 });
  });
  return rules;
}

function toGlob(pattern: string): string {
  let p = pattern;
  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);
  if (p.endsWith("/")) p = `${p}**`;
  else if (!p.includes("*") && !p.includes(".")) p = `${p}{,/**}`;
  if (!anchored && !p.slice(0, -1).includes("/")) p = `**/${p}`;
  return p;
}

/** Owners for a repository-relative path; the last matching rule wins (GitHub semantics). */
export function ownersFor(rules: readonly CodeownersRule[], path: string): string[] {
  let owners: string[] = [];
  for (const rule of rules) if (matchesGlob(path, toGlob(rule.pattern))) owners = rule.owners;
  return owners;
}
