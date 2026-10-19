import type { Element, ElementContent, Root as HastRoot } from "hast";
import { canonicalJson, sha256Hex } from "@docops/core";
import type { ParsedPage } from "@docops/markdown";
import { auditBody, isValidLang } from "./a11y.ts";
import { DOCOPS_CSS, DOCOPS_JS } from "./assets.ts";
import type { RenderContext } from "./context.ts";
import { h, lines, toText, visitElements, type HChild } from "./hast.ts";
import { renderDocument, type SiteShell, type TocEntry } from "./layout.ts";
import { renderMarkdownTree } from "./markdown.ts";
import { buildContentNav, type NavPage } from "./nav.ts";
import { buildApiModel, buildApiNav, operationIndex, renderApiReference, type ApiModel } from "./reference.ts";
import { firstWords, plainText, summarize } from "./search.ts";
import { themeCss } from "./theme.ts";
import type {
  A11yIssue,
  BuildManifest,
  BuildResult,
  BuiltFile,
  PageMeta,
  RenderSiteInput,
  SearchEntry,
} from "./types.ts";
import { absoluteUrl, href, isExternalHref, LINK_BASE, normalizeBasePath, normalizeDir, pageOutputPath, pageUrl, rootPrefix, safeHref, withLinkBase } from "./urls.ts";
import { substituteVariables } from "./variables.ts";
import { RENDERER_VERSION } from "./version.ts";

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

function textFile(path: string, content: string): BuiltFile {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return {
    path,
    content,
    contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
    digest: sha256Hex(content),
    size: Buffer.byteLength(content, "utf8"),
  };
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
  if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  return [];
}

function dateString(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return undefined;
}

/** Ownership metadata from frontmatter (used when the caller passes no pageMeta for a page). */
function frontmatterMeta(page: ParsedPage): PageMeta {
  const reviewed = dateString(page.frontmatter.reviewed ?? page.frontmatter.last_reviewed);
  return {
    owners: stringList(page.frontmatter.owners),
    tickets: stringList(page.frontmatter.tickets).map((key) => ({ key })),
    ...(reviewed ? { reviewed } : {}),
  };
}

