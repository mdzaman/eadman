import type { Position } from "unist";

/**
 * Loosely typed mdast node. The renderer works on a private clone of the tree and
 * handles MDX node types (`mdxJsxFlowElement`, `mdxFlowExpression`, …) and its own
 * internal node types (`docopsCallout`) uniformly through this shape.
 */
export interface MdNode {
  type: string;
  children?: MdNode[];
  value?: string;
  url?: string;
  name?: string | null;
  position?: Position | undefined;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

interface JsxAttribute {
  type?: string;
  name?: string;
  value?: unknown;
}

const STRING_LITERAL_RE = /^\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1\s*$/;
const NUMBER_LITERAL_RE = /^\s*(-?\d+(?:\.\d+)?)\s*$/;

/**
 * Value of a JSX attribute: string values as-is, boolean attributes as "", and
 * expression values only when they are plain string/number literals (`{"x"}`, `{3}`).
 * Expressions are never evaluated.
 */
export function jsxAttribute(node: MdNode, name: string): string | undefined {
  const attributes = Array.isArray(node.attributes) ? (node.attributes as JsxAttribute[]) : [];
  for (const attribute of attributes) {
    if (attribute.type !== "mdxJsxAttribute" || attribute.name !== name) continue;
    const value = attribute.value;
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    if (typeof value === "object" && typeof (value as { value?: unknown }).value === "string") {
      const expression = (value as { value: string }).value;
      const str = STRING_LITERAL_RE.exec(expression);
      if (str) return (str[2] ?? "").replace(/\\(.)/g, "$1");
      const num = NUMBER_LITERAL_RE.exec(expression);
      if (num?.[1]) return num[1];
    }
    return undefined;
  }
  return undefined;
}

export function isJsxElement(node: MdNode): boolean {
  return node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";
}

export function isBlankText(node: MdNode): boolean {
  return node.type === "text" && (node.value ?? "").trim() === "";
}

/** Plain text of an mdast subtree (text, inline code and code values). */
export function mdToString(node: MdNode): string {
  if (typeof node.value === "string" && (node.type === "text" || node.type === "inlineCode" || node.type === "code")) return node.value;
  if (node.type === "image" && typeof node.alt === "string") return node.alt;
  return (node.children ?? []).map(mdToString).join("");
}

/** Pre-order walk over every node (same order as unist-util-visit). */
export function walkMd(node: MdNode, visitor: (node: MdNode) => void): void {
  visitor(node);
  for (const child of node.children ?? []) walkMd(child, visitor);
}

const PHRASING_TYPES = new Set([
  "text",
  "emphasis",
  "strong",
  "delete",
  "inlineCode",
  "break",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "footnoteReference",
  "html",
  "mdxJsxTextElement",
  "mdxTextExpression",
]);

export function isPhrasing(node: MdNode): boolean {
  return PHRASING_TYPES.has(node.type);
}

/** Parents whose children are flow (block) content. */
const FLOW_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition", "mdxJsxFlowElement", "docopsCallout"]);

export function hasFlowChildren(parent: MdNode | undefined): boolean {
  return parent === undefined || FLOW_PARENTS.has(parent.type);
}

/** Wrap phrasing-only children in a paragraph so they can be rendered as flow content. */
export function asFlowChildren(children: MdNode[]): MdNode[] {
  if (children.length === 0 || children.every(isBlankText)) return [];
  if (children.every(isPhrasing)) return [{ type: "paragraph", children }];
  return children;
}
