import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { AnthropicProvider, DRIFT_VERIFY_SCHEMA, SERVER_SIDE_FALLBACK_BETA, type AnthropicClientLike, type SourceDoc } from "../src/index.ts";

const sources: SourceDoc[] = [
  { id: "S1", title: "Refund a payment › Partial refunds (v2.4)", url: "/2.4/guides/refunds#partial-refunds", text: "Refund a payment › Partial refunds (v2.4)\n\nSet `amount` (in minor units) to refund part of a payment." },
  { id: "S2", title: "Idempotent requests (v2.4)", url: "/2.4/concepts/idempotency", text: "Idempotent requests (v2.4)\n\nKeys are remembered for 24 hours." },
];

const usage = { input_tokens: 812, output_tokens: 97 };

function message(content: unknown[], extra: Record<string, unknown> = {}): Message & BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage,
    ...extra,
  } as unknown as Message & BetaMessage;
}

interface Recorded {
  create: unknown[];
  parse: unknown[];
  betaCreate: unknown[];
}

function fakeClient(responses: { create?: () => unknown; parse?: () => unknown; betaCreate?: () => unknown }): { client: AnthropicClientLike; calls: Recorded } {
  const calls: Recorded = { create: [], parse: [], betaCreate: [] };
  const run = async (fn: (() => unknown) | undefined) => {
    if (!fn) throw new Error("unexpected call");
    return fn();
  };
  const client = {
    messages: {
      create: async (params: unknown) => {
        calls.create.push(params);
        return run(responses.create);
      },
      parse: async (params: unknown) => {
        calls.parse.push(params);
        return run(responses.parse);
      },
    },
    beta: {
      messages: {
        create: async (params: unknown) => {
          calls.betaCreate.push(params);
          return run(responses.betaCreate);
        },
      },
    },
  } as unknown as AnthropicClientLike;
  return { client, calls };
}

const citedResponse = message([
  { type: "thinking", thinking: "", signature: "sig" },
  { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" }, trigger: { type: "refusal", category: "cyber" } },
  { type: "text", text: "To refund part of a payment, ", citations: null },
  {
    type: "text",
    text: "set `amount` in minor units",
    citations: [
      {
        type: "char_location",
        cited_text: "Set `amount` (in minor units) to refund part of a payment.",
        document_index: 0,
        document_title: "Refund a payment › Partial refunds (v2.4)",
        start_char_index: 43,
        end_char_index: 101,
        file_id: null,
      },
      { type: "char_location", cited_text: "phantom", document_index: 7, document_title: null, start_char_index: 0, end_char_index: 7, file_id: null },
    ],
  },
  { type: "text", text: ".", citations: null },
], { model: "claude-opus-5" });

test("citations path: document blocks with citations, explicit effort, cached system and server-side fallback", async () => {
  const { client, calls } = fakeClient({ betaCreate: () => citedResponse });
  const provider = new AnthropicProvider({ client });
  assert.equal(provider.model, "claude-opus-5-5");
  const result = await provider.generateWithCitations({ system: "You answer questions about Acme.", question: "How do I issue a partial refund?", sources });

  assert.equal(calls.create.length, 0);
  assert.equal(calls.betaCreate.length, 1);
  const params = calls.betaCreate[0] as Record<string, unknown>;
  assert.deepEqual(params, {
    model: "claude-opus-5-5",
    max_tokens: 16000,
    system: [{ type: "text", text: "You answer questions about Acme.", cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "text", media_type: "text/plain", data: sources[0]?.text },
            title: "Refund a payment › Partial refunds (v2.4)",
            context: "/2.4/guides/refunds#partial-refunds",
            citations: { enabled: true },
          },
          {
            type: "document",
            source: { type: "text", media_type: "text/plain", data: sources[1]?.text },
            title: "Idempotent requests (v2.4)",
            context: "/2.4/concepts/idempotency",
            citations: { enabled: true },
          },
          { type: "text", text: "How do I issue a partial refund?" },
        ],
      },
    ],
    output_config: { effort: "medium" },
    betas: [SERVER_SIDE_FALLBACK_BETA],
    fallbacks: "default",
  });
  assert.equal(SERVER_SIDE_FALLBACK_BETA, "server-side-fallback-2026-07-01");
  for (const forbidden of ["thinking", "temperature", "top_p", "top_k"]) assert.ok(!(forbidden in params), `${forbidden} is never sent`);
  assert.ok(!("format" in (params.output_config as object)), "citations are never combined with structured outputs");

  assert.equal(result.status, "answered");
  assert.deepEqual(result.model, { provider: "anthropic", model: "claude-opus-5" }, "reports the model that served the fallback");
  assert.deepEqual(result.usage, { inputTokens: 812, outputTokens: 97 });
  assert.deepEqual(result.segments, [
    { text: "To refund part of a payment, ", citations: [] },
    {
      text: "set `amount` in minor units",
      citations: [{ sourceId: "S1", quote: "Set `amount` (in minor units) to refund part of a payment.", start: 43, end: 101 }],
    },
    { text: ".", citations: [] },
  ]);
  assert.equal(sources[0]?.text.slice(43, 101), "Set `amount` (in minor units) to refund part of a payment.");
});

