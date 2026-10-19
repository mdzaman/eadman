import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type { ContentBlock, Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages/messages";
import type {
  BetaContentBlock,
  BetaMessage,
  MessageCreateParamsNonStreaming as BetaMessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  NOT_DOCUMENTED,
  type CitedGenerationRequest,
  type CitedGenerationResult,
  type CitedSegment,
  type LlmProvider,
  type ModelRef,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type TokenUsage,
} from "./types.ts";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";
const DEFAULT_MAX_TOKENS = 16000;

/**
 * The slice of the official SDK client this provider uses. A real `new Anthropic()`
 * satisfies it; tests pass a fake object with the same shape.
 */
export interface AnthropicClientLike {
  messages: {
    create(params: MessageCreateParamsNonStreaming): PromiseLike<Message>;
    parse(params: MessageCreateParamsNonStreaming): PromiseLike<Message & { parsed_output: unknown }>;
  };
  beta: {
    messages: {
      create(params: BetaMessageCreateParamsNonStreaming): PromiseLike<BetaMessage>;
    };
  };
}

export interface AnthropicProviderOptions {
  client?: AnthropicClientLike;
  /** Defaults to `claude-opus-5-5`. */
  model?: string;
  /**
   * Server-side fallback on refusal (`fallbacks: "default"`) for the citations path.
   * Disable when the tenant pins an explicit model allowlist: a fallback may run on another model.
   */
  allowServerFallback?: boolean;
}

/**
 * Claude via the official SDK (docs/07 §5.1).
 *
 * - Thinking is always on for Claude Opus 5.5; depth is controlled only with
 *   `output_config.effort`, which is always sent explicitly (the model default is
 *   "medium"). No `thinking`, `budget_tokens`, `temperature`, `top_p` or assistant
 *   prefill is ever sent: all of them are rejected by this model.
 * - Citations come from plain-text `document` blocks with `citations.enabled`; they
 *   are never combined with `output_config.format` (a 400).
 * - Structured outputs go through `messages.parse()` + `jsonSchemaOutputFormat()`.
 */
export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic";
  readonly model: string;
  readonly allowServerFallback: boolean;
  private readonly client: AnthropicClientLike;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.allowServerFallback = opts.allowServerFallback ?? true;
  }

  async generateWithCitations(req: CitedGenerationRequest): Promise<CitedGenerationResult> {
    const modelRef: ModelRef = { provider: this.id, model: this.model };
    // Never let the model answer from parametric knowledge.
    if (req.sources.length === 0) return { status: "not_documented", segments: [], model: modelRef };

    const params = {
      model: this.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      // Stable per template and version, so it is cached; volatile content comes after it.
      system: [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }],
      messages: [
        {
          role: "user" as const,
          content: [
            ...req.sources.map((source) => ({
              type: "document" as const,
              source: { type: "text" as const, media_type: "text/plain" as const, data: source.text },
              title: source.title,
              context: source.url,
              citations: { enabled: true },
            })),
            { type: "text" as const, text: req.question },
          ],
        },
      ],
      output_config: { effort: req.effort ?? "medium" },
    };

    let response: Message | BetaMessage;
    try {
      response = this.allowServerFallback
        ? await this.client.beta.messages.create({ ...params, betas: [SERVER_SIDE_FALLBACK_BETA], fallbacks: "default" })
        : await this.client.messages.create(params);
    } catch (error) {
      return { status: "error", segments: [], model: modelRef, error: describeApiError(error) };
    }

    const served: ModelRef = { provider: this.id, model: response.model || this.model };
    const usage = mapUsage(response.usage);
    if (response.stop_reason === "refusal") {
      return { status: "refused", segments: [], model: served, usage, error: refusalMessage(response.stop_details) };
    }

    const segments: CitedSegment[] = [];
    for (const block of response.content as Array<ContentBlock | BetaContentBlock>) {
      // Thinking, redacted thinking and fallback blocks carry no answer text.
      if (block.type !== "text") continue;
      const citations: CitedSegment["citations"] = [];
      for (const citation of block.citations ?? []) {
        if (citation.type !== "char_location") continue;
        const source = req.sources[citation.document_index];
        if (!source) continue; // must map to a source we provided
        citations.push({
          sourceId: source.id,
          quote: citation.cited_text,
          start: citation.start_char_index,
          end: citation.end_char_index,
        });
      }
      segments.push({ text: block.text, citations });
    }

    const text = segments.map((s) => s.text).join("").trim();
    if (text === NOT_DOCUMENTED) return { status: "not_documented", segments: [], model: served, usage };
    return { status: "answered", segments, model: served, usage };
  }

  async generateStructured<T>(req: StructuredGenerationRequest): Promise<StructuredGenerationResult<T>> {
    const modelRef: ModelRef = { provider: this.id, model: this.model };
    // Throws (a programming error) when the schema is not an object schema or a node lacks `type`.
    const format = jsonSchemaOutputFormat(req.schema as { type: "object" });
    let response: Message & { parsed_output: unknown };
    try {
      response = await this.client.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: req.prompt }],
        output_config: { effort: req.effort ?? "medium", format },
      });
    } catch (error) {
      if (error instanceof Anthropic.APIError) return { status: "error", model: modelRef, error: describeApiError(error) };
      // The SDK raises a bare AnthropicError when the output does not parse as JSON
      // (for example, truncated at max_tokens).
      if (error instanceof Anthropic.AnthropicError) return { status: "invalid", model: modelRef, error: error.message };
      throw error;
    }

    const served: ModelRef = { provider: this.id, model: response.model || this.model };
    const usage = mapUsage(response.usage);
    if (response.stop_reason === "refusal") {
      return { status: "refused", model: served, usage, error: refusalMessage(response.stop_details) };
    }
    if (response.parsed_output === null || response.parsed_output === undefined) {
      return { status: "invalid", model: served, usage, error: `no parsed output (stop_reason: ${response.stop_reason ?? "unknown"})` };
    }
    return { status: "ok", value: response.parsed_output as T, model: served, usage };
  }
}

/** Most specific first; anything that is not an SDK API error is a bug and is rethrown. */
function describeApiError(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError) return `rate_limited: ${error.message}`;
  if (error instanceof Anthropic.APIError) return `api_error${error.status === undefined ? "" : ` ${error.status}`}: ${error.message}`;
  throw error;
}

function refusalMessage(details: { category?: string | null } | null | undefined): string {
  const category = details?.category;
  return category ? `refused (category: ${category})` : "refused";
}

function mapUsage(usage: { input_tokens: number; output_tokens: number } | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}
