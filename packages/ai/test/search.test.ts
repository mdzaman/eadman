import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HashingEmbeddingProvider,
  InMemorySearchBackend,
  RRF_K,
  TeiEmbeddingProvider,
  type Chunk,
} from "../src/index.ts";

function chunk(id: string, text: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    id,
    pagePath: `${id}.md`,
    title: id,
    headingPath: id,
    anchor: null,
    url: `/2.4/${id}`,
    text,
    tokenEstimate: Math.ceil(text.length / 4),
    version: "2.4",
    audience: "public",
    aclPrincipals: ["tenant:*"],
    contentHash: id,
    ...overrides,
  };
}

const embeddings = new HashingEmbeddingProvider();

async function backendWith(chunks: Chunk[]): Promise<InMemorySearchBackend> {
  const backend = new InMemorySearchBackend();
  await backend.index(chunks, await embeddings.embed(chunks.map((c) => c.text), "document"));
  return backend;
}

async function search(backend: InMemorySearchBackend, text: string, principals: string[], extra: { version?: string; k?: number } = {}) {
  const [embedding] = await embeddings.embed([text], "query");
  return backend.query({ text, embedding: embedding ?? [], principals, ...extra });
}

const corpus = [
  chunk("runbook-timeouts", "Runbook › Timeouts\n\nPAYMENTS_TIMEOUT_MS defaults to 30000. Raise the processor timeout during an outage.", {
    aclPrincipals: ["group:sre"],
  }),
  chunk("guide-payments", "Accept a payment\n\nCreate a payment with POST /v1/payments and an idempotency key."),
  chunk("guide-refunds", "Refund a payment\n\nRefunds return captured money. Partial refunds set an amount."),
  chunk("concept-timeouts", "Timeouts\n\nClient libraries retry requests that time out.", { aclPrincipals: ["tenant:*", "group:sre"] }),
];

test("rejects an empty principal set", async () => {
  const backend = await backendWith(corpus);
  await assert.rejects(search(backend, "processor timeout", []), /non-empty principal set/);
  await assert.rejects(search(backend, "processor timeout", [""]), /non-empty principal set/);
});

test("never returns chunks the principals cannot read, even when they are the most relevant", async () => {
  const backend = await backendWith(corpus);
  const question = "What is the PAYMENTS_TIMEOUT_MS processor timeout during an outage?";
  const asSre = await search(backend, question, ["group:sre"]);
  assert.equal(asSre[0]?.chunk.id, "runbook-timeouts", "it is the best match for an SRE");

  const asDeveloper = await search(backend, question, ["tenant:*", "user:dev-1"]);
  assert.ok(asDeveloper.length > 0);
  assert.ok(asDeveloper.every((h) => h.chunk.id !== "runbook-timeouts"));
  assert.ok(asDeveloper.every((h) => h.chunk.aclPrincipals.includes("tenant:*")));
  // Scores do not depend on hidden content: the same query over the visible subset alone ranks identically.
  const visibleOnly = await backendWith(corpus.filter((c) => c.aclPrincipals.includes("tenant:*")));
  const reference = await search(visibleOnly, question, ["tenant:*", "user:dev-1"]);
  assert.deepEqual(
    asDeveloper.map((h) => [h.chunk.id, h.score, h.keywordScore]),
    reference.map((h) => [h.chunk.id, h.score, h.keywordScore]),
  );
});

test("filters by version and audience before ranking", async () => {
  const backend = await backendWith([
    chunk("refunds-v23", "Refund a payment (v2.3)\n\nRefunds take five days.", { version: "2.3" }),
    chunk("refunds-v24", "Refund a payment (v2.4)\n\nRefunds take three days.", { version: "2.4" }),
    chunk("refunds-internal", "Refund a payment (v2.4)\n\nSupport can force refunds.", { audience: "internal" }),
  ]);
  const v23 = await search(backend, "how long do refunds take", ["tenant:*"], { version: "2.3" });
  assert.deepEqual(
    v23.map((h) => h.chunk.id),
    ["refunds-v23"],
  );
  const [embedding] = await embeddings.embed(["refunds"], "query");
  const publicOnly = await backend.query({ text: "refunds", embedding: embedding ?? [], principals: ["tenant:*"], audience: "public" });
  assert.ok(publicOnly.every((h) => h.chunk.audience === "public"));
  assert.equal(publicOnly.length, 2);
});

