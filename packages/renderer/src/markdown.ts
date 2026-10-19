import GithubSlugger from "github-slugger";
import type { Element, ElementContent, Root as HastRoot, RootContent } from "hast";
import type { Root as MdRoot } from "mdast";
import { toHast, type Handler, type Handlers } from "mdast-util-to-hast";
import { parseMarkdown, type Heading } from "@docops/markdown";
import { callout, calloutKind, codeBlock, codeMetaTitle } from "./blocks.ts";
import { allOf, asFlowElement, isFlowComponent, oneOf, renderJsx } from "./components.ts";
import type { RenderContext } from "./context.ts";
import { h, hasClass, isElement, rewriteElements, toText, visitElements } from "./hast.ts";
import { hasFlowChildren, isBlankText, isJsxElement, jsxAttribute, mdToString, walkMd, type MdNode } from "./mdnode.ts";
import { sanitizeBody } from "./sanitize.ts";
import { isExternalHref, resolveDocUrl } from "./urls.ts";
import { substituteVariables, variableExpressionText } from "./variables.ts";

const SNIPPET_COMMENT_RE = /<!--\s*docops:snippet\s+name="([^"]+)"\s*-->/;
const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i;
const MAX_SNIPPET_DEPTH = 8;

/** Mutable state shared by the mdast → hast handlers of one render. */
export interface MdRenderState {
  ctx: RenderContext;
  slugger: GithubSlugger;
  /** Depth of the last heading seen (tab headings nest one level below it). */
  lastHeadingDepth: number;
  /** Added to every Markdown heading depth (used for OpenAPI descriptions). */
  headingOffset: number;
}

export interface MarkdownRenderOptions {
  /** Path (relative to the docs root) that relative links are resolved against. */
  fromPath: string;
  /** Heading anchors computed by @docops/markdown, in document order. */
  headings?: readonly Heading[];
  headingOffset?: number;
  /** Ids that generated heading anchors must not reuse. */
  reservedIds?: readonly string[];
  /** Share anchor uniqueness across several fragments rendered into one page. */
  slugger?: GithubSlugger;
}

export interface MarkdownRenderResult {
  /** Sanitized hast. */
  root: HastRoot;
  /** Snippets inlined (transitively), sorted. */
  usedSnippets: string[];
}

// ---------------------------------------------------------------------------
// mdast preprocessing (on a private clone): snippets, variables, links, alerts.

interface PreState {
  fromPath: string;
  ctx: RenderContext;
  used: Set<string>;
  stack: string[];
}

function snippetReference(node: MdNode): string | undefined {
  if (node.type === "html" && typeof node.value === "string") return SNIPPET_COMMENT_RE.exec(node.value)?.[1];
  if (isJsxElement(node) && node.name === "Snippet") return jsxAttribute(node, "name") ?? "";
  return undefined;
}

function stampPosition(node: MdNode, position: MdNode["position"]): void {
  walkMd(node, (n) => {
    if (position) n.position = position;
    else delete n.position;
  });
}

function expandSnippet(name: string, at: MdNode, parent: MdNode | undefined, st: PreState): MdNode[] {
  const snippet = st.ctx.snippets.get(name);
  if (!snippet || st.stack.includes(name) || st.stack.length >= MAX_SNIPPET_DEPTH) return [];
  st.used.add(name);
  const clone = structuredClone(snippet.tree) as unknown as MdNode;
  processChildren(clone, { ...st, fromPath: snippet.path, stack: [...st.stack, name] });
  // Issues inside a snippet are reported at the line of the directive that inlined it.
  stampPosition(clone, at.position);
  const children = clone.children ?? [];
  if (!hasFlowChildren(parent)) {
    const only = children.length === 1 ? children[0] : undefined;
    if (only?.type === "paragraph") return only.children ?? [];
  }
  return children;
}

function toAlert(node: MdNode): MdNode | undefined {
  const first = node.children?.[0];
  if (first?.type !== "paragraph" || !first.children) return undefined;
  const head = first.children[0];
  if (head?.type !== "text" || typeof head.value !== "string") return undefined;
  const match = ALERT_RE.exec(head.value);
  if (!match?.[1]) return undefined;
  head.value = head.value.slice(match[0].length);
  if (head.value === "") first.children.shift();
  if (first.children[0]?.type === "break") first.children.shift();
  if (first.children.length === 0 || first.children.every(isBlankText)) node.children?.shift();
  return { type: "docopsCallout", kind: match[1].toLowerCase(), children: node.children ?? [], position: node.position };
}