test("citations path without server fallback uses messages.create; NOT_DOCUMENTED and refusals map to statuses", async () => {
  const notDocumented = fakeClient({ create: () => message([{ type: "text", text: "NOT_DOCUMENTED", citations: null }]) });
  const provider = new AnthropicProvider({ client: notDocumented.client, allowServerFallback: false });
  const result = await provider.generateWithCitations({ system: "s", question: "q", sources, effort: "high", maxTokens: 2048 });
  assert.equal(result.status, "not_documented");
  const params = notDocumented.calls.create[0] as Record<string, unknown>;
  assert.equal(notDocumented.calls.betaCreate.length, 0);
  assert.ok(!("betas" in params) && !("fallbacks" in params));
  assert.deepEqual(params.output_config, { effort: "high" });
  assert.equal(params.max_tokens, 2048);

  const refusal = fakeClient({
    betaCreate: () => message([], { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "x" } }),
  });
  const refused = await new AnthropicProvider({ client: refusal.client }).generateWithCitations({ system: "s", question: "q", sources });
  assert.equal(refused.status, "refused");
  assert.equal(refused.error, "refused (category: cyber)");
  assert.deepEqual(refused.segments, []);

  const none = fakeClient({});
  const empty = await new AnthropicProvider({ client: none.client }).generateWithCitations({ system: "s", question: "q", sources: [] });
  assert.equal(empty.status, "not_documented", "no sources: no call");
  assert.equal(none.calls.betaCreate.length, 0);
});

test("API errors become status error (rate limits first); other errors are rethrown", async () => {
  const limited = fakeClient({ betaCreate: () => Promise.reject(new Anthropic.RateLimitError(429, { type: "error" }, "Too many requests", new Headers())) });
  const a = await new AnthropicProvider({ client: limited.client }).generateWithCitations({ system: "s", question: "q", sources });
  assert.equal(a.status, "error");
  assert.match(a.error ?? "", /^rate_limited: /);

  const overloaded = fakeClient({ betaCreate: () => Promise.reject(new Anthropic.InternalServerError(529, { type: "error" }, "Overloaded", new Headers())) });
  const b = await new AnthropicProvider({ client: overloaded.client }).generateWithCitations({ system: "s", question: "q", sources });
  assert.equal(b.status, "error");
  assert.match(b.error ?? "", /^api_error 529: /);

  const bug = fakeClient({ betaCreate: () => Promise.reject(new TypeError("boom")) });
  await assert.rejects(new AnthropicProvider({ client: bug.client }).generateWithCitations({ system: "s", question: "q", sources }), TypeError);
});

test("structured path: messages.parse with jsonSchemaOutputFormat, effort, cached system and parsed_output", async () => {
  const value = { claims: [] };
  const { client, calls } = fakeClient({ parse: () => ({ ...message([{ type: "text", text: JSON.stringify(value), citations: null }]), parsed_output: value }) });
  const provider = new AnthropicProvider({ client });
  const result = await provider.generateStructured<{ claims: unknown[] }>({
    system: "You check documentation.",
    prompt: "Passage: ...",
    schema: DRIFT_VERIFY_SCHEMA,
    schemaName: "drift_verify",
    effort: "high",
  });
  assert.deepEqual(result, { status: "ok", value, model: { provider: "anthropic", model: "claude-opus-5-5" }, usage: { inputTokens: 812, outputTokens: 97 } });

  assert.equal(calls.parse.length, 1);
  const params = calls.parse[0] as {
    model: string;
    max_tokens: number;
    system: unknown;
    messages: unknown;
    output_config: { effort: string; format: { type: string; schema: Record<string, unknown>; parse: (s: string) => unknown } };
  };
  assert.equal(params.model, "claude-opus-5-5");
  assert.equal(params.max_tokens, 16000);
  assert.deepEqual(params.system, [{ type: "text", text: "You check documentation.", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(params.messages, [{ role: "user", content: "Passage: ..." }]);
  assert.equal(params.output_config.effort, "high");
  assert.equal(params.output_config.format.type, "json_schema");
  assert.equal(params.output_config.format.schema.additionalProperties, false);
  assert.deepEqual(params.output_config.format.parse('{"claims":[]}'), { claims: [] });
  for (const forbidden of ["thinking", "temperature", "top_p", "betas"]) assert.ok(!(forbidden in params), `${forbidden} is never sent`);
});

test("structured path: refusal, null parsed_output, parse failures and API errors", async () => {
  const request = { system: "s", prompt: "p", schema: DRIFT_VERIFY_SCHEMA, schemaName: "drift_verify" };
  const refused = fakeClient({
    parse: () => ({ ...message([], { stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null } }), parsed_output: null }),
  });
  const a = await new AnthropicProvider({ client: refused.client }).generateStructured(request);
  assert.deepEqual([a.status, a.error], ["refused", "refused"]);
  assert.deepEqual((refused.calls.parse[0] as { output_config: { effort: string } }).output_config.effort, "medium", "effort is always explicit");

  const empty = fakeClient({ parse: () => ({ ...message([], { stop_reason: "max_tokens" }), parsed_output: null }) });
  const b = await new AnthropicProvider({ client: empty.client }).generateStructured(request);
  assert.equal(b.status, "invalid");
  assert.match(b.error ?? "", /max_tokens/);

  const unparseable = fakeClient({ parse: () => Promise.reject(new Anthropic.AnthropicError("Failed to parse structured output: Unexpected end of JSON input")) });
  assert.equal((await new AnthropicProvider({ client: unparseable.client }).generateStructured(request)).status, "invalid");

  const limited = fakeClient({ parse: () => Promise.reject(new Anthropic.RateLimitError(429, { type: "error" }, "Too many requests", new Headers())) });
  const c = await new AnthropicProvider({ client: limited.client }).generateStructured(request);
  assert.equal(c.status, "error");
  assert.match(c.error ?? "", /^rate_limited/);

  const bug = fakeClient({ parse: () => Promise.reject(new RangeError("bug")) });
  await assert.rejects(new AnthropicProvider({ client: bug.client }).generateStructured(request), RangeError);
});
