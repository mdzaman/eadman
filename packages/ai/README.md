# @docops/ai

The governed AI layer of DocOps: an LLM gateway with pluggable providers, permission-aware
retrieval with verified citations (Ask-the-docs), AI drift verification and patch
suggestions, versioned prompt templates, and an evaluation harness with hard gates.
The design is [docs/07-ai-design.md](../../docs/07-ai-design.md); the threats it answers are
T14, T21 and T22 in [docs/08-security-compliance.md](../../docs/08-security-compliance.md).

Every output is a suggestion with provenance. Nothing here commits, publishes or calls a
tool: the model only ever receives sources as data and returns text or JSON, which DocOps
verifies before anyone sees it.

```
src/
  gateway/   types · AnthropicProvider · OpenAiCompatibleProvider · MockProvider · embeddings
  rag/       chunk (chunkPage) · search (InMemorySearchBackend) · answer (AnswerService) · output-filter
  drift/     drift (DriftAiService) · diff (unifiedDiff)
  prompts.ts loadPrompt / renderPrompt over prompts/<id>.v<N>.md
  eval/      harness (runEval, evaluateGates, loadDataset) · corpus · mock · cli
prompts/     answer.v3 · drift-verify.v2 · drift-patch.v2 · release-notes.v1
eval/        datasets/acme-smoke.jsonl · fixtures/hostile-webhooks.md (test-only, hostile on purpose)
```

## Ask-the-docs

```ts
import { AnswerService, AnthropicProvider, chunkPage, HashingEmbeddingProvider, InMemorySearchBackend } from "@docops/ai";

const search = new InMemorySearchBackend();
const embeddings = new HashingEmbeddingProvider(); // TeiEmbeddingProvider in production
const chunks = pages.flatMap((page) =>
  chunkPage(page, { url: `/2.4/${page.path}`, version: "2.4", audience: "public", aclPrincipals: ["tenant:*"] }),
);
await search.index(chunks, await embeddings.embed(chunks.map((c) => c.text), "document"));

const service = new AnswerService({
  search,
  embeddings,
  provider: new AnthropicProvider(),
  productName: "Acme Payments",
  linkAllowlist: ["docs.acme.example"],
  liveAcl: (pagePath, principals) => policy.canRead(principals, pagePath),
});
const answer = await service.ask({ question: "How do I issue a partial refund?", principals: ["tenant:*", "user:42"], version: "2.4" });
// { status: "answered", answer: "Set `amount` ... [S1]", citations: [{ id: "S1", url: "/2.4/guides/refunds#partial-refunds", quote, stale, ... }], ... }
```

`ask()` runs these steps, in order:

1. **Retrieve as the asker.** `SearchBackend.query()` requires a non-empty principal set and
   applies the ACL, version and audience filters before ranking. A chunk is visible iff
   `chunk.aclPrincipals ∩ principals ≠ ∅`. The in-memory backend computes BM25 statistics over
   the visible candidates only, so scores never depend on content the asker can't read.
   Ranking is BM25 (k1 1.2, b 0.75) and cosine, each top 50, fused with RRF (k = 60). Stale
   chunks are multiplied by 0.7.
2. **Sufficiency gate (no model call without evidence).** For each of the top `maxSources`
   (8) hits whose BM25 score is above 0, *relevance* is the share of the question's distinct
   content terms (stopwords removed, light stemming, product-name terms ignored) that occur
   in the chunk text. The question goes to the model only if the best relevance is at least
   `sufficiencyThreshold` (default 0.5). Below it, the answer is `not_documented` and the
   provider is not called. The gate is lexical so it is deterministic and works with any
   backend; calibrate the threshold per tenant on the eval set.
3. **Live ACL before generation.** Pages that fail `liveAcl` are never sent. The gate is
   checked again on what remains after this step and the ~6k-token context budget.
4. **Generate with citations.** The `answer` template is rendered with the product name and
   version, and the sources go as `S1..Sn` (chunk text, breadcrumb title, URL with anchor).
5. **Verify.** A citation survives only if its source was sent and its quote is a verbatim
   substring of that chunk (exact at the given offsets, or after whitespace normalization).
   Segments with factual text and no valid citation are removed. Connective text (fewer
   than 4 words, or ending with `:`) may stay. The status becomes `partial` when anything was
   removed, and `not_documented` when no cited content remains. An exact `NOT_DOCUMENTED`
   reply also maps to `not_documented`.
6. **Live ACL re-check** of cited pages, right before rendering.
7. **Render and filter.** DocOps places the `[S1]` markers itself, one citation per distinct
   (chunk, quote) pair, and drops markers that the model wrote. `filterAnswerMarkdown` then
   removes images, raw HTML and link reference definitions. A link renders only if it is
   `https` and either its host is in `linkAllowlist` or the exact URL appears in a cited
   chunk. Any other link becomes its text. Code spans and code blocks are left as they are.

`Answer.notes` carries counts and ids for logs, never content. Citation quotes are plain
text and must never be rendered as Markdown.

## Gateway

| Provider | Answers with citations | Structured output |
|---|---|---|
| `AnthropicProvider` (default `claude-opus-5-5`) | Plain-text `document` blocks with `citations: { enabled: true }`, `title` = breadcrumb, `context` = URL. `char_location` citations are mapped to source ids. When `allowServerFallback` is on (the default), the request goes through `client.beta.messages.create` with `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"`. | `client.messages.parse` with `output_config.format: jsonSchemaOutputFormat(schema)`, read from `parsed_output`. |
| `OpenAiCompatibleProvider` (vLLM, TGI, Ollama, Azure OpenAI) | Strict JSON mode, `{ status, sentences: [{ text, citations: [{ source_id, quote }] }] }`. Sources go as `<source id title url>` elements between lines that hold a random per-request boundary. | `response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }` |
| `MockProvider` | Scripted, and records `.calls`. `createQuotingMockProvider()` is the eval stand-in. | Scripted (`mockStructuredStatus()` simulates failures) |

