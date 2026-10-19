import type { Element, ElementContent } from "hast";
import type { Nodes as MdastNodes, Parents as MdastParents } from "mdast";
import type { State } from "mdast-util-to-hast";
import {
  callout,
  calloutKind,
  codeBlock,
  codeMetaTitle,
  languageLabel,
  methodBadge,
  tabsGroup,
  type TabPanel,
} from "./blocks.ts";
import { h } from "./hast.ts";
import type { MdRenderState } from "./markdown.ts";
import { asFlowChildren, isBlankText, isJsxElement, jsxAttribute, type MdNode } from "./mdnode.ts";
import { href } from "./urls.ts";
import { substituteVariables } from "./variables.ts";

/** Components that stay inline when they are the only content of a paragraph. */
const INLINE_COMPONENTS = new Set(["JiraStatus", "FeatureFlag", "Snippet"]);

/** Intrinsic (lowercase) MDX elements whose content is never rendered. */
const DROPPED_ELEMENTS = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "template", "noscript",
  "link", "meta", "base", "form", "input", "button", "textarea", "select", "option", "svg", "math",
  "video", "audio", "source", "track", "canvas", "dialog", "portal", "title", "head", "html", "body",
]);

/** Capitalized components rendered as block content (a paragraph holding only them is unwrapped). */
export function isFlowComponent(name: string | null | undefined): boolean {
  return typeof name === "string" && /^[A-Z]/.test(name) && !INLINE_COMPONENTS.has(name);
}

export function allOf(state: State, node: MdNode): ElementContent[] {
  return state.all(node as unknown as MdastNodes);
}

export function oneOf(state: State, node: MdNode, parent: MdNode | undefined): ElementContent[] {
  const result = state.one(node as unknown as MdastNodes, parent as unknown as MdastParents | undefined);
  if (result === undefined) return [];
  return Array.isArray(result) ? result : [result];
}

function patch<T extends Element>(state: State, node: MdNode, element: T): T {
  state.patch(node as unknown as MdastNodes, element);
  return element;
}

/** Turn paragraphs that only hold JSX elements into those elements (rendered as flow). */
export function flowItems(children: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (const child of children) {
    if (child.type === "paragraph") {
      const meaningful = (child.children ?? []).filter((c) => !isBlankText(c));
      if (meaningful.length > 0 && meaningful.every(isJsxElement)) {
        for (const element of meaningful) out.push(asFlowElement(element));
        continue;
      }
    }
    out.push(child);
  }
  return out;
}

export function asFlowElement(element: MdNode): MdNode {
  if (element.type === "mdxJsxFlowElement") return element;
  return { ...element, type: "mdxJsxFlowElement", children: asFlowChildren(element.children ?? []) };
}

function tabHeadingLevel(rs: MdRenderState): number {
  return Math.min(6, Math.max(2, rs.lastHeadingDepth + 1));
}

function tabLabel(node: MdNode, index: number, rs: MdRenderState): string {
  const label = jsxAttribute(node, "label") ?? jsxAttribute(node, "title") ?? jsxAttribute(node, "value") ?? "";
  return substituteVariables(label, rs.ctx.variables).trim() || `Tab ${index}`;
}

function renderTabs(state: State, node: MdNode, rs: MdRenderState, codeGroup: boolean): Element {
  const level = tabHeadingLevel(rs);
  const before = rs.lastHeadingDepth;
  const panels: TabPanel[] = [];
  const extra: ElementContent[] = [];
  let index = 0;
  for (const child of flowItems(node.children ?? [])) {
    rs.lastHeadingDepth = level;
    if (isJsxElement(child) && child.name === "Tab") {
      index += 1;
      panels.push({ label: tabLabel(child, index, rs), children: allOf(state, child), position: child.position });
    } else if (codeGroup && child.type === "code") {
      index += 1;
      const meta = typeof child.meta === "string" ? child.meta : undefined;
      const lang = typeof child.lang === "string" ? child.lang : undefined;
      const label = codeMetaTitle(meta) ?? (meta && !meta.includes("=") ? meta.trim() : undefined) ?? languageLabel(lang) ?? `Example ${index}`;
      const block = patch(state, child, codeBlock(child.value ?? "", lang));
      panels.push({ label, children: [block], position: child.position });
    } else {
      const rendered = oneOf(state, child, node);
      const last = panels[panels.length - 1];
      if (codeGroup && last) last.children.push(...rendered);
      else extra.push(...rendered);
    }
  }
  rs.lastHeadingDepth = before;
  return patch(state, node, tabsGroup(panels, level, codeGroup ? "code-group" : undefined, extra));
}

