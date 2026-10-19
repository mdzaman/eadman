import { contentTerms } from "../text.ts";
import type { Chunk } from "./chunk.ts";

export interface SearchHit {
  chunk: Chunk;
  /** Reciprocal Rank Fusion score, × 0.7 for stale chunks. */
  score: number;
  keywordRank?: number;
  vectorRank?: number;
  /** BM25 score (0 when no query term matches). */
  keywordScore: number;
  /** Cosine similarity of query and chunk embeddings. */
  vectorScore: number;
}

export interface SearchQuery {
  text: string;
  embedding: number[];
  /** The asker's principal set. Mandatory: an empty set is rejected. */
  principals: string[];
  /** Hard filter when given. */
  version?: string;
  /** Hard filter when given. */
  audience?: string;
  /** Maximum hits returned (default 50). */
  k?: number;
}

export interface SearchBackend {
  index(chunks: Chunk[], embeddings: number[][]): Promise<void>;
  removePage(pagePath: string): Promise<void>;
  query(q: SearchQuery): Promise<SearchHit[]>;
}

export const RRF_K = 60;
export const STALE_WEIGHT = 0.7;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const LIST_DEPTH = 50;

interface Entry {
  chunk: Chunk;
  embedding: number[];
  norm: number;
  tf: Map<string, number>;
  length: number;
}

/** Throws unless `principals` is a non-empty list of non-empty strings. */
export function assertPrincipals(principals: readonly string[] | undefined): asserts principals is string[] {
  if (!Array.isArray(principals) || principals.length === 0 || principals.some((p) => typeof p !== "string" || p.length === 0)) {
    throw new Error("search requires a non-empty principal set");
  }
}

/** A chunk is visible iff its ACL tags intersect the principal set. */
export function isVisible(chunk: Pick<Chunk, "aclPrincipals">, principals: readonly string[]): boolean {
  const set = new Set(principals);
  return chunk.aclPrincipals.some((p) => set.has(p));
}

/**
 * Hybrid retrieval in memory: BM25 (k1 1.2, b 0.75) and cosine similarity, each
 * top-50, fused with Reciprocal Rank Fusion (k = 60). The ACL, version and audience
 * filters run BEFORE ranking, and BM25 statistics are computed over the visible
 * candidates only, so neither ranks, scores nor counts depend on content the asker
 * cannot read.
 */
export class InMemorySearchBackend implements SearchBackend {
  private readonly entries = new Map<string, Entry>();
  private dimensions: number | null = null;

  get size(): number {
    return this.entries.size;
  }

  /** Adds or replaces chunks by id. All-or-nothing: the batch is validated before anything is stored. */
  async index(chunks: Chunk[], embeddings: number[][]): Promise<void> {
    if (chunks.length !== embeddings.length) throw new Error(`index: ${chunks.length} chunks but ${embeddings.length} embeddings`);
    const dimensions = this.dimensions ?? embeddings[0]?.length ?? null;
    chunks.forEach((chunk, i) => {
      const embedding = embeddings[i] as number[];
      if (embedding.length !== dimensions || dimensions === 0) {
        throw new Error(`index: embedding for chunk ${chunk.id} has ${embedding.length} dimensions, expected ${dimensions}`);
      }
      // A chunk without readers would be invisible at best and a policy bug at worst.
      if (chunk.aclPrincipals.length === 0) throw new Error(`index: chunk ${chunk.id} has no ACL principals`);
    });
    this.dimensions = dimensions;
    chunks.forEach((chunk, i) => {
      const embedding = embeddings[i] as number[];
      const tf = new Map<string, number>();
      const terms = contentTerms(chunk.text);
      for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
      this.entries.set(chunk.id, { chunk, embedding, norm: Math.hypot(...embedding), tf, length: terms.length });
    });
  }

  async removePage(pagePath: string): Promise<void> {
    for (const [id, entry] of this.entries) if (entry.chunk.pagePath === pagePath) this.entries.delete(id);
  }