function processNode(node: MdNode, parent: MdNode | undefined, st: PreState): MdNode[] {
  switch (node.type) {
    case "yaml":
    case "toml":
    case "mdxjsEsm":
      return [];
    case "html": {
      const name = snippetReference(node);
      // Raw HTML is never rendered; only snippet directives survive.
      return name === undefined ? [] : expandSnippet(name, node, parent, st);
    }
    case "mdxJsxFlowElement":
    case "mdxJsxTextElement": {
      const name = snippetReference(node);
      if (name !== undefined) return expandSnippet(name, node, parent, st);
      break;
    }
    case "paragraph": {
      const meaningful = (node.children ?? []).filter((c) => !isBlankText(c));
      const only = meaningful.length === 1 ? meaningful[0] : undefined;
      const name = only ? snippetReference(only) : undefined;
      if (only && name !== undefined) return expandSnippet(name, only, parent, st);
      break;
    }
    case "mdxFlowExpression":
    case "mdxTextExpression": {
      const value = variableExpressionText(node.value ?? "", st.ctx.variables);
      if (value === undefined) return []; // never evaluated
      const textNode: MdNode = { type: "text", value, position: node.position };
      return node.type === "mdxFlowExpression" ? [{ type: "paragraph", children: [textNode], position: node.position }] : [textNode];
    }
    case "text":
    case "inlineCode":
    case "code":
      node.value = substituteVariables(node.value ?? "", st.ctx.variables);
      return [node];
    case "link":
    case "image":
    case "definition":
      if (typeof node.url === "string") {
        node.url = resolveDocUrl(substituteVariables(node.url, st.ctx.variables), st.fromPath, st.ctx);
      }
      break;
    default:
      break;
  }
  if (node.children) processChildren(node, st);
  if (node.type === "blockquote") return [toAlert(node) ?? node];
  return [node];
}

function processChildren(parent: MdNode, st: PreState): void {
  if (!parent.children) return;
  const out: MdNode[] = [];
  for (const child of parent.children) out.push(...processNode(child, parent, st));
  parent.children = out;
}

/** Attach the anchors computed by @docops/markdown to heading nodes (same pre-order walk). */
function assignAnchors(tree: MdNode, headings: readonly Heading[], slugger: GithubSlugger): void {
  const nodes: MdNode[] = [];
  walkMd(tree, (n) => {
    if (n.type === "heading") nodes.push(n);
  });
  headings.forEach((heading, i) => {
    // Replaying the texts reproduces the slugger state, so generated anchors never collide.
    slugger.slug(heading.text);
    const node = nodes[i];
    if (!node) return;
    const line = node.position?.start.line;
    if (line === undefined || heading.line === 0 || line === heading.line) {
      node.data = { ...node.data, docopsAnchor: heading.anchor };
    }
  });
}

// ---------------------------------------------------------------------------
// mdast → hast handlers.

function createHandlers(rs: MdRenderState): Record<string, Handler> {
  const heading: Handler = (state, node: MdNode) => {
    const depth = Math.min(6, Math.max(1, Number(node.depth ?? 1) + rs.headingOffset));
    rs.lastHeadingDepth = depth;
    const children = allOf(state, node);
    const label = toText(children).replace(/\s+/g, " ").trim();
    const preset = node.data?.docopsAnchor;
    const anchor = typeof preset === "string" ? preset : rs.slugger.slug(label || mdToString(node));
    const element = h(`h${depth}`, { id: anchor || undefined }, children);
    state.patch(node as never, element);
    if (depth === 1 || !anchor) return element;
    const wrapper = h(
      "div",
      { className: ["heading-wrapper"] },
      element,
      h("a", { className: ["heading-anchor"], href: `#${anchor}`, ariaLabel: `Link to section: ${label || anchor}` }, "#"),
    );
    state.patch(node as never, wrapper);
    return wrapper;
  };

  const code: Handler = (state, node: MdNode) => {
    const meta = typeof node.meta === "string" ? node.meta : undefined;
    const lang = typeof node.lang === "string" ? node.lang : undefined;
    const element = codeBlock(node.value ?? "", lang, codeMetaTitle(meta));
    state.patch(node as never, element);
    return element;
  };

  const paragraph: Handler = (state, node: MdNode) => {
    const meaningful = (node.children ?? []).filter((c) => !isBlankText(c));
    if (meaningful.length === 0) return undefined;
    if (meaningful.every((c) => c.type === "mdxJsxTextElement" && isFlowComponent(c.name))) {
      // `<Callout>…</Callout>` written on one line: render as a block, not inside <p>.
      return meaningful.flatMap((c) => oneOf(state, asFlowElement(c), node));
    }
    const element: Element = h("p", null, allOf(state, node));
    state.patch(node as never, element);
    return element;
  };

  const docopsCallout: Handler = (state, node: MdNode) => {
    const element = callout(calloutKind(typeof node.kind === "string" ? node.kind : "note"), undefined, allOf(state, node));
    state.patch(node as never, element);
    return element;
  };

  const nothing: Handler = () => undefined;

  return {
    heading,
    code,
    paragraph,
    docopsCallout,
    html: nothing,
    mdxjsEsm: nothing,
    mdxFlowExpression: nothing,
    mdxTextExpression: nothing,
    mdxJsxFlowElement: (state, node: MdNode) => renderJsx(state, node, "flow", rs),
    mdxJsxTextElement: (state, node: MdNode) => renderJsx(state, node, "text", rs),
  };
}

