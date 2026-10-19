import { contentTerms, fnv1a } from "../text.ts";
import type { EmbeddingProvider } from "./types.ts";

/**
 * Deterministic feature-hashing embeddings (signed hashing trick over stemmed
 * unigrams and bigrams, L2-normalized). No model, no network: for tests, offline
 * evals and air-gapped smoke runs. Similarity is lexical, not semantic.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;

  constructor(opts: { dimensions?: number } = {}) {
    const dimensions = opts.dimensions ?? 256;
    if (!Number.isInteger(dimensions) || dimensions < 8) throw new RangeError("dimensions must be an integer >= 8");
    this.dimensions = dimensions;
    this.id = `hashing-${dimensions}`;
  }

  async embed(texts: string[], _kind: "document" | "query"): Promise<number[][]> {
    return texts.map((text) => this.vector(text));
  }

  private vector(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const terms = contentTerms(text);
    const counts = new Map<string, { tf: number; weight: number }>();
    const add = (feature: string, weight: number) => {
      const entry = counts.get(feature);
      if (entry) entry.tf++;
      else counts.set(feature, { tf: 1, weight });
    };
    for (let i = 0; i < terms.length; i++) {
      add(terms[i] as string, 1);
      if (i + 1 < terms.length) add(`${terms[i]} ${terms[i + 1]}`, 0.5);
    }
    for (const [feature, { tf, weight }] of counts) {
      const hash = fnv1a(feature);
      const index = hash % this.dimensions;
      const sign = (fnv1a(`±${feature}`) & 1) === 1 ? 1 : -1;
      vector[index] = (vector[index] ?? 0) + sign * weight * (1 + Math.log(tf));
    }
    const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
    return norm === 0 ? vector : vector.map((x) => x / norm);
  }
}

export interface TeiEmbeddingProviderOptions {
  /** e.g. http://tei.internal:8080 (no trailing /embed). */
  baseUrl: string;
  /** 1024 for BGE-M3. */
  dimensions?: number;
  /** Max inputs per request (TEI's --max-client-batch-size). */
  batchSize?: number;
  id?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/**
 * Hugging Face text-embeddings-inference (self-hosted, no egress):
 * `POST {baseUrl}/embed` with `{ inputs: string[] }` returns `number[][]`.
 */
export class TeiEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly batchSize: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TeiEmbeddingProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.dimensions = opts.dimensions ?? 1024;
    this.batchSize = Math.max(1, opts.batchSize ?? 32);
    this.id = opts.id ?? `tei-${this.dimensions}`;
    this.headers = { "content-type": "application/json", ...opts.headers };
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  async embed(texts: string[], _kind: "document" | "query"): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const response = await this.fetchImpl(`${this.baseUrl}/embed`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ inputs: batch }),
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 200);
        throw new Error(`TEI embed failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      const vectors = (await response.json()) as unknown;
      if (!Array.isArray(vectors) || vectors.length !== batch.length) {
        throw new Error(`TEI embed returned ${Array.isArray(vectors) ? vectors.length : "no"} vectors for ${batch.length} inputs`);
      }
      for (const vector of vectors) {
        if (!Array.isArray(vector) || vector.length !== this.dimensions || !vector.every((x) => typeof x === "number")) {
          throw new Error(`TEI embed returned a vector that is not ${this.dimensions}-dimensional`);
        }
        out.push(vector as number[]);
      }
    }
    return out;
  }
}