function renderApiOperation(state: State, node: MdNode, mode: "flow" | "text", rs: MdRenderState): Element {
  const op = jsxAttribute(node, "op") ?? jsxAttribute(node, "operation");
  const operationId = jsxAttribute(node, "operationId");
  const source = jsxAttribute(node, "source");
  const found = rs.ctx.operations.find({ op, operationId, source });
  if (!found) {
    const label = (op ?? operationId ?? "").trim() || "operation";
    return patch(
      state,
      node,
      h(
        mode === "flow" ? "div" : "span",
        { className: ["api-operation", "api-operation-missing"], dataComponent: "ApiOperation" },
        h("code", null, label),
        " (not found in the API reference)",
      ),
    );
  }
  const link = h(
    "a",
    { className: [mode === "flow" ? "api-operation-link" : "api-operation-inline"], href: href(found.url) },
    methodBadge(found.method),
    " ",
    h("code", { className: ["api-path"] }, found.path),
    mode === "flow" && found.summary ? [" ", h("span", { className: ["api-summary"] }, found.summary)] : null,
    found.deprecated ? " (deprecated)" : null,
  );
  if (mode === "text") return patch(state, node, link);
  return patch(state, node, h("div", { className: ["api-operation"] }, link, allOf(state, node)));
}

/**
 * Render an MDX JSX element. Nothing is ever executed: attributes are read as
 * literals, unknown components become `<div data-component>` wrappers, and
 * intrinsic HTML-like elements are unwrapped (or dropped when dangerous).
 */
export function renderJsx(state: State, node: MdNode, mode: "flow" | "text", rs: MdRenderState): ElementContent[] {
  const name = typeof node.name === "string" ? node.name : "";
  if (name === "") return allOf(state, node); // fragment
  switch (name) {
    case "Callout": {
      const kind = calloutKind(jsxAttribute(node, "type") ?? jsxAttribute(node, "kind"));
      const title = jsxAttribute(node, "title");
      const label = title === undefined ? undefined : substituteVariables(title, rs.ctx.variables);
      return [patch(state, node, callout(kind, label, allOf(state, node), mode === "text"))];
    }
    case "Tabs":
      return [renderTabs(state, node, rs, false)];
    case "CodeGroup":
      return [renderTabs(state, node, rs, true)];
    case "Tab": {
      // A Tab outside Tabs: a single labelled section.
      const level = tabHeadingLevel(rs);
      return [patch(state, node, tabsGroup([{ label: tabLabel(node, 1, rs), children: allOf(state, node), position: node.position }], level))];
    }
    case "ApiOperation":
      return [renderApiOperation(state, node, mode, rs)];
    case "JiraStatus": {
      const key = (jsxAttribute(node, "key") ?? jsxAttribute(node, "issue") ?? "").trim();
      const span = patch(state, node, h("span", { className: ["jira-status"], dataJiraKey: key }, key));
      return [mode === "flow" ? h("p", null, span) : span];
    }
    case "FeatureFlag":
      return allOf(state, node);
    case "Snippet":
      return []; // expanded before conversion; unknown snippets render nothing
    default:
      break;
  }
  if (/^[a-z]/.test(name)) {
    if (DROPPED_ELEMENTS.has(name.toLowerCase())) return [];
    return allOf(state, node);
  }
  return [patch(state, node, h(mode === "flow" ? "div" : "span", { dataComponent: name }, allOf(state, node)))];
}
