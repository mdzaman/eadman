import { NOT_DOCUMENTED, type EmbeddingProvider, type LlmProvider, type ModelRef, type SourceDoc } from "../gateway/types.ts";
import { loadPrompt, renderPrompt } from "../prompts.ts";
import { containsVerbatim, normalizeWhitespace, termCoverage, wordCount } from "../text.ts";
import { versionLabel, type Chunk } from "./chunk.ts";
import { filterAnswerMarkdown } from "./output-filter.ts";
import { assertPrincipals, type SearchBackend, type SearchHit } from "./search.ts";

export interface Citation {
  /** "S1", matching the [S1] marker in the answer. */
  id: string;
  pagePath: string;
  title: string;
  /** Chunk URL plus `#anchor`. */
  url: string;
  /** Verbatim from the cited chunk. Render as plain text, never as Markdown. */
  quote: string;
  version: string;
  /** The cited page references changed entities: show a "may be outdated" badge. */
  stale: boolean;
  chunkId?: string;
}

export interface Answer {
  status: "answered" | "partial" | "not_documented" | "refused" | "error";
  /** Markdown with [S1] citation markers. Empty unless answered or partial. */
  answer: string;
  citations: Citation[];
  retrievedChunkIds: string[];
  model?: ModelRef & { promptVersion?: string };
  /** Diagnostics for logs: counts and ids only, never source or answer content. */
  notes: string[];
}

export interface AskQuery {
  question: string;
  principals: string[];
  version?: string;
  audience?: string;
}

export interface AnswerServiceOptions {
  search: SearchBackend;
  embeddings: EmbeddingProvider;
  provider: LlmProvider;
  productName: string;
  /** Minimum lexical relevance of the best source (0..1). Default 0.5; calibrate per tenant on the eval set. */
  sufficiencyThreshold?: number;
  /** Sources sent to the model (default 8). */
  maxSources?: number;
  /** Hostnames whose https links may appear in answers, in addition to links found in cited chunks. */
  linkAllowlist?: string[];
  /** Live policy check; a page that fails it is never sent to the model and never cited. */
  liveAcl?: (pagePath: string, principals: string[]) => boolean | Promise<boolean>;
  /** Pin a version of the `answer` template (default: the latest file). */
  promptVersion?: string;
  /** Upper bound on the summed token estimate of the sources (default 6000). */
  contextTokenBudget?: number;
}

const RETRIEVAL_DEPTH = 50;

/**
 * Ask-the-docs (docs/07 §2): permission-filtered hybrid retrieval, a sufficiency gate
 * that answers "not documented" without calling a model, generation with citations,
 * and verification of everything the model returns before it renders.
 *
 * Sufficiency gate (deterministic): for each of the top `maxSources` hits with a BM25
 * score > 0, relevance = the share of the question's distinct content terms (stopwords
 * removed, stemmed, product-name terms ignored) that occur in the chunk text. The
 * question is answerable iff the best relevance is >= `sufficiencyThreshold`.
 */
export class AnswerService {
  private readonly search: SearchBackend;
  private readonly embeddings: EmbeddingProvider;
  private readonly provider: LlmProvider;
  private readonly productName: string;
  private readonly threshold: number;
  private readonly maxSources: number;
  private readonly linkAllowlist: string[];
  private readonly liveAcl: AnswerServiceOptions["liveAcl"];
  private readonly promptVersion: string | undefined;
  private readonly contextTokenBudget: number;

  constructor(opts: AnswerServiceOptions) {
    this.search = opts.search;
    this.embeddings = opts.embeddings;
    this.provider = opts.provider;
    this.productName = opts.productName;
    this.threshold = opts.sufficiencyThreshold ?? 0.5;
    this.maxSources = opts.maxSources ?? 8;
    this.linkAllowlist = opts.linkAllowlist ?? [];
    this.liveAcl = opts.liveAcl;
    this.promptVersion = opts.promptVersion;
    this.contextTokenBudget = opts.contextTokenBudget ?? 6000;
    if (!(this.threshold >= 0 && this.threshold <= 1)) throw new RangeError("sufficiencyThreshold must be between 0 and 1");
    if (!Number.isInteger(this.maxSources) || this.maxSources < 1) throw new RangeError("maxSources must be a positive integer");
  }