function navOrder(page: ParsedPage): number | undefined {
  const value = page.frontmatter.nav_order;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function displayTitle(page: ParsedPage, variables: RenderContext["variables"]): string {
  // Frontmatter is never variable-substituted; a title taken from the h1 is.
  return typeof page.frontmatter.title === "string" ? page.title : substituteVariables(page.title, variables);
}

function joinNodes(items: HChild[], separator: string): HChild[] {
  return items.flatMap((item, i) => (i === 0 ? [item] : [separator, item]));
}

function pageFooter(meta: PageMeta, editHref: string | undefined): ElementContent[] {
  const out: ElementContent[] = [];
  if (meta.stale) {
    out.push(
      h(
        "p",
        { className: ["stale-warning"], role: "note" },
        h("strong", null, "This page may be out of date."),
        " It is past its review date; check with the owners before relying on it.",
      ),
    );
  }
  const rows: Element[] = [];
  if (meta.reviewed) {
    const value = /^\d{4}-\d{2}-\d{2}/.test(meta.reviewed) ? h("time", { dateTime: meta.reviewed.slice(0, 10) }, meta.reviewed) : meta.reviewed;
    rows.push(h("div", null, h("dt", null, "Last reviewed"), h("dd", null, value)));
  }
  if (meta.owners.length > 0) rows.push(h("div", null, h("dt", null, "Owners"), h("dd", null, meta.owners.join(", "))));
  if (meta.tickets.length > 0) {
    const tickets = meta.tickets.map((ticket) => {
      const url = safeHref(ticket.url);
      return url ? h("a", { href: url, rel: isExternalHref(url) ? ["noopener", "noreferrer"] : undefined }, ticket.key) : ticket.key;
    });
    rows.push(h("div", null, h("dt", null, "Tickets"), h("dd", null, joinNodes(tickets, ", "))));
  }
  if (rows.length > 0) out.push(h("dl", { className: ["page-meta"] }, rows));
  if (editHref) {
    out.push(
      h(
        "p",
        { className: ["edit-link"] },
        h("a", { href: editHref, rel: isExternalHref(editHref) ? ["noopener", "noreferrer"] : undefined }, "Edit this page"),
      ),
    );
  }
  return out;
}

function editLink(template: string | undefined, docsRoot: string, pagePath: string): string | undefined {
  if (!template) return undefined;
  const repoPath = [docsRoot, pagePath].filter(Boolean).join("/");
  return safeHref(template.split("{path}").join(encodeURI(repoPath)));
}

function bodyContent(root: HastRoot): ElementContent[] {
  return root.children.filter((c): c is ElementContent => c.type === "element" || c.type === "text");
}

function headingEntries(body: ElementContent[]): TocEntry[] {
  const entries: TocEntry[] = [];
  visitElements({ type: "root", children: body }, (el) => {
    const match = /^h([2-6])$/.exec(el.tagName);
    if (match?.[1] && typeof el.properties.id === "string") {
      entries.push({ depth: Number(match[1]), id: el.properties.id, text: toText(el).replace(/\s+/g, " ").trim() });
    }
  });
  return entries;
}

function firstParagraph(body: ElementContent[]): string {
  let found: string | undefined;
  visitElements({ type: "root", children: body }, (el) => {
    if (found === undefined && el.tagName === "p") {
      const text = plainText(el);
      if (text) found = text;
    }
  });
  return found ?? "";
}

/** A search-index URL, relative to the site root ("guides/payments/"); the portal script resolves it. */
function siteRelative(url: string): string {
  return href(url).slice(LINK_BASE.length);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Render the static documentation portal: content pages, OpenAPI reference pages,
 * search index, assets, 404, sitemap and robots.txt, plus a deterministic manifest.
 */
export async function renderSite(input: RenderSiteInput): Promise<BuildResult> {
  const basePath = normalizeBasePath(input.basePath);
  const docsRoot = normalizeDir(input.docsRoot);
  const preview = input.preview === true;
  const variables = input.variables ?? {};
  const snippets = input.snippets ?? new Map<string, ParsedPage>();
  const version = input.version ?? { name: "", available: [] };
  const a11y: A11yIssue[] = [];

  const lang = isValidLang(input.site.lang) ? input.site.lang.trim() : "en";
  if (!isValidLang(input.site.lang)) {
    a11y.push({
      page: "*",
      rule: "a11y/html-lang",
      message: `site.lang "${input.site.lang ?? ""}" is not a valid BCP 47 language tag; pages use lang="en"`,
    });
  }

  const pages = (input.pages ?? [])
    .filter((page) => page.pageType !== "snippet")
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Links are rendered against LINK_BASE and made relative per page; `basePath` is only for absolute URLs.
  const models: ApiModel[] = (input.openapi ?? []).map((source) => buildApiModel(source, LINK_BASE));
  const ctx: RenderContext = { basePath: LINK_BASE, docsRoot, variables, snippets, operations: operationIndex(models) };

  const navPages: NavPage[] = pages.map((page) => ({
    path: page.path,
    url: pageUrl(page.path, LINK_BASE),
    title: displayTitle(page, variables),
    order: navOrder(page),
  }));
  const shell: SiteShell = {
    title: input.site.title?.trim() || input.project.name,
    lang,
    basePath: LINK_BASE,
    publicBasePath: basePath,
    preview,
    baseUrl: input.site.baseUrl,
    version,
    nav: [...buildContentNav(navPages), ...models.map(buildApiNav)],
  };

  const files: BuiltFile[] = [];
  const owners = new Map<string, string>();
  const addFile = (file: BuiltFile, source: string): void => {
    const existing = owners.get(file.path);
    if (existing !== undefined) throw new Error(`Output path collision: "${file.path}" is produced by both ${existing} and ${source}`);
    owners.set(file.path, source);
    files.push(file);
  };

  const search: SearchEntry[] = [];
  const manifestPages: BuildManifest["pages"] = [];
  const sitemapUrls: string[] = [];
  const previous = new Map((input.previousManifest?.pages ?? []).map((p) => [p.source, p.inputHash]));
  const variablesJson = canonicalJson(variables);
  let cachedPages = 0;

  // Content pages.
  for (const page of pages) {
    const url = pageUrl(page.path, LINK_BASE);
    const outPath = pageOutputPath(page.path);
    const title = displayTitle(page, variables);
    const rendered = renderMarkdownTree(page.tree, ctx, { fromPath: page.path, headings: page.headings });
    const body = bodyContent(rendered.root);
    let hasH1 = false;
    visitElements(rendered.root, (el) => {
      if (el.tagName === "h1") hasH1 = true;
    });
    if (!hasH1) body.unshift(h("h1", null, title));
    a11y.push(...auditBody({ type: "root", children: body }, page.path).map((issue) => ({ ...issue, message: withLinkBase(issue.message, basePath) })));

    const headings = headingEntries(body);
    const meta = input.pageMeta?.get(page.path) ?? frontmatterMeta(page);
    const description =
      typeof page.frontmatter.description === "string" && page.frontmatter.description.trim()
        ? page.frontmatter.description.trim()
        : summarize(firstParagraph(body));
    const html = renderDocument(shell, {
      title,
      description: description || undefined,
      url,
      body,
      toc: headings,
      footer: pageFooter(meta, editLink(input.site.editUrl, docsRoot, page.path)),
    });
    addFile(textFile(outPath, withLinkBase(html, rootPrefix(outPath))), `page "${page.path}"`);

    search.push({
      url: siteRelative(url),
      title,
      headings: headings.map((entry) => entry.text),
      text: firstWords(plainText(body)),
      version: version.name,
    });
    sitemapUrls.push(withLinkBase(url, basePath));

    const snippetSources = rendered.usedSnippets.map((name) => snippets.get(name)?.source ?? "").join("");
    const inputHash = sha256Hex(page.source + snippetSources + variablesJson + RENDERER_VERSION);
    if (previous.get(page.path) === inputHash) cachedPages += 1;
    manifestPages.push({ source: page.path, url: withLinkBase(url, basePath), inputHash, title });
  }

  // OpenAPI reference pages.
  let referencePages = 0;
  for (const model of models) {
    for (const ref of renderApiReference(model, ctx)) {
      const html = renderDocument(shell, {
        title: ref.title,
        description: ref.description,
        url: ref.url,
        body: lines(ref.body),
        toc: ref.toc,
        footer: ref.footer,
        articleId: ref.articleId,
        articleClass: ["api-reference", `api-page-${ref.kind}`],
      });
      addFile(textFile(ref.outPath, withLinkBase(html, rootPrefix(ref.outPath))), `OpenAPI source "${model.sourceId}"`);
      search.push({ url: siteRelative(ref.url), title: ref.title, headings: ref.search.headings, text: ref.search.text, version: version.name });
      sitemapUrls.push(withLinkBase(ref.url, basePath));
      referencePages += 1;
    }
  }

  // 404 page. A CDN serves it at any depth, so its links use the public base path, not a relative prefix.
  const notFound = renderDocument(shell, {
    title: "Page not found",
    url: `${LINK_BASE}404.html`,
    noindex: true,
    body: [
      h("h1", null, "Page not found"),
      h("p", null, "The page you are looking for does not exist or has moved."),
      h("p", null, h("a", { href: href(LINK_BASE) }, "Go to the documentation home page"), " or use the search box."),
    ],
  });
  addFile(textFile("404.html", withLinkBase(notFound, basePath)), "the renderer");

  // Search index, assets, sitemap and robots.txt.
  addFile(textFile("search-index.json", `${JSON.stringify(search)}\n`), "the renderer");
  addFile(textFile("assets/docops.css", DOCOPS_CSS), "the renderer");
  addFile(textFile("assets/theme.css", themeCss(input.site.primaryColor)), "the renderer");
  addFile(textFile("assets/docops.js", DOCOPS_JS), "the renderer");

  const baseUrl = input.site.baseUrl?.trim();
  let sitemapUrl: string | undefined;
  if (baseUrl && !preview && absoluteUrl(basePath, baseUrl)) {
    const locs = sitemapUrls.map((url) => absoluteUrl(url, baseUrl)).filter((u): u is string => u !== undefined);
    const xml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
      ...[...new Set(locs)].sort().map((loc) => `  <url><loc>${xmlEscape(loc)}</loc></url>`),
      `</urlset>`,
      "",
    ].join("\n");
    addFile(textFile("sitemap.xml", xml), "the renderer");
    sitemapUrl = absoluteUrl(`${basePath}sitemap.xml`, baseUrl);
  }
  const robots = preview
    ? "User-agent: *\nDisallow: /\n"
    : `User-agent: *\nAllow: /\n${sitemapUrl ? `\nSitemap: ${sitemapUrl}\n` : ""}`;
  addFile(textFile("robots.txt", robots), "the renderer");

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  manifestPages.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  const manifest: BuildManifest = {
    schema: "docops.build.v1",
    rendererVersion: RENDERER_VERSION,
    files: files.map((f) => ({ path: f.path, digest: f.digest, size: f.size, contentType: f.contentType })),
    pages: manifestPages,
  };
  return {
    files,
    manifest,
    a11y,
    stats: {
      pages: pages.length,
      referencePages,
      cachedPages,
      files: files.length,
      bytes: files.reduce((sum, f) => sum + f.size, 0),
    },
  };
}

