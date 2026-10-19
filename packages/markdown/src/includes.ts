import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Include directives keep a code block in a Markdown page byte-identical to a source file:
 *
 *   <!-- docops:include path="../api/openapi.yaml" lang="yaml" -->
 *   ```yaml
 *   ...generated...
 *   ```
 *   <!-- docops:end-include -->
 *
 * Paths are resolved relative to the page. `syncIncludes` rewrites the block;
 * `checkIncludes` reports blocks that are out of date (used by `docops check`).
 */
const INCLUDE_RE =
  /<!-- docops:include path="([^"]+)"(?: lang="([^"]*)")? -->\n([\s\S]*?)<!-- docops:end-include -->/g;

export interface IncludeResult {
  path: string;
  line: number;
  upToDate: boolean;
}

export interface IncludeSyncOutput {
  content: string;
  includes: IncludeResult[];
}

function fenceFor(body: string): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
}

function renderBlock(body: string, lang: string): string {
  const text = body.endsWith("\n") ? body : `${body}\n`;
  const fence = fenceFor(text);
  return `${fence}${lang}\n${text}${fence}\n`;
}

export async function syncIncludes(
  pagePath: string,
  content: string,
  read: (absPath: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<IncludeSyncOutput> {
  const includes: IncludeResult[] = [];
  let output = "";
  let cursor = 0;
  for (const match of content.matchAll(INCLUDE_RE)) {
    const [whole, relPath = "", lang = "", current = ""] = match;
    const start = match.index ?? 0;
    const line = content.slice(0, start).split("\n").length;
    const body = await read(resolve(dirname(pagePath), relPath));
    const block = renderBlock(body, lang);
    includes.push({ path: relPath, line, upToDate: current === block });
    output += content.slice(cursor, start);
    output += `<!-- docops:include path="${relPath}"${lang ? ` lang="${lang}"` : ""} -->\n${block}<!-- docops:end-include -->`;
    cursor = start + whole.length;
  }
  output += content.slice(cursor);
  return { content: output, includes };
}
