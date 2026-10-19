import type { List, Nodes, RootContent } from "mdast";
import { toString } from "mdast-util-to-string";
import { sha256Hex } from "@docops/core";
import type { ParsedPage } from "@docops/markdown";
import { estimateTokens, normalizeWhitespace } from "../text.ts";

/** One retrievable unit of a page revision, with the ACL tags that gate it. */
export interface Chunk {
  /** sha256(pagePath, anchor, normalized text), first 32 hex chars. */
  id: string;
  pagePath: string;
  title: string;
  /** "Title › H2 › H3". */
  headingPath: string;
  anchor: string | null;
  url: string;
  /** Breadcrumb line, a blank line, then the section's Markdown. */
  text: string;
  tokenEstimate: number;
  version: string;
  audience: string;
  /** Readers of this chunk; visible iff it intersects the asker's principal set. */
  aclPrincipals: string[];
  contentHash: string;
  stale?: boolean;
}

export interface ChunkMeta {
  url: string;
  version: string;
  audience: string;
  aclPrincipals: string[];
  stale?: boolean;
}

export interface ChunkOptions {
  minTokens?: number;
  maxTokens?: number;
}

interface Block {
  text: string;
  /** Code, tables, admonitions, HTML and JSX are never split. */
  atomic: boolean;
  /** For splittable blocks: the pieces to split into when the block alone is too large. */
  parts?: string[];
}

interface SectionDraft {
  headings: string[];
  anchor: string | null;
  blocks: Block[];
}

const SEPARATOR = " › ";

/** "2.4" → "v2.4"; "v2.4" and "latest" stay as they are. */
export function versionLabel(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}

/** `Title › H2 › H3 (v2.4)`: prefixed to every chunk and used as the citation label. */
export function breadcrumb(title: string, headings: string[], version: string): string {
  const path = [title, ...headings].join(SEPARATOR);
  return version ? `${path} (${versionLabel(version)})` : path;
}

/**
 * Heading-aware chunking (docs/07 §2.1). Sections split on H2/H3 and are never merged
 * across headings, so every chunk has one precise anchor. A section larger than
 * `maxTokens` is split between blocks (paragraphs, list items), never inside a fenced
 * code block, table, admonition or HTML block; `minTokens` keeps the last piece of a
 * split section from being a tiny fragment. Tokens are estimated as ceil(chars / 4).
 */
export function chunkPage(page: ParsedPage, meta: ChunkMeta, opts: ChunkOptions = {}): Chunk[] {
  const maxTokens = opts.maxTokens ?? 800;
  const minTokens = Math.min(opts.minTokens ?? 300, maxTokens);
  const source = page.source;
  const slice = (node: Nodes): string => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const raw = start === undefined || end === undefined ? toString(node) : source.slice(start, end);
    return raw.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  };
  const headingByLine = new Map(page.headings.map((h) => [h.line, h]));

  const sections: SectionDraft[] = [];
  let current: SectionDraft = { headings: [], anchor: null, blocks: [] };
  let h2: string | null = null;
  const flush = () => {
    if (current.blocks.length > 0) sections.push(current);
  };

  for (const node of page.tree.children as RootContent[]) {
    if (node.type === "heading" && node.depth <= 3) {
      if (node.depth === 1) continue; // the page title is already in the breadcrumb
      flush();
      const heading = headingByLine.get(node.position?.start.line ?? -1);
      const text = heading?.text ?? toString(node).trim();
      const anchor = heading?.anchor ?? null;
      if (node.depth === 2) {
        h2 = text;
        current = { headings: [text], anchor, blocks: [] };
      } else {
        current = { headings: h2 === null ? [text] : [h2, text], anchor, blocks: [] };
      }
      continue;
    }
    const block = toBlock(node, slice);
    if (block) current.blocks.push(block);
  }
  flush();

  const chunks: Chunk[] = [];
  const seen = new Map<string, number>();
  for (const section of sections) {
    const crumb = breadcrumb(page.title, section.headings, meta.version);
    const budget = Math.max(maxTokens - estimateTokens(`${crumb}\n\n`), 1);
    for (const part of pack(section.blocks, budget, minTokens)) {
      const text = `${crumb}\n\n${part.join("\n\n")}`;
      const base = sha256Hex([page.path, section.anchor ?? "", normalizeWhitespace(text)].join("\u001f")).slice(0, 32);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const id = n === 0 ? base : sha256Hex(`${base}\u001f${n}`).slice(0, 32);
      chunks.push({
        id,
        pagePath: page.path,
        title: page.title,
        headingPath: [page.title, ...section.headings].join(SEPARATOR),
        anchor: section.anchor,
        url: meta.url,
        text,
        tokenEstimate: estimateTokens(text),
        version: meta.version,
        audience: meta.audience,
        aclPrincipals: [...meta.aclPrincipals],
        contentHash: sha256Hex(text),
        stale: meta.stale === true,
      });
    }
  }
  return chunks;
}

function toBlock(node: RootContent, slice: (node: Nodes) => string): Block | null {
  switch (node.type) {
    case "yaml":
    case "definition":
    case "thematicBreak":
    case "mdxjsEsm":
    case "mdxFlowExpression":
      return null;
    case "html": {
      // Comments (pragmas, snippet markers) are not content.
      if (/^\s*<!--[\s\S]*-->\s*$/.test(node.value)) return null;
      return { text: slice(node), atomic: true };
    }
    case "paragraph": {
      const text = slice(node);
      return { text, atomic: false, parts: splitSentences(text) };
    }
    case "list": {
      const list = node as List;
      return { text: slice(node), atomic: false, parts: list.children.map((item) => slice(item)) };
    }
    case "heading": // H4 and deeper stay inside their section
      return { text: slice(node), atomic: false };
    default:
      // code, table, blockquote (admonitions), mdxJsxFlowElement, footnoteDefinition, ...
      return { text: slice(node), atomic: true };
  }
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}`*_[(])/u).filter((s) => s.length > 0);
}

/** Greedy packing into parts of at most `budget` tokens, then rebalance a small tail. */
function pack(blocks: Block[], budget: number, minTokens: number): string[][] {
  const pieces: string[] = [];
  for (const block of blocks) {
    if (block.atomic || estimateTokens(block.text) <= budget || !block.parts || block.parts.length < 2) pieces.push(block.text);
    else pieces.push(...block.parts);
  }
  const size = (part: string[]) => estimateTokens(part.join("\n\n"));
  const parts: string[][] = [];
  let current: string[] = [];
  for (const piece of pieces) {
    if (current.length > 0 && size([...current, piece]) > budget) {
      parts.push(current);
      current = [];
    }
    current.push(piece);
  }
  if (current.length > 0) parts.push(current);

  // Move trailing pieces of the previous part into a too-small last part while both stay sensible.
  if (parts.length >= 2) {
    const last = parts[parts.length - 1] as string[];
    const prev = parts[parts.length - 2] as string[];
    while (prev.length > 1 && size(last) < minTokens) {
      const candidate = prev[prev.length - 1] as string;
      if (size([candidate, ...last]) > budget || size(prev.slice(0, -1)) < minTokens) break;
      prev.pop();
      last.unshift(candidate);
    }
  }
  return parts;
}
