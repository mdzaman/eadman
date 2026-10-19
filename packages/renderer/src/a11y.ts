import type { Element, Nodes } from "hast";
import { toText, visitElements } from "./hast.ts";
import type { A11yIssue, A11yRule } from "./types.ts";

/** Link texts that say nothing about the destination (WCAG 2.4.4). */
const NON_DESCRIPTIVE_LINK_TEXT = new Set([
  "click here",
  "click",
  "here",
  "link",
  "this link",
  "this",
  "this page",
  "read more",
  "more",
  "go",
]);

function normalizeName(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s"'“”‘’([{<]+|[\s"'“”‘’)\]}>.,:;!?…]+$/g, "")
    .toLowerCase();
}

/**
 * Static accessibility audit of a rendered page body (before stringifying):
 * image alt text, heading order, link text and table header cells.
 */
export function auditBody(root: Nodes, page: string): A11yIssue[] {
  const issues: A11yIssue[] = [];
  const report = (rule: A11yRule, message: string, el: Element): void => {
    const line = el.position?.start.line;
    issues.push(line === undefined ? { page, rule, message } : { page, rule, message, line });
  };
  // The page title is the implicit top level, so the first heading may be h1 or h2.
  let previousLevel = 1;
  let h1Count = 0;

  visitElements(root, (el) => {
    const tag = el.tagName;

    if (tag === "img") {
      const alt = el.properties.alt;
      const src = typeof el.properties.src === "string" ? el.properties.src : "";
      if (typeof alt !== "string") report("a11y/img-alt", `Image ${src ? `"${src}" ` : ""}has no alt text`, el);
      else if (alt.trim() === "") report("a11y/img-alt", `Image ${src ? `"${src}" ` : ""}has empty alt text; describe the image`, el);
      return;
    }

    const heading = /^h([1-6])$/.exec(tag);
    if (heading?.[1]) {
      const level = Number(heading[1]);
      if (level === 1) {
        h1Count += 1;
        if (h1Count > 1) report("a11y/heading-order", "More than one h1 heading on the page; use h2 for sections", el);
      }
      if (level > previousLevel + 1) {
        report("a11y/heading-order", `Heading level skipped: h${previousLevel} is followed by h${level}`, el);
      }
      previousLevel = level;
      return;
    }

    if (tag === "a" && typeof el.properties.href === "string") {
      const label = typeof el.properties.ariaLabel === "string" ? el.properties.ariaLabel : toText(el, { alt: true });
      const name = normalizeName(label);
      if (name === "") report("a11y/link-text", `Link to "${el.properties.href}" has no text`, el);
      else if (NON_DESCRIPTIVE_LINK_TEXT.has(name)) {
        report("a11y/link-text", `Link text "${label.trim()}" is not descriptive; say where the link goes`, el);
      }
      return;
    }

    if (tag === "table") {
      const headers: Element[] = [];
      visitElements(el, (cell) => {
        if (cell.tagName === "th") headers.push(cell);
      });
      if (headers.length === 0) report("a11y/table-headers", "Table has no header cells (<th>)", el);
      else if (headers.every((th) => toText(th).trim() === "")) report("a11y/table-headers", "Table header cells are empty", el);
    }
  });
  return issues;
}

const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export function isValidLang(lang: string | undefined): lang is string {
  return typeof lang === "string" && LANG_RE.test(lang.trim());
}
