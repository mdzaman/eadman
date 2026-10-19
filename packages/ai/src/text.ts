/**
 * Small, deterministic text helpers shared by chunking, retrieval, verification and
 * the eval harness. No model or locale data: everything here is reproducible.
 */

/** Collapse every whitespace run to one space and trim. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Token estimate used for chunk budgets: ceil(chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** True when `needle` is a verbatim substring of `haystack` after whitespace normalization. */
export function containsVerbatim(haystack: string, needle: string): boolean {
  const n = normalizeWhitespace(needle);
  if (n.length === 0) return false;
  return normalizeWhitespace(haystack).includes(n);
}

/**
 * Locate `needle` in `haystack`, tolerating whitespace differences (a sentence that
 * wraps across lines in the source but is quoted on one line). Returns the offset of
 * the match in the original `haystack`, or -1.
 */
export function findVerbatim(haystack: string, needle: string): number {
  const exact = haystack.indexOf(needle);
  if (exact >= 0 && needle.length > 0) return exact;
  const target = normalizeWhitespace(needle);
  if (target.length === 0) return -1;
  // Build the normalized haystack with a map back to original offsets.
  let normalized = "";
  const offsets: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < haystack.length; i++) {
    const ch = haystack[i] as string;
    if (/\s/.test(ch)) {
      if (normalized.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      normalized += " ";
      offsets.push(i);
      pendingSpace = false;
    }
    normalized += ch;
    offsets.push(i);
  }
  const index = normalized.indexOf(target);
  return index < 0 ? -1 : (offsets[index] ?? -1);
}

const STOPWORDS = new Set(
  (
    "a an the and or but if then else of at by for with about against between into through during before after " +
    "above below to from up down in out on off over under again further once here there where why how when what " +
    "which who whom whose all any both each few more most other some such no nor not only own same so than too very " +
    "can could will would should shall may might must just now i me my myself we us our ours you your yours he him " +
    "his she her it its they them their this that these those am is are was were be been being have has had having " +
    "do does did doing done get gets got as until while many much also s t don doesn isn aren cannot"
  ).split(" "),
);

/** Lowercased word tokens; camelCase and snake_case identifiers are split into parts. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/** A light suffix-stripping stemmer: enough to match plural, -ed and -ing forms. */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3 || /^\p{N}+$/u.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) {
    w = w.slice(0, -2);
    if (w.endsWith("i")) w = `${w.slice(0, -1)}y`;
  }
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  return w;
}

/** Content terms: tokens without stopwords, stemmed. Used by BM25, embeddings and the sufficiency gate. */
export function contentTerms(text: string): string[] {
  const out: string[] = [];
  for (const token of tokenize(text)) {
    if (STOPWORDS.has(token)) continue;
    out.push(stem(token));
  }
  return out;
}

/**
 * Lexical coverage of a question by a text: the share of the question's distinct
 * content terms that occur in the text. Terms in `ignore` (for example the product
 * name, which every question implies) are left out unless nothing else remains.
 */
export function termCoverage(question: string, text: string, ignore: Iterable<string> = []): number {
  const ignored = new Set([...ignore].flatMap((value) => contentTerms(value)));
  const all = [...new Set(contentTerms(question))];
  const focused = all.filter((t) => !ignored.has(t));
  const terms = focused.length > 0 ? focused : all;
  if (terms.length === 0) return 0;
  const present = new Set(contentTerms(text));
  return terms.filter((t) => present.has(t)).length / terms.length;
}

/** Count words that contain a letter or digit (markup and markers are not words). */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** 32-bit FNV-1a over UTF-16 code units. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
