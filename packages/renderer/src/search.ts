import type { Element, Nodes, RootContent } from "hast";
import { hasClass } from "./hast.ts";

const SKIP_TAGS = new Set(["pre", "script", "style", "nav", "button", "form", "select", "textarea"]);

const INLINE_TAGS = new Set([
  "a", "abbr", "b", "code", "del", "em", "i", "ins", "kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub",
  "sup", "time", "u", "var",
]);

function skipForText(el: Element): boolean {
  return (
    SKIP_TAGS.has(el.tagName) ||
    hasClass(el, "heading-anchor") ||
    hasClass(el, "sr-only") ||
    el.properties.hidden === true ||
    el.properties.dataFootnoteRef !== undefined
  );
}

function textOf(node: Nodes | RootContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") {
    if (skipForText(node)) return "";
    const inner = node.children.map(textOf).join("");
    // Pad block-level elements so words from adjacent blocks don't run together.
    return INLINE_TAGS.has(node.tagName) ? inner : ` ${inner} `;
  }
  if (node.type === "root") return node.children.map(textOf).join(" ");
  return "";
}

/** Readable plain text of rendered content (code blocks and UI chrome excluded). */
export function plainText(input: Nodes | readonly (Nodes | RootContent)[]): string {
  const list: readonly (Nodes | RootContent)[] = Array.isArray(input) ? input : [input as Nodes];
  return list.map(textOf).join(" ").replace(/\s+/g, " ").trim();
}

export function firstWords(value: string, count = 300): string {
  return value.split(/\s+/).filter(Boolean).slice(0, count).join(" ");
}

/** A short description (≤ `max` characters) from plain text. */
export function summarize(value: string, max = 160): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}