/** Unknown node types: render their children, never their raw `value`. */
const unknownHandler: Handler = (state, node: MdNode) => (Array.isArray(node.children) ? allOf(state, node) : undefined);

// ---------------------------------------------------------------------------
// hast post-processing (before sanitizing).

function tableLabel(table: Element): string {
  const headers: string[] = [];
  visitElements(table, (el) => {
    if (el.tagName === "th") headers.push(toText(el).trim());
  });
  const named = headers.filter(Boolean);
  return named.length > 0 ? `Table: ${named.join(", ")}` : "Table";
}

function postProcess(root: HastRoot): void {
  rewriteElements(root, (el, parent) => {
    if (el.tagName === "a" && typeof el.properties.href === "string" && isExternalHref(el.properties.href)) {
      el.properties.rel = ["noopener", "noreferrer"];
    }
    if (el.tagName === "img") {
      el.properties.loading = "lazy";
      el.properties.decoding = "async";
    }
    if (el.tagName === "table") {
      for (const section of el.children) {
        if (!isElement(section, "thead")) continue;
        for (const row of section.children) {
          if (!isElement(row, "tr")) continue;
          for (const cell of row.children) if (isElement(cell, "th")) cell.properties.scope = "col";
        }
      }
      if (!(isElement(parent) && hasClass(parent, "table-wrap"))) {
        const wrapper = h("div", { className: ["table-wrap"], role: "region", tabIndex: 0, ariaLabel: tableLabel(el) }, el);
        if (el.position) wrapper.position = el.position;
        return wrapper;
      }
    }
    return el;
  });
}

/** Images whose `src` the sanitizer rejected (e.g. `data:`) degrade to their alt text. */
function replaceUnsafeImages(node: HastRoot | Element): void {
  const out: RootContent[] = [];
  for (const child of node.children as RootContent[]) {
    if (child.type === "element") {
      if (child.tagName === "img" && typeof child.properties.src !== "string") {
        const alt = typeof child.properties.alt === "string" ? child.properties.alt : "";
        if (alt) out.push({ type: "text", value: alt });
        continue;
      }
      replaceUnsafeImages(child);
    }
    out.push(child);
  }
  (node as { children: RootContent[] }).children = out;
}

// ---------------------------------------------------------------------------

/**
 * Render a Markdown/MDX tree to sanitized hast. The input tree is not modified.
 */
export function renderMarkdownTree(tree: MdRoot, ctx: RenderContext, options: MarkdownRenderOptions): MarkdownRenderResult {
  const clone = structuredClone(tree) as unknown as MdNode;
  const slugger = options.slugger ?? new GithubSlugger();
  for (const id of options.reservedIds ?? []) slugger.slug(id);
  assignAnchors(clone, options.headings ?? [], slugger);
  const used = new Set<string>();
  processChildren(clone, { fromPath: options.fromPath, ctx, used, stack: [] });
  const rs: MdRenderState = { ctx, slugger, lastHeadingDepth: 1, headingOffset: options.headingOffset ?? 0 };
  const hast = toHast(clone as unknown as MdRoot, {
    handlers: createHandlers(rs) as Handlers,
    unknownHandler,
    allowDangerousHtml: false,
  });
  const root: HastRoot = hast.type === "root" ? hast : { type: "root", children: [hast as ElementContent] };
  postProcess(root);
  const clean = sanitizeBody(root);
  replaceUnsafeImages(clean);
  return { root: clean, usedSnippets: [...used].sort() };
}

/** Render a standalone Markdown string (OpenAPI descriptions). */
export function renderMarkdownSource(source: string, ctx: RenderContext, options: Omit<MarkdownRenderOptions, "headings">): MarkdownRenderResult {
  const parsed = parseMarkdown("description.md", source);
  return renderMarkdownTree(parsed.tree, ctx, options);
}

/** Children of a rendered fragment, unwrapped from a single paragraph (for table cells). */
export function inlineContent(root: HastRoot): ElementContent[] {
  const meaningful = root.children.filter((c) => !(c.type === "text" && c.value.trim() === ""));
  const only = meaningful.length === 1 ? meaningful[0] : undefined;
  if (only && isElement(only, "p")) return only.children;
  return meaningful.filter((c): c is ElementContent => c.type === "element" || c.type === "text");
}
