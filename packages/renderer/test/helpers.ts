import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadPages, parseMarkdown, type ParsedPage } from "@docops/markdown";
import type { BuildResult, RenderSiteInput } from "../src/index.ts";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const acmeRoot = join(repoRoot, "examples/acme-payments");

interface AcmeConfig {
  project: { id: string; name: string };
  docs: { root: string; snippets: string };
  sources: Array<{ id: string; type: string; path: string; reference?: { outDir?: string; title?: string } }>;
  publish: { baseUrl: string };
  site: { title: string; editUrl: string; theme: { primaryColor: string } };
  variables: Record<string, string>;
}

export async function acmeConfig(): Promise<AcmeConfig> {
  return parseYaml(await readFile(join(acmeRoot, "docops.yaml"), "utf8")) as AcmeConfig;
}

/** The acme-payments example wired exactly as the CLI would. */
export async function acmeInput(overrides: Partial<RenderSiteInput> = {}): Promise<RenderSiteInput> {
  const config = await acmeConfig();
  const { pages, snippets } = await loadPages(join(acmeRoot, config.docs.root), {
    include: ["**/*.md", "**/*.mdx"],
    exclude: [],
    snippetsDir: "_snippets",
    defaultPageType: "guide",
  });
  const api = config.sources.find((s) => s.type === "openapi");
  assert.ok(api, "acme example has an OpenAPI source");
  return {
    site: {
      title: config.site.title,
      lang: "en",
      primaryColor: config.site.theme.primaryColor,
      editUrl: config.site.editUrl,
      baseUrl: config.publish.baseUrl,
    },
    project: config.project,
    docsRoot: config.docs.root,
    pages,
    snippets,
    variables: config.variables,
    openapi: [
      {
        sourceId: api.id,
        title: api.reference?.title ?? api.id,
        outDir: api.reference?.outDir ?? `reference/${api.id}`,
        content: await readFile(join(acmeRoot, api.path), "utf8"),
      },
    ],
    version: { name: "2.4", available: [{ name: "2.4", url: "/" }, { name: "2.3", url: "/2.3/" }] },
    basePath: "/",
    ...overrides,
  };
}

/** A small site from in-memory pages. */
export function siteInput(pages: ParsedPage[], overrides: Partial<RenderSiteInput> = {}): RenderSiteInput {
  return {
    site: { title: "Test Docs", lang: "en" },
    project: { id: "test", name: "Test" },
    docsRoot: "docs",
    pages,
    snippets: new Map(),
    variables: {},
    openapi: [],
    version: { name: "1.0", available: [] },
    basePath: "/",
    ...overrides,
  };
}

export function page(path: string, source: string): ParsedPage {
  return parseMarkdown(path, source);
}

export function fileText(result: BuildResult, path: string): string {
  const file = result.files.find((f) => f.path === path);
  assert.ok(file, `expected output file ${path}`);
  return typeof file.content === "string" ? file.content : new TextDecoder().decode(file.content);
}

export function hasFile(result: BuildResult, path: string): boolean {
  return result.files.some((f) => f.path === path);
}

/** The `<article>` element of a rendered page. */
export function articleOf(html: string): string {
  const start = html.indexOf("<article");
  const end = html.indexOf("</article>");
  assert.ok(start >= 0 && end > start, "page has an <article>");
  return html.slice(start, end + "</article>".length);
}

export interface StartTag {
  name: string;
  attributes: Map<string, string>;
}

/**
 * Start tags of serialized HTML. Exact for hast-util-to-html output: text never
 * contains a raw `<` and attribute values are always double-quoted with `"` escaped,
 * so markup-looking text inside text or attribute values is never mistaken for a tag.
 */
export function startTags(html: string): StartTag[] {
  const tags: StartTag[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const nameMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, lt + 64));
    if (!nameMatch?.[1]) {
      i = lt + 1;
      continue;
    }
    const tag: StartTag = { name: nameMatch[1].toLowerCase(), attributes: new Map() };
    let j = lt + nameMatch[0].length;
    while (j < html.length && html[j] !== ">") {
      const attr = /^\s+([^\s=>/]+)(?:="([^"]*)")?/.exec(html.slice(j, j + 4096));
      if (!attr?.[1]) {
        j += 1;
        continue;
      }
      tag.attributes.set(attr[1].toLowerCase(), attr[2] ?? "");
      j += attr[0].length;
    }
    tags.push(tag);
    i = j + 1;
  }
  return tags;
}

export function htmlFiles(result: BuildResult): Array<{ path: string; html: string }> {
  return result.files
    .filter((f) => f.path.endsWith(".html"))
    .map((f) => ({ path: f.path, html: typeof f.content === "string" ? f.content : new TextDecoder().decode(f.content) }));
}
