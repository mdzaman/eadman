import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { matchesAny, type PageType } from "@docops/core";
import { parseMarkdown, type ParsedPage } from "./parse.ts";

export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** Recursively list files under `root` (relative POSIX paths) filtered by globs. */
export async function listFiles(root: string, include: readonly string[], exclude: readonly string[] = []): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const rel = toPosix(relative(root, full));
        if (matchesAny(rel, include) && !matchesAny(rel, exclude)) out.push(rel);
      }
    }
  }
  await walk(root);
  return out.sort();
}

export interface LoadPagesOptions {
  include: readonly string[];
  exclude: readonly string[];
  snippetsDir: string;
  defaultPageType: PageType;
}

export interface LoadedPages {
  pages: ParsedPage[];
  /** Snippets keyed by name (file path under the snippets dir, without extension). */
  snippets: Map<string, ParsedPage>;
}

/** Load and parse every page (and snippet) under a docs root. */
export async function loadPages(docsRoot: string, options: LoadPagesOptions): Promise<LoadedPages> {
  const files = await listFiles(docsRoot, options.include, options.exclude);
  const snippetPrefix = `${options.snippetsDir.replace(/\/$/, "")}/`;
  const pages: ParsedPage[] = [];
  const snippets = new Map<string, ParsedPage>();
  for (const file of files) {
    const source = await readFile(join(docsRoot, file), "utf8");
    const parsed = parseMarkdown(file, source, { defaultPageType: options.defaultPageType });
    if (file.startsWith(snippetPrefix)) {
      snippets.set(file.slice(snippetPrefix.length).replace(/\.mdx?$/, ""), { ...parsed, pageType: "snippet" });
    } else {
      pages.push(parsed);
    }
  }
  return { pages, snippets };
}