test("fuses BM25 and vector ranks with RRF (k = 60) and down-weights stale chunks", async () => {
  const text = "Refund a payment\n\nPartial refunds set an amount in minor units.";
  const backend = await backendWith([chunk("fresh", text), chunk("stale", text, { stale: true }), chunk("other", "Webhooks\n\nEvents are delivered once.")]);
  const hits = await search(backend, "partial refunds amount", ["tenant:*"]);
  const fresh = hits.find((h) => h.chunk.id === "fresh");
  const stale = hits.find((h) => h.chunk.id === "stale");
  assert.ok(fresh && stale);
  assert.equal(hits[0]?.chunk.id, "fresh");
  assert.ok(fresh.keywordScore > 0 && fresh.vectorScore > 0);
  assert.ok(fresh.keywordRank !== undefined && fresh.vectorRank !== undefined);
  assert.equal(fresh.score, 1 / (RRF_K + fresh.keywordRank) + 1 / (RRF_K + fresh.vectorRank));
  const staleRaw = 1 / (RRF_K + (stale.keywordRank ?? 0)) + 1 / (RRF_K + (stale.vectorRank ?? 0));
  assert.ok(Math.abs(stale.score - staleRaw * 0.7) < 1e-12);
  assert.equal(hits.find((h) => h.chunk.id === "other")?.keywordScore ?? 0, 0);
});

test("respects k and removes pages", async () => {
  const backend = await backendWith(corpus);
  assert.equal((await search(backend, "payment refunds timeouts", ["tenant:*"], { k: 1 })).length, 1);
  await backend.removePage("guide-refunds.md");
  const hits = await search(backend, "refunds captured money", ["tenant:*"]);
  assert.ok(hits.every((h) => h.chunk.pagePath !== "guide-refunds.md"));
  assert.equal(backend.size, 3);
});

test("hashing embeddings are deterministic, normalized and lexically meaningful", async () => {
  const provider = new HashingEmbeddingProvider({ dimensions: 64 });
  const [a, b, c, again] = await provider.embed(
    ["Partial refunds set an amount", "How do I issue partial refunds?", "Webhook signatures use HMAC", "Partial refunds set an amount"],
    "document",
  );
  assert.ok(a && b && c && again);
  assert.equal(a.length, 64);
  assert.deepEqual(a, again);
  const cosine = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * (y[i] ?? 0), 0);
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-9);
  assert.ok(cosine(a, b) > cosine(a, c));
  assert.equal(provider.id, "hashing-64");
});

test("TEI embeddings POST /embed with inputs and validate the vectors", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { inputs: string[] };
    requests.push({ url: String(input), body });
    return new Response(JSON.stringify(body.inputs.map((_, i) => [i, 0.5, 0.25])), { status: 200 });
  };
  const tei = new TeiEmbeddingProvider({ baseUrl: "http://tei.internal:8080/", dimensions: 3, batchSize: 2, fetch: fakeFetch });
  const vectors = await tei.embed(["a", "b", "c"], "document");
  assert.deepEqual(vectors, [
    [0, 0.5, 0.25],
    [1, 0.5, 0.25],
    [0, 0.5, 0.25],
  ]);
  assert.deepEqual(requests, [
    { url: "http://tei.internal:8080/embed", body: { inputs: ["a", "b"] } },
    { url: "http://tei.internal:8080/embed", body: { inputs: ["c"] } },
  ]);

  const wrongSize = new TeiEmbeddingProvider({ baseUrl: "http://tei", dimensions: 1024, fetch: fakeFetch });
  await assert.rejects(wrongSize.embed(["a"], "query"), /not 1024-dimensional/);
  const failing = new TeiEmbeddingProvider({ baseUrl: "http://tei", fetch: async () => new Response("overloaded", { status: 503 }) });
  await assert.rejects(failing.embed(["a"], "query"), /HTTP 503/);
});
