import type { Element, ElementContent } from "hast";
import { toHtml } from "hast-util-to-html";
import { PORTAL_CONTENT_SECURITY_POLICY } from "@docops/core";
import { h, lines } from "./hast.ts";
import { renderNavList, type NavNode } from "./nav.ts";
import type { VersionInfo } from "./types.ts";
import { absoluteUrl, href, safeHref, withLinkBase } from "./urls.ts";
import { RENDERER_VERSION } from "./version.ts";

/** Strict CSP: no inline scripts or styles anywhere in the portal. Hosts send the same policy as a header. */
export const CONTENT_SECURITY_POLICY = PORTAL_CONTENT_SECURITY_POLICY;

export interface SiteShell {
  title: string;
  lang: string;
  /** Prefix for links inside pages: LINK_BASE, replaced per page with a relative root prefix. */
  basePath: string;
  /** Where the site is published ("/" or "/payments/2.4/"): used for canonical URLs only. */
  publicBasePath: string;
  preview: boolean;
  baseUrl?: string | undefined;
  version: VersionInfo;
  nav: NavNode[];
}

export interface TocEntry {
  depth: number;
  id: string;
  text: string;
}

export interface DocumentInput {
  title: string;
  description?: string | undefined;
  /** Raw (unencoded) URL path of the page. */
  url: string;
  body: ElementContent[];
  toc?: TocEntry[] | undefined;
  /** Children of the page `<footer>` (inside `<main>`). */
  footer?: ElementContent[] | undefined;
  articleId?: string | undefined;
  articleClass?: string[] | undefined;
  noindex?: boolean | undefined;
}

/** On-page navigation for h2/h3 headings; omitted when there are fewer than two. */
export function renderToc(entries: readonly TocEntry[]): Element | undefined {
  const items = entries.filter((e) => e.depth === 2 || e.depth === 3);
  if (items.length < 2) return undefined;
  const top: Element[] = [];
  let parent: Element | undefined;
  let sublist: Element | undefined;
  for (const entry of items) {
    const li = h("li", null, h("a", { href: `#${entry.id}` }, entry.text));
    if (entry.depth === 2 || !parent) {
      top.push(li);
      parent = li;
      sublist = undefined;
    } else {
      if (!sublist) {
        sublist = h("ul", null);
        parent.children.push(sublist);
      }
      sublist.children.push(li);
    }
  }
  return h(
    "nav",
    { className: ["toc"], ariaLabel: "On this page" },
    h("p", { className: ["toc-title"], ariaHidden: "true" }, "On this page"),
    h("ul", null, top),
  );
}

function versionSwitcher(shell: SiteShell): Element | undefined {
  const current = shell.version.name;
  if (!current && shell.version.available.length === 0) return undefined;
  const items = [...shell.version.available];
  if (current && !items.some((v) => v.name === current)) items.unshift({ name: current, url: shell.basePath });
  return h(
    "nav",
    { className: ["version-switcher"], ariaLabel: "Versions" },
    h("span", { className: ["version-label"], ariaHidden: "true" }, "Version"),
    h(
      "ul",
      null,
      items.map((v) => {
        const target = safeHref(v.url);
        const isCurrent = v.name === current;
        return h(
          "li",
          null,
          target
            ? h("a", { href: target, ariaCurrent: isCurrent ? "page" : undefined }, v.name)
            : h("span", { ariaCurrent: isCurrent ? "page" : undefined }, v.name),
        );
      }),
    ),
  );
}

function searchForm(): Element {
  return h(
    "form",
    { className: ["search"], role: "search", method: "get" },
    h("label", { htmlFor: ["docops-search-input"], className: ["search-label"] }, "Search"),
    h("input", {
      id: "docops-search-input",
      type: "search",
      name: "q",
      autoComplete: ["off"],
      spellCheck: "false",
      ariaDescribedBy: ["docops-search-status"],
      ariaControls: ["docops-search-results"],
    }),
    h("p", { id: "docops-search-status", className: ["search-status"], role: "status", ariaLive: "polite" }),
    h("ul", { id: "docops-search-results", className: ["search-results"], ariaLabel: "Search results", hidden: true }),
  );
}

