// @docops/ai: the governed AI layer (docs/07-ai-design.md).
export * from "./gateway/types.ts";
export * from "./gateway/anthropic.ts";
export * from "./gateway/openai-compatible.ts";
export * from "./gateway/mock.ts";
export * from "./gateway/embeddings.ts";
export * from "./rag/chunk.ts";
export * from "./rag/search.ts";
export * from "./rag/answer.ts";
export * from "./rag/output-filter.ts";
export * from "./drift/drift.ts";
export * from "./drift/diff.ts";
export * from "./prompts.ts";
export { normalizeWhitespace, containsVerbatim, estimateTokens, termCoverage } from "./text.ts";
export * from "./eval/harness.ts";
export * from "./eval/corpus.ts";
export * from "./eval/mock.ts";