  async ask(q: AskQuery): Promise<Answer> {
    assertPrincipals(q.principals);
    const notes: string[] = [];
    const question = q.question.trim();
    if (question.length === 0) return notDocumented([], ["empty question"]);

    // 1. Retrieve with the asker's principals (the filter runs inside the index query).
    const [embedding] = await this.embeddings.embed([question], "query");
    if (!embedding) throw new Error(`embedding provider ${this.embeddings.id} returned no vector`);
    const hits = await this.search.query({
      text: question,
      embedding,
      principals: q.principals,
      version: q.version,
      audience: q.audience,
      k: RETRIEVAL_DEPTH,
    });
    const top = hits.slice(0, this.maxSources);
    const retrievedChunkIds = top.map((h) => h.chunk.id);
    notes.push(`retrieved ${hits.length} chunk(s), considered ${top.length}`);

    // 2. Sufficiency gate: no model call without evidence.
    const best = this.bestRelevance(question, top);
    notes.push(`sufficiency ${best.toFixed(2)} (threshold ${this.threshold})`);
    if (best < this.threshold) return notDocumented(retrievedChunkIds, [...notes, "below sufficiency threshold: no model call"]);

    // 3. Live ACL: the model never sees a page the asker lost access to after indexing.
    const allowed: SearchHit[] = [];
    const livePages = new Map<string, boolean>();
    for (const hit of top) {
      const page = hit.chunk.pagePath;
      if (!livePages.has(page)) livePages.set(page, await this.isLiveAllowed(page, q.principals));
      if (livePages.get(page)) allowed.push(hit);
    }
    const excluded = [...livePages.values()].filter((ok) => !ok).length;
    if (excluded > 0) notes.push(`live ACL excluded ${excluded} page(s) before generation`);

    // 4. Context budget, in rank order; the gate must still hold for what is actually sent.
    const selected: SearchHit[] = [];
    let used = 0;
    for (const hit of allowed) {
      if (selected.length > 0 && used + hit.chunk.tokenEstimate > this.contextTokenBudget) continue;
      selected.push(hit);
      used += hit.chunk.tokenEstimate;
    }
    if (this.bestRelevance(question, selected) < this.threshold) {
      return notDocumented(retrievedChunkIds, [...notes, "below sufficiency threshold after live ACL and context budget: no model call"]);
    }

    // 5. Generate with citations. Sources are data (document blocks or delimited elements).
    const sources: SourceDoc[] = selected.map((hit, i) => ({
      id: `S${i + 1}`,
      title: `${hit.chunk.headingPath} (${versionLabel(hit.chunk.version)})`,
      url: citationUrl(hit.chunk),
      text: hit.chunk.text,
    }));
    const prompt = loadPrompt("answer", this.promptVersion);
    const version = q.version ?? ([...new Set(selected.map((h) => h.chunk.version))].sort().join(", ") || "latest");
    const system = renderPrompt(prompt.text, { product_name: this.productName, version });
    notes.push(`prompt ${prompt.id}@v${prompt.version}, ${sources.length} source(s)`);
    const result = await this.provider.generateWithCitations({ system, question, sources, effort: prompt.effort });
    const model = { ...result.model, promptVersion: prompt.version };

    if (result.status === "refused") {
      return { status: "refused", answer: "", citations: [], retrievedChunkIds, model, notes: [...notes, result.error ?? "refused"] };
    }
    if (result.status === "error") {
      return { status: "error", answer: "", citations: [], retrievedChunkIds, model, notes: [...notes, `provider error: ${result.error ?? "unknown"}`] };
    }
    if (result.status === "not_documented" || result.segments.map((s) => s.text).join("").trim() === NOT_DOCUMENTED) {
      return notDocumented(retrievedChunkIds, [...notes, "model abstained"], model);
    }

    // 6. Verify every citation: known source and a verbatim quote.
    const chunkBySource = new Map(sources.map((s, i) => [s.id, (selected[i] as SearchHit).chunk]));
    const segments = result.segments.map((segment) => {
      const cites: Array<{ chunk: Chunk; quote: string }> = [];
      for (const citation of segment.citations) {
        const chunk = chunkBySource.get(citation.sourceId);
        if (!chunk) {
          notes.push(`dropped citation to unknown source ${citation.sourceId}`);
        } else if (!quoteIsVerbatim(chunk.text, citation)) {
          notes.push(`dropped citation ${citation.sourceId}: quote not found in source`);
        } else {
          cites.push({ chunk, quote: citation.quote });
        }
      }
      return { text: segment.text, cites };
    });

    // 7. Live ACL re-check of cited pages, right before rendering.
    if (this.liveAcl) {
      const cited = [...new Set(segments.flatMap((s) => s.cites.map((c) => c.chunk.pagePath)))];
      const revoked = new Set<string>();
      for (const page of cited) if (!(await this.isLiveAllowed(page, q.principals))) revoked.add(page);
      if (revoked.size > 0) {
        for (const segment of segments) segment.cites = segment.cites.filter((c) => !revoked.has(c.chunk.pagePath));
        notes.push(`live ACL re-check removed citations to ${revoked.size} page(s)`);
      }
    }

    // 8. Sentence coverage: factual text without a valid citation is removed.
    const kept = segments.filter((s) => s.cites.length > 0 || isConnective(s.text));
    const removed = segments.length - kept.length;
    if (removed > 0) notes.push(`removed ${removed} uncited segment(s)`);
    if (!kept.some((s) => s.cites.length > 0)) return notDocumented(retrievedChunkIds, [...notes, "no verified citations"], model);

    // 9. Render [S1] markers; one citation per distinct (chunk, quote).
    const citations: Citation[] = [];
    const citedChunks = new Map<string, Chunk>();
    const ids = new Map<string, string>();
    let markdown = "";
    for (const original of kept) {
      // Markers are DocOps's to place: drop any the model wrote itself (they are unverified).
      const segment = { ...original, text: original.text.replace(/[ \t]*\[S\d+\](?![(:[])/g, "") };
      if (segment.cites.length === 0) {
        markdown += segment.text;
        continue;
      }
      const markers: string[] = [];
      for (const { chunk, quote } of segment.cites) {
        const key = `${chunk.id}\u0000${normalizeWhitespace(quote)}`;
        let id = ids.get(key);
        if (id === undefined) {
          id = `S${citations.length + 1}`;
          ids.set(key, id);
          citedChunks.set(chunk.id, chunk);
          citations.push({
            id,
            pagePath: chunk.pagePath,
            title: chunk.headingPath,
            url: citationUrl(chunk),
            quote,
            version: chunk.version,
            stale: chunk.stale === true,
            chunkId: chunk.id,
          });
        }
        if (!markers.includes(id)) markers.push(id);
      }
      const body = segment.text.replace(/\s+$/, "");
      markdown += `${body}${body.length > 0 ? " " : ""}${markers.map((m) => `[${m}]`).join("")}${segment.text.slice(body.length)}`;
    }

    // 10. Output filter: no images, no raw HTML, links only to allowlisted or cited destinations.
    const citedTexts = [...citedChunks.values()].map((chunk) => chunk.text);
    const filtered = filterAnswerMarkdown(markdown, { allowHosts: this.linkAllowlist, citedTexts });
    if (filtered.removedImages + filtered.removedHtml + filtered.rewrittenLinks + filtered.removedDefinitions > 0) {
      notes.push(
        `output filter removed ${filtered.removedImages} image(s), ${filtered.removedHtml} HTML node(s), ` +
          `${filtered.removedDefinitions} definition(s) and rewrote ${filtered.rewrittenLinks} link(s)`,
      );
    }
    const answer = filtered.markdown.trim();
    const rendered = citations.filter((c) => answer.includes(`[${c.id}]`));
    if (answer.length === 0 || rendered.length === 0) return notDocumented(retrievedChunkIds, [...notes, "nothing left after output filtering"], model);

    return { status: removed > 0 ? "partial" : "answered", answer, citations: rendered, retrievedChunkIds, model, notes };
  }

  private bestRelevance(question: string, hits: SearchHit[]): number {
    let best = 0;
    for (const hit of hits) {
      if (hit.keywordScore <= 0) continue;
      best = Math.max(best, termCoverage(question, hit.chunk.text, [this.productName]));
    }
    return best;
  }

  private async isLiveAllowed(pagePath: string, principals: string[]): Promise<boolean> {
    if (!this.liveAcl) return true;
    return (await this.liveAcl(pagePath, principals)) === true;
  }
}

export function citationUrl(chunk: Pick<Chunk, "url" | "anchor">): string {
  return chunk.anchor ? `${chunk.url}#${chunk.anchor}` : chunk.url;
}

/** Exact at the given offsets, or verbatim after whitespace normalization. */
function quoteIsVerbatim(text: string, citation: { quote: string; start?: number; end?: number }): boolean {
  if (normalizeWhitespace(citation.quote).length < 3) return false;
  if (citation.start !== undefined && citation.end !== undefined && text.slice(citation.start, citation.end) === citation.quote) return true;
  return containsVerbatim(text, citation.quote);
}

/** Connective text may stay uncited: shorter than 4 words, or introducing what follows (ends with ':'). */
export function isConnective(text: string): boolean {
  const plain = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[S\d+\]/g, "")
    .replace(/[*_`#>|]/g, " ")
    .trim();
  if (plain.length === 0 || plain.endsWith(":")) return true;
  return wordCount(plain) < 4;
}

function notDocumented(retrievedChunkIds: string[], notes: string[], model?: Answer["model"]): Answer {
  const answer: Answer = { status: "not_documented", answer: "", citations: [], retrievedChunkIds, notes };
  if (model) answer.model = model;
  return answer;
}
