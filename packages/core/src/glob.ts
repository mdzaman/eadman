/**
 * Minimal, dependency-free glob matching for config include/exclude, ownership
 * rules and CODEOWNERS: `**` (any path segments), `*` (within a segment), `?`,
 * `{a,b}` alternation and character classes `[...]`.
 */
const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;
  let re = "";
  let i = 0;
  let inGroup = false;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const atSegmentStart = i === 0 || pattern[i - 1] === "/";
        const followedBySlash = pattern[i + 2] === "/";
        if (atSegmentStart && followedBySlash) {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      inGroup = true;
      re += "(?:";
    } else if (c === "}" && inGroup) {
      inGroup = false;
      re += ")";
    } else if (c === "," && inGroup) {
      re += "|";
    } else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end > i) {
        re += `[${pattern.slice(i + 1, end).replace(/\\/g, "\\\\")}]`;
        i = end;
      } else {
        re += "\\[";
      }
    } else if (/[.+^$()|\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
    i++;
  }
  const compiled = new RegExp(`^${re}$`);
  cache.set(pattern, compiled);
  return compiled;
}

export function matchesGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesGlob(path, p));
}
