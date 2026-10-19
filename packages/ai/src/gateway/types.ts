/**
 * LLM gateway contracts (docs/07-ai-design.md §5). Every provider implements the
 * two generation modes in its strongest native way: grounded answers with
 * citations, and schema-constrained JSON for drift verification and patches.
 */

export type Effort = "low" | "medium" | "high";

/** One retrieved source handed to the model as data (never as instructions). */
export interface SourceDoc {
  /** "S1", "S2", ... in rank order. */
  id: string;
  /** Breadcrumb and version, e.g. "Refund a payment › Partial refunds (v2.4)". */
  title: string;
  /** Page URL with anchor; context only, not citable. */
  url: string;
  /** The exact chunk text; quotes are verified against it. */
  text: string;
}

export interface CitedGenerationRequest {
  system: string;
  question: string;
  sources: SourceDoc[];
  effort?: Effort;
  maxTokens?: number;
}

export interface CitedSegment {
  text: string;
  citations: Array<{ sourceId: string; quote: string; start?: number; end?: number }>;
}

export interface ModelRef {
  provider: string;
  model: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CitedGenerationResult {
  status: "answered" | "not_documented" | "refused" | "error";
  segments: CitedSegment[];
  model: ModelRef;
  usage?: TokenUsage;
  error?: string;
}

export interface StructuredGenerationRequest {
  system: string;
  prompt: string;
  /** JSON Schema (draft 2020-12 subset): `additionalProperties: false` on every object, no min/max constraints. */
  schema: Record<string, unknown>;
  schemaName: string;
  effort?: Effort;
  maxTokens?: number;
}

export interface StructuredGenerationResult<T> {
  status: "ok" | "refused" | "invalid" | "error";
  value?: T;
  model: ModelRef;
  usage?: TokenUsage;
  error?: string;
}

export interface LlmProvider {
  /** "anthropic", "openai-compatible", "mock". */
  readonly id: string;
  readonly model: string;
  generateWithCitations(req: CitedGenerationRequest): Promise<CitedGenerationResult>;
  generateStructured<T>(req: StructuredGenerationRequest): Promise<StructuredGenerationResult<T>>;
}

export interface EmbeddingProvider {
  readonly id: string;
  /** Must match the dimension of the index (chunks.embedding). */
  readonly dimensions: number;
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

/** The fixed abstention token every answer template instructs the model to use. */
export const NOT_DOCUMENTED = "NOT_DOCUMENTED";
