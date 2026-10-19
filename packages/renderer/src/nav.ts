import type { Element } from "hast";
import { h, type HChild } from "./hast.ts";
import { href } from "./urls.ts";

/** A sidebar entry. Entries without `url` are group labels. */
export interface NavNode {
  label: HChild;
  url?: string | undefined;
  children: NavNode[];
}

export interface NavPage {
  /** Path relative to the docs root. */
  path: string;
  url: string;
  title: string;
  /** `nav_order` frontmatter. */
  order?: number | undefined;
}

interface DirNode {
  name: string;
  path: string;
  index?: NavPage | undefined;
  pages: NavPage[];
  dirs: Map<string, DirNode>;
}

interface SortItem {
  order: number;
  title: string;
  key: string;
  node: NavNode;
}

function compareItems(a: SortItem, b: SortItem): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  const at = a.title.toLowerCase();
  const bt = b.title.toLowerCase();
  if (at !== bt) return at < bt ? -1 : 1;
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  return 0;
}

function humanize(name: string): string {
  const words = name.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

const INDEX_RE = /^index\.mdx?$/i;

/**
 * Sidebar tree from the docs directory structure: the index page first, then
 * pages and directories ordered by `nav_order`, then title. A directory links to
 * its own index page when it has one.
 */
export function buildContentNav(pages: readonly NavPage[]): NavNode[] {
  const root: DirNode = { name: "", path: "", pages: [], dirs: new Map() };
  for (const page of pages) {
    const parts = page.path.split("/");
    const file = parts.pop() ?? page.path;
    let dir = root;
    for (const part of parts) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { name: part, path: dir.path ? `${dir.path}/${part}` : part, pages: [], dirs: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    if (INDEX_RE.test(file) && !dir.index) dir.index = page;
    else dir.pages.push(page);
  }
  const toNodes = (dir: DirNode): NavNode[] => {
    const items: SortItem[] = [];
    for (const page of dir.pages) {
      items.push({ order: page.order ?? Number.POSITIVE_INFINITY, title: page.title, key: page.path, node: { label: page.title, url: page.url, children: [] } });
    }
    for (const sub of dir.dirs.values()) {
      const title = sub.index?.title ?? humanize(sub.name);
      items.push({
        order: sub.index?.order ?? Number.POSITIVE_INFINITY,
        title,
        key: sub.path,
        node: { label: title, url: sub.index?.url, children: toNodes(sub) },
      });
    }
    return items.sort(compareItems).map((item) => item.node);
  };
  const nodes = toNodes(root);
  if (root.index) nodes.unshift({ label: root.index.title, url: root.index.url, children: [] });
  return nodes;
}

/** `<ul>` for the sidebar, marking the current page with `aria-current="page"`. */
export function renderNavList(nodes: readonly NavNode[], currentUrl: string): Element {
  return h(
    "ul",
    null,
    nodes.map((node) =>
      h(
        "li",
        null,
        node.url !== undefined
          ? h("a", { href: href(node.url), ariaCurrent: node.url === currentUrl ? "page" : undefined }, node.label)
          : h("span", { className: ["nav-group"] }, node.label),
        node.children.length > 0 ? renderNavList(node.children, currentUrl) : null,
      ),
    ),
  );
}
