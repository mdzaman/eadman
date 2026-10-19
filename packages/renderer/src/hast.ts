import type { Element, ElementContent, Nodes, Parents, Properties, Root, RootContent, Text } from "hast";

/** Anything `h()` accepts as a child: nodes, strings, numbers, nested lists; falsy values are skipped. */
export type HChild = ElementContent | string | number | null | undefined | false | HChild[];

function pushChildren(out: ElementContent[], children: readonly HChild[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) pushChildren(out, child);
    else if (typeof child === "string" || typeof child === "number") {
      const value = String(child);
      if (value !== "") out.push({ type: "text", value });
    } else out.push(child);
  }
}

/** Build a hast element. `undefined`, `null` and `false` properties are dropped. */
export function h(tagName: string, properties?: Properties | null, ...children: HChild[]): Element {
  const props: Properties = {};
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      if (value === undefined || value === null || value === false) continue;
      props[key] = value;
    }
  }
  const out: ElementContent[] = [];
  pushChildren(out, children);
  return { type: "element", tagName, properties: props, children: out };
}

export function text(value: string): Text {
  return { type: "text", value };
}

export function nodes(...children: HChild[]): ElementContent[] {
  const out: ElementContent[] = [];
  pushChildren(out, children);
  return out;
}

/** Interleave newlines between block-level children (keeps generated HTML diffable). */
export function lines(children: ElementContent[]): ElementContent[] {
  const out: ElementContent[] = [];
  for (const child of children) {
    out.push({ type: "text", value: "\n" }, child);
  }
  if (out.length > 0) out.push({ type: "text", value: "\n" });
  return out;
}

export function isElement(node: unknown, tagName?: string): node is Element {
  return (
    typeof node === "object" &&
    node !== null &&
    (node as { type?: unknown }).type === "element" &&
    (tagName === undefined || (node as Element).tagName === tagName)
  );
}

export function classList(el: Element): string[] {
  const value: unknown = el.properties.className;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [];
}

export function hasClass(el: Element, name: string): boolean {
  return classList(el).includes(name);
}

export interface TextOptions {
  /** Elements whose subtree is skipped. */
  skip?: (el: Element) => boolean;
  /** Include `img` alt text (accessible-name style). */
  alt?: boolean;
}

/** Concatenated text content of hast nodes. */
export function toText(input: Nodes | readonly (Nodes | RootContent)[], options: TextOptions = {}): string {
  let out = "";
  const visit = (node: Nodes | RootContent): void => {
    if (node.type === "text") out += node.value;
    else if (node.type === "element") {
      if (options.skip?.(node)) return;
      if (options.alt && node.tagName === "img" && typeof node.properties.alt === "string") out += node.properties.alt;
      for (const child of node.children) visit(child);
    } else if (node.type === "root") {
      for (const child of node.children) visit(child);
    }
  };
  if (Array.isArray(input)) for (const node of input) visit(node as Nodes);
  else visit(input as Nodes);
  return out;
}

/** Depth-first, document-order walk over elements. */
export function visitElements(node: Nodes, visitor: (el: Element, parent: Parents) => void): void {
  if (node.type !== "root" && node.type !== "element") return;
  for (const child of node.children) {
    if (child.type === "element") {
      visitor(child, node);
      visitElements(child, visitor);
    }
  }
}

/**
 * Post-order rewrite of elements: the callback may return a replacement element
 * (e.g. a wrapper) for the visited one.
 */
export function rewriteElements(node: Root | Element, rewrite: (el: Element, parent: Root | Element) => Element): void {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child?.type !== "element") continue;
    rewriteElements(child, rewrite);
    const replacement = rewrite(child, node);
    if (replacement !== child) node.children[i] = replacement;
  }
}
