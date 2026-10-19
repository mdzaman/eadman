import { basename, extname } from "node:path";
import GithubSlugger from "github-slugger";
import type { Code, Heading as MdHeading, Image, InlineCode as MdInlineCode, Link, Nodes, Root } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { parse as parseYaml } from "yaml";
import { sha256Hex, type PageType } from "@docops/core";

export interface Heading {
  depth: number;
  text: string;
  anchor: string;
  line: number;
}

export type LinkKind = "internal" | "anchor" | "external" | "mailto" | "other";

export interface LinkRef {
  url: string;
  text: string;
  line: number;
  kind: LinkKind;
  isImage: boolean;
  /** Section (heading) index the link appears in. */
  section: number;
}

export interface CodeBlock {
  lang: string | null;
  meta: string | null;
  value: string;
  line: number;
  endLine: number;
  section: number;
}

export interface InlineCodeRef {
  value: string;
  line: number;
  section: number;
  /** "table" when inside a GFM table cell. */
  context: "prose" | "table" | "heading";
}

export interface TextBlock {
  kind: "paragraph" | "heading" | "tableRow" | "listItem" | "blockquote";
  text: string;
  line: number;
  endLine: number;
  section: number;
}

export interface Section {
  index: number;
  heading: Heading | null;
  startLine: number;
  endLine: number;
}

export interface IgnorePragma {
  rules: string[];
  /** Applies to the block starting at or after this line; undefined = whole file. */
  line?: number | undefined;
  /** Line of the block the pragma governs (resolved after parse). */
  appliesToLine?: number | undefined;
  appliesToEndLine?: number | undefined;
}

export interface ParsedPage {
  /** Path relative to the docs root, POSIX separators. */
  path: string;
  format: "md" | "mdx";
  source: string;
  contentHash: string;
  frontmatter: Record<string, unknown>;
  frontmatterError?: string | undefined;
  title: string;
  pageType: PageType;
  headings: Heading[];
  anchors: Set<string>;
  links: LinkRef[];
  codeBlocks: CodeBlock[];
  inlineCode: InlineCodeRef[];
  textBlocks: TextBlock[];
  sections: Section[];
  snippets: Array<{ name: string; line: number }>;
  ignores: IgnorePragma[];
  wordCount: number;
  tree: Root;
}

const PAGE_TYPE_ALIASES: Record<string, PageType> = {
  guide: "guide",
  "how-to": "how_to",
  how_to: "how_to",
  howto: "how_to",
  tutorial: "tutorial",
  concept: "concept",
  reference: "reference",
  runbook: "runbook",
  adr: "adr",
  postmortem: "postmortem",
  "release-notes": "release_notes",
  release_notes: "release_notes",
  onboarding: "onboarding",
  snippet: "snippet",
  other: "other",
};

export function normalizePageType(value: unknown, fallback: PageType): PageType {
  if (typeof value !== "string") return fallback;
  return PAGE_TYPE_ALIASES[value.toLowerCase()] ?? fallback;
}

export function classifyUrl(url: string): LinkKind {
  if (url.startsWith("#")) return "anchor";
  if (/^mailto:/i.test(url)) return "mailto";
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return /^https?:/i.test(url) ? "external" : "other";
  if (url.startsWith("//")) return "external";
  return "internal";
}

const mdProcessor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm);
const mdxProcessor = unified().use(remarkParse).use(remarkMdx).use(remarkFrontmatter, ["yaml"]).use(remarkGfm);

const PRAGMA_RE = /docops-ignore(-file)?\s+([\w/.,\s-]+?)\s*(?:-->|\*\/|$)/;
const SNIPPET_COMMENT_RE = /<!--\s*docops:snippet\s+name="([^"]+)"\s*-->/;

function lineOf(node: { position?: { start: { line: number } } | undefined }): number {
  return node.position?.start.line ?? 0;
}

function endLineOf(node: { position?: { end: { line: number } } | undefined }): number {
  return node.position?.end.line ?? 0;
}

export interface ParseOptions {
  defaultPageType?: PageType;
}