  async query(q: SearchQuery): Promise<SearchHit[]> {
    assertPrincipals(q.principals);
    if (this.dimensions !== null && q.embedding.length !== this.dimensions) {
      throw new Error(`query embedding has ${q.embedding.length} dimensions, expected ${this.dimensions}`);
    }
    const principals = new Set(q.principals);
    const k = q.k ?? LIST_DEPTH;

    // 1. Filter first: everything below sees only what this principal set may read.
    const candidates: Entry[] = [];
    for (const entry of this.entries.values()) {
      const { chunk } = entry;
      if (!chunk.aclPrincipals.some((p) => principals.has(p))) continue;
      if (q.version !== undefined && chunk.version !== q.version) continue;
      if (q.audience !== undefined && chunk.audience !== q.audience) continue;
      candidates.push(entry);
    }
    if (candidates.length === 0 || k <= 0) return [];

    // 2. BM25 over the candidates.
    const queryTerms = [...new Set(contentTerms(q.text))];
    const n = candidates.length;
    const avgLength = candidates.reduce((sum, e) => sum + e.length, 0) / n || 1;
    const idf = new Map<string, number>();
    for (const term of queryTerms) {
      const df = candidates.reduce((count, e) => count + (e.tf.has(term) ? 1 : 0), 0);
      idf.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
    }
    const keyword = new Map<string, number>();
    const vector = new Map<string, number>();
    const queryNorm = Math.hypot(...q.embedding);
    for (const entry of candidates) {
      let score = 0;
      for (const term of queryTerms) {
        const tf = entry.tf.get(term);
        if (!tf) continue;
        score += ((idf.get(term) ?? 0) * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * entry.length) / avgLength));
      }
      keyword.set(entry.chunk.id, score);
      // 3. Cosine similarity.
      let dot = 0;
      for (let i = 0; i < q.embedding.length; i++) dot += (q.embedding[i] ?? 0) * (entry.embedding[i] ?? 0);
      vector.set(entry.chunk.id, queryNorm === 0 || entry.norm === 0 ? 0 : dot / (queryNorm * entry.norm));
    }

    // 4. Top-50 per list, fused with RRF.
    const byScore = (scores: Map<string, number>) => (a: Entry, b: Entry) =>
      (scores.get(b.chunk.id) ?? 0) - (scores.get(a.chunk.id) ?? 0) || (a.chunk.id < b.chunk.id ? -1 : 1);
    const keywordList = candidates.filter((e) => (keyword.get(e.chunk.id) ?? 0) > 0).sort(byScore(keyword)).slice(0, LIST_DEPTH);
    const vectorList = candidates.filter((e) => (vector.get(e.chunk.id) ?? 0) > 0).sort(byScore(vector)).slice(0, LIST_DEPTH);

    const hits = new Map<string, SearchHit>();
    const hitFor = (entry: Entry): SearchHit => {
      let hit = hits.get(entry.chunk.id);
      if (!hit) {
        hit = { chunk: entry.chunk, score: 0, keywordScore: keyword.get(entry.chunk.id) ?? 0, vectorScore: vector.get(entry.chunk.id) ?? 0 };
        hits.set(entry.chunk.id, hit);
      }
      return hit;
    };
    keywordList.forEach((entry, i) => {
      const hit = hitFor(entry);
      hit.keywordRank = i + 1;
      hit.score += 1 / (RRF_K + i + 1);
    });
    vectorList.forEach((entry, i) => {
      const hit = hitFor(entry);
      hit.vectorRank = i + 1;
      hit.score += 1 / (RRF_K + i + 1);
    });

    // 5. Freshness: stale chunks are down-weighted.
    for (const hit of hits.values()) if (hit.chunk.stale) hit.score *= STALE_WEIGHT;

    return [...hits.values()]
      .sort((a, b) => b.score - a.score || (a.chunk.id < b.chunk.id ? -1 : 1))
      .slice(0, k);
  }
}