function siteHeader(shell: SiteShell): Element {
  return h(
    "header",
    { className: ["site-header"] },
    h("a", { className: ["site-title"], href: href(shell.basePath) }, shell.title),
    versionSwitcher(shell),
    searchForm(),
  );
}

function siteFooter(shell: SiteShell): Element {
  return h(
    "footer",
    { className: ["site-footer"] },
    h("p", null, [shell.title, shell.version.name].filter(Boolean).join(" · "), " · Built with DocOps"),
    h(
      "p",
      { id: "docops-shortcuts", className: ["shortcut-pref"], hidden: true },
      "Press ",
      h("kbd", null, "/"),
      " to search. ",
      h("button", { type: "button", className: ["link-button"] }, "Turn off the / shortcut"),
    ),
  );
}

/** A complete HTML document for one page (no inline scripts or styles). */
export function renderDocument(shell: SiteShell, page: DocumentInput): string {
  const base = shell.basePath;
  const canonical = shell.baseUrl && !shell.preview && !page.noindex ? absoluteUrl(withLinkBase(page.url, shell.publicBasePath), shell.baseUrl) : undefined;
  const noindex = shell.preview || page.noindex === true;
  const head = h(
    "head",
    null,
    lines(
      [
        h("meta", { charSet: "utf-8" }),
        h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
        h("meta", { httpEquiv: ["Content-Security-Policy"], content: CONTENT_SECURITY_POLICY }),
        h("meta", { name: "referrer", content: "strict-origin-when-cross-origin" }),
        noindex ? h("meta", { name: "robots", content: "noindex" }) : undefined,
        h("title", null, `${page.title} · ${shell.title}`),
        page.description ? h("meta", { name: "description", content: page.description }) : undefined,
        canonical ? h("link", { rel: ["canonical"], href: canonical }) : undefined,
        h("meta", { name: "generator", content: `DocOps renderer ${RENDERER_VERSION}` }),
        h("link", { rel: ["stylesheet"], href: href(`${base}assets/docops.css`) }),
        h("link", { rel: ["stylesheet"], href: href(`${base}assets/theme.css`) }),
        h("script", { src: href(`${base}assets/docops.js`), defer: true }),
      ].filter((e): e is Element => e !== undefined),
    ),
  );

  const toc = renderToc(page.toc ?? []);
  const main = h(
    "main",
    { id: "content", tabIndex: -1 },
    lines(
      [
        toc,
        h("article", { id: page.articleId, className: ["doc", ...(page.articleClass ?? [])] }, page.body),
        page.footer && page.footer.length > 0 ? h("footer", { className: ["page-footer"] }, page.footer) : undefined,
      ].filter((e): e is Element => e !== undefined),
    ),
  );
  const sidebar = h(
    "nav",
    { className: ["sidebar"], ariaLabel: "Documentation" },
    h("details", { className: ["nav-details"], open: true }, h("summary", null, "Menu"), renderNavList(shell.nav, page.url)),
  );
  const body = h(
    "body",
    null,
    lines(
      [
        // The skip link must be the first focusable element.
        h("a", { className: ["skip-link"], href: "#content" }, "Skip to content"),
        shell.preview ? h("div", { className: ["preview-banner"], role: "status" }, "Preview build") : undefined,
        siteHeader(shell),
        h("div", { className: ["layout"] }, lines([sidebar, main])),
        siteFooter(shell),
      ].filter((e): e is Element => e !== undefined),
    ),
  );
  const html = h("html", { lang: shell.lang, dataBasePath: base, dataVersion: shell.version.name || undefined }, lines([head, body]));
  return `${toHtml({ type: "root", children: [{ type: "doctype" }, { type: "text", value: "\n" }, html] }, { allowDangerousCharacters: true })}\n`;
}