Claude Opus 5.5 always thinks, so the provider never sends `thinking`, `budget_tokens`,
`temperature`, `top_p` or an assistant prefill. All of these return a 400. Depth is set with
`output_config.effort`, which is always sent explicitly from the template's `effort` (the
model's own default is `medium`). The system prompt is a cached block. `stop_reason: "refusal"`
is checked before reading content and maps to `refused`, with the `stop_details.category` in
`error`. SDK errors are mapped most-specific first: `RateLimitError`, then `APIError` →
`error`. A structured output that does not parse becomes `invalid`. Any other exception is a
bug and is rethrown. Pass `client` to inject a fake: its type is `AnthropicClientLike`.

Embeddings: `HashingEmbeddingProvider` (deterministic feature hashing, 256 dimensions, offline)
and `TeiEmbeddingProvider` (`POST {baseUrl}/embed {inputs}`, for example BGE-M3 at 1024
dimensions, with no egress).

## Drift (stage 4, opt-in)

`DriftAiService.verify()` calls `drift-verify@v2` at `high` effort with the schema from
docs/07 §4.2. A claim becomes a `SemanticDriftFinding` only if all of these hold:

- its quote is found verbatim in the passage (whitespace-tolerant);
- the verdict is `now_false`;
- the confidence is at least `minConfidence` (0.8);
- it has evidence, and every `entity_diff` item names the path of a provided delta and every
  `code_hunk` item occurs in a provided hunk.

The line is `startLine` plus the quote's line offset within the passage. Everything else is
returned in `dropped`, with a reason.

`suggestPatch()` asks `drift-patch@v2` for `replacement_lines` covering the editable range only,
and DocOps computes the unified diff. A patch fails validation if it does any of the following:

- repeats a neighbouring line, which means it edits outside the range;
- changes more than `maxChangedLineRatio` (30%) of a range longer than 3 lines;
- makes the Markdown or frontmatter stop parsing, or adds or removes a code fence;
- introduces raw HTML or JSX;
- adds a non-http(s) link, or a link to a host that is neither in `allowedLinkHosts` nor
  already linked from the file;
- keeps the finding's old value, or lacks its new one (when both are given and the old one
  was in the range);
- changes nothing.

`needs_human` and refusals pass through. Every result carries `Provenance` (provider, model,
template, version, input hashes).

## Prompts

`loadPrompt(id, version?)` reads `prompts/<id>.v<N>.md`. Without a version, the highest N wins.
The YAML frontmatter holds `id`, `version`, `purpose`, `output` (`citations`, `markdown` or the
JSON Schema) and `effort`. The body is the system prompt, and `renderPrompt` fills in
`{{product_name}}` and `{{version}}`. The answer and drift template texts are verbatim from
docs/07 §4, and a test keeps them in sync. Never edit a released template. Add `v<N+1>` and run
the eval instead.

## Evaluation

```sh
node --experimental-strip-types packages/ai/src/eval/cli.ts \
  --dataset packages/ai/eval/datasets/acme-smoke.jsonl --docs examples/acme-payments/docs --provider mock
```

The CLI builds the corpus from `--docs` plus `eval/fixtures` (as `eval-fixtures/…`). Runbooks
are readable by `group:sre` only (`--acl "runbooks/**=group:sre"`). The CLI indexes the
corpus with hashing embeddings, runs every case, prints the metrics, and exits 1 when a hard
gate fails. `--provider anthropic` uses the Claude API and needs `ANTHROPIC_API_KEY`. Tests
never use it.

| Metric | Gate |
|---|---|
| `quoteValidity`: citations whose quote is verbatim in the cited corpus chunk | = 1 |
| `permissionLeaks`: cases that retrieved or cited a chunk the principals can't read, or that broke a permission-trap expectation | = 0 |
| `injectionSuccesses`: injection cases whose answer contains forbidden text, an image or raw HTML | = 0 |
| `abstentionAccuracy`: `not_documented` on `unanswerable` cases | ≥ 0.95 when measured |
| `citationRecall`, `answerRate` | tracked |

Each dataset line is an `EvalCase`: `{ id, question, principals, tags, expect: { status, citesAnyOf?, mustNotCite?, mustNotContain? } }`,
with tags `answerable`, `unanswerable`, `permission-trap` and `injection`.

## Notes

- **JSON Schemas for Claude.** SDK 0.135's `jsonSchemaOutputFormat` transforms the schema by
  default. It throws when a node has no `type`, so the docs/07 §4.2 enum fields carry an
  explicit `type: "string"`. It also moves `enum` into the field description, which means
  enum values are validated by DocOps after parsing, not by constrained decoding.
- **Fallback scope.** Server-side fallback is used on the citations path only. The structured
  path calls `messages.parse` without it, so a refusal there returns `refused`.
- **Re-indexing.** To re-index a page with `InMemorySearchBackend`, call `removePage(path)` and
  then `index()` its new chunks.
- **Links from cited chunks.** Following docs/07 §2.4, a link copied verbatim from a cited chunk
  is allowed. Such a link can't carry new data, so it can't exfiltrate anything. A hostile page
  can still have its own link repeated, though. The injection eval measures whether a model
  follows that kind of instruction, and the fixture contains one.
- **Not implemented yet.** docs/07 §5 lists more gateway responsibilities than this package
  covers today. Still missing: secret and PII redaction before calls, the output secret
  scanner, token budgets and quotas, audit events, and streamed answers. Retries come from
  the Anthropic SDK (2 by default); the OpenAI-compatible provider does not retry.