/** Parse a Markdown or MDX page into the structures the engine, rules and renderer share. */
export function parseMarkdown(path: string, source: string, options: ParseOptions = {}): ParsedPage {
  const format: "md" | "mdx" = extname(path).toLowerCase() === ".mdx" ? "mdx" : "md";
  const processor = format === "mdx" ? mdxProcessor : mdProcessor;
  const tree = processor.parse(source) as Root;

  let frontmatter: Record<string, unknown> = {};
  let frontmatterError: string | undefined;
  const fm = tree.children[0];
  if (fm?.type === "yaml") {
    try {
      const value = parseYaml(fm.value) as unknown;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) frontmatter = value as Record<string, unknown>;
      else if (value !== null) frontmatterError = "frontmatter must be a YAML mapping";
    } catch (error) {
      frontmatterError = (error as Error).message.split("\n")[0];
    }
  }

  const slugger = new GithubSlugger();
  const headings: Heading[] = [];
  const anchors = new Set<string>();
  const links: LinkRef[] = [];
  const codeBlocks: CodeBlock[] = [];
  const inlineCode: InlineCodeRef[] = [];
  const textBlocks: TextBlock[] = [];
  const snippets: Array<{ name: string; line: number }> = [];
  const ignores: IgnorePragma[] = [];
  const sectionStarts: Array<{ heading: Heading | null; line: number }> = [{ heading: null, line: 1 }];

  // First pass: headings define sections (in document order).
  visit(tree, "heading", (node: MdHeading) => {
    const text = toString(node).trim();
    const heading: Heading = { depth: node.depth, text, anchor: slugger.slug(text), line: lineOf(node) };
    headings.push(heading);
    anchors.add(heading.anchor);
    sectionStarts.push({ heading, line: heading.line });
  });

  const sectionIndexForLine = (line: number): number => {
    let index = 0;
    for (let i = 0; i < sectionStarts.length; i++) if ((sectionStarts[i]?.line ?? 0) <= line) index = i;
    return index;
  };

  visit(tree, (node: Nodes, _index, parent) => {
    const line = lineOf(node);
    switch (node.type) {
      case "link":
      case "image": {
        const url = (node as Link | Image).url;
        const text = node.type === "image" ? ((node as Image).alt ?? "") : toString(node).trim();
        links.push({ url, text, line, kind: classifyUrl(url), isImage: node.type === "image", section: sectionIndexForLine(line) });
        break;
      }
      case "code": {
        const code = node as Code;
        codeBlocks.push({ lang: code.lang ?? null, meta: code.meta ?? null, value: code.value, line, endLine: endLineOf(code), section: sectionIndexForLine(line) });
        break;
      }
      case "inlineCode": {
        const context = parent?.type === "tableCell" ? "table" : parent?.type === "heading" ? "heading" : "prose";
        inlineCode.push({ value: (node as MdInlineCode).value, line, section: sectionIndexForLine(line), context });
        break;
      }
      case "paragraph":
      case "heading":
      case "blockquote":
      case "listItem":
      case "tableRow": {
        if (node.type === "paragraph" && (parent?.type === "listItem" || parent?.type === "blockquote")) break;
        const kind = node.type === "tableRow" ? "tableRow" : node.type;
        const text = node.type === "tableRow" ? node.children.map((c) => toString(c)).join(" | ") : toString(node);
        textBlocks.push({ kind, text, line, endLine: endLineOf(node), section: sectionIndexForLine(line) });
        break;
      }
      case "html": {
        const value = node.value;
        const pragma = PRAGMA_RE.exec(value);
        if (pragma) {
          const rules = (pragma[2] ?? "").split(/[\s,]+/).filter(Boolean);
          ignores.push(pragma[1] ? { rules } : { rules, line: endLineOf(node) + 1 });
        }
        const snippet = SNIPPET_COMMENT_RE.exec(value);
        if (snippet?.[1]) snippets.push({ name: snippet[1], line });
        for (const match of value.matchAll(/\b(?:id|name)="([^"]+)"/g)) if (match[1]) anchors.add(match[1]);
        break;
      }
      case "mdxFlowExpression": {
        const pragma = PRAGMA_RE.exec(node.value);
        if (pragma) {
          const rules = (pragma[2] ?? "").split(/[\s,]+/).filter(Boolean);
          ignores.push(pragma[1] ? { rules } : { rules, line: endLineOf(node) + 1 });
        }
        break;
      }
      case "mdxJsxFlowElement":
      case "mdxJsxTextElement": {
        if (node.name === "Snippet") {
          const nameAttr = node.attributes.find((a) => a.type === "mdxJsxAttribute" && a.name === "name");
          if (nameAttr && typeof nameAttr.value === "string") snippets.push({ name: nameAttr.value, line });
        }
        for (const attr of node.attributes) {
          if (attr.type === "mdxJsxAttribute" && attr.name === "id" && typeof attr.value === "string") anchors.add(attr.value);
        }
        break;
      }
      default:
        break;
    }
  });

  // Resolve block pragmas to the block that follows them.
  const blockStarts = tree.children
    .filter((c) => c.type !== "yaml" && c.type !== "html" && c.type !== "mdxFlowExpression")
    .map((c) => ({ start: lineOf(c), end: endLineOf(c) }));
  for (const pragma of ignores) {
    if (pragma.line === undefined) continue;
    const target = blockStarts.find((b) => b.start >= (pragma.line ?? 0));
    if (target) {
      pragma.appliesToLine = target.start;
      pragma.appliesToEndLine = target.end;
    }
  }

  const totalLines = source.split("\n").length;
  const sections: Section[] = sectionStarts.map((s, index) => ({
    index,
    heading: s.heading,
    startLine: s.line,
    endLine: (sectionStarts[index + 1]?.line ?? totalLines + 1) - 1,
  }));

  const h1 = headings.find((h) => h.depth === 1);
  const fmTitle = typeof frontmatter.title === "string" ? frontmatter.title : undefined;
  const title = fmTitle ?? h1?.text ?? basename(path, extname(path)).replace(/[-_]/g, " ");

  return {
    path,
    format,
    source,
    contentHash: sha256Hex(source.replace(/\r\n/g, "\n")),
    frontmatter,
    frontmatterError,
    title,
    pageType: normalizePageType(frontmatter.type, options.defaultPageType ?? "guide"),
    headings,
    anchors,
    links,
    codeBlocks,
    inlineCode,
    textBlocks,
    sections,
    snippets,
    ignores,
    wordCount: textBlocks.reduce((n, b) => n + (b.text.match(/\S+/g)?.length ?? 0), 0),
    tree,
  };
}

/** Is `ruleId` suppressed at `line` by an inline pragma? Supports `group/*`-style prefixes. */
export function isIgnored(page: ParsedPage, ruleId: string, line?: number): boolean {
  return page.ignores.some((p) => {
    const matches = p.rules.some((r) => r === ruleId || r === "all" || (r.endsWith("/*") && ruleId.startsWith(r.slice(0, -1))) || ruleId.startsWith(`${r}/`));
    if (!matches) return false;
    if (p.line === undefined) return true;
    if (line === undefined || p.appliesToLine === undefined) return false;
    return line >= p.appliesToLine && line <= (p.appliesToEndLine ?? p.appliesToLine);
  });
}

export function frontmatterList(page: ParsedPage, key: string): string[] {
  const value = page.frontmatter[key];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return [value];
  return [];
}
