import type { Link, Nodes } from "mdast";
import { toString } from "mdast-util-to-string";
import { SKIP, visit } from "unist-util-visit";
import { parseMarkdown } from "@docops/markdown";

export interface OutputFilterOptions {
  /** Hostnames whose https links may render (the tenant's docs domains). `*.example.com` matches subdomains. */
  allowHosts: readonly string[];
  /** Texts of the cited chunks: an https link that appears verbatim in one of them may render. */
  citedTexts: readonly string[];
}

export interface OutputFilterResult {
  markdown: string;
  removedImages: number;
  removedHtml: number;
  rewrittenLinks: number;
  removedDefinitions: number;
}

interface Edit {
  start: number;
  end: number;
  replacement: string;
}

const MAX_PASSES = 5;

/**
 * Sanitize model-written Markdown before it renders (docs/07 §2.4, threat T22):
 * - images (inline and reference) are removed: they would auto-load remote URLs;
 * - raw HTML (tags, comments, blocks) is removed;
 * - link reference definitions are removed;
 * - a link survives only if it is `https` and its host is allowlisted or the exact
 *   URL appears in a cited chunk; otherwise it is replaced by its (escaped) text, or
 *   by "(link removed)" when the text is itself a URL.
 * Code spans and fenced code are left untouched: they never render as HTML, images or
 * links. Edits are applied to the original string, so the rest of the Markdown
 * (and the [S1] markers) keep their exact formatting. Passes repeat until nothing
 * changes, so removals cannot assemble a new construct.
 */
export function filterAnswerMarkdown(markdown: string, opts: OutputFilterOptions): OutputFilterResult {
  const result: OutputFilterResult = { markdown, removedImages: 0, removedHtml: 0, rewrittenLinks: 0, removedDefinitions: 0 };
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const edits = collectEdits(result.markdown, opts, result);
    if (edits.length === 0) return result;
    result.markdown = applyEdits(result.markdown, edits);
  }
  // Still changing after several passes: fail closed to plain text.
  result.markdown = escapeMarkdownText(result.markdown);
  return result;
}

export function isAllowedLink(url: string, opts: OutputFilterOptions): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // relative or malformed
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (opts.allowHosts.some((entry) => hostMatches(host, entry))) return true;
  return opts.citedTexts.some((text) => text.includes(url));
}

export function hostMatches(host: string, entry: string): boolean {
  const pattern = entry.trim().toLowerCase();
  if (pattern.startsWith("*.")) return host === pattern.slice(2) || host.endsWith(pattern.slice(1));
  return host === pattern;
}

function collectEdits(markdown: string, opts: OutputFilterOptions, counts: OutputFilterResult): Edit[] {
  const tree = parseMarkdown("answer.md", markdown).tree;
  const edits: Edit[] = [];
  visit(tree, (node: Nodes) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return undefined;
    switch (node.type) {
      case "image":
      case "imageReference":
        counts.removedImages++;
        edits.push({ start, end, replacement: "" });
        return SKIP;
      case "html":
        counts.removedHtml++;
        edits.push({ start, end, replacement: "" });
        return SKIP;
      case "yaml":
        edits.push({ start, end, replacement: "" });
        return SKIP;
      case "definition":
        counts.removedDefinitions++;
        edits.push({ start, end, replacement: "" });
        return SKIP;
      case "link": {
        const link = node as Link;
        if (isAllowedLink(link.url, opts)) return undefined; // keep; still sanitize its children
        counts.rewrittenLinks++;
        const text = toString(link, { includeImageAlt: false }).trim();
        const host = hostOf(link.url);
        const urlLike =
          /^(?:[a-z][a-z0-9+.-]*:|www\.|\/\/)/i.test(text) ||
          /\b[\w-]+(?:\.[\w-]+)+\/\S*/.test(text) ||
          (host !== null && text.toLowerCase().includes(host));
        edits.push({ start, end, replacement: text.length === 0 ? "" : urlLike ? "(link removed)" : escapeMarkdownText(text) });
        return SKIP;
      }
      default:
        return undefined;
    }
  });
  return edits;
}

function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    let start = edit.start;
    // A removal between two spaces takes one of them along, so "a ![x](y) b" becomes "a b".
    if (edit.replacement === "" && text[start - 1] === " " && (edit.end === text.length || /[ \n]/.test(text[edit.end] ?? ""))) start--;
    out = out.slice(0, start) + edit.replacement + out.slice(edit.end);
  }
  return out;
}

/** Escape characters that could re-create links, images, HTML or emphasis. */
export function escapeMarkdownText(text: string): string {
  return text.replace(/[\\`*_[\]()<>!]/g, (ch) => `\\${ch}`);
}
