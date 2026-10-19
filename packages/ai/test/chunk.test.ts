import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sha256Hex } from "@docops/core";
import { parseMarkdown } from "@docops/markdown";
import { breadcrumb, chunkPage, estimateTokens, type ChunkMeta } from "../src/index.ts";

const meta: ChunkMeta = { url: "/2.4/guides/webhooks", version: "2.4", audience: "public", aclPrincipals: ["tenant:*"] };

const longCode = Array.from({ length: 120 }, (_, i) => `console.log("line ${i} of a long example that must stay in one piece");`).join("\n");
const paragraphs = Array.from(
  { length: 12 },
  (_, i) => `Paragraph ${i + 1} explains retry behaviour in detail so that the section grows well beyond the chunk budget. `.repeat(3).trim(),
).join("\n\n");

const source = `---
title: Webhooks
---

# Webhooks

Webhooks notify your server about events.

## Delivery

Events are delivered at least once.

### Retries

Failed deliveries are retried with backoff.

| Attempt | Delay |
|---|---|
| 1 | 1 minute |
| 2 | 10 minutes |

## Example

\`\`\`js
${longCode}
\`\`\`

## Troubleshooting

${paragraphs}
`;

test("splits on H2/H3, prefixes breadcrumbs and keeps anchors", () => {
  const page = parseMarkdown("guides/webhooks.md", source);
  const chunks = chunkPage(page, meta);
  const intro = chunks[0];
  assert.ok(intro);
  assert.equal(intro.anchor, null);
  assert.equal(intro.text, "Webhooks (v2.4)\n\nWebhooks notify your server about events.");
  const delivery = chunks.find((c) => c.anchor === "delivery");
  assert.equal(delivery?.text, "Webhooks › Delivery (v2.4)\n\nEvents are delivered at least once.");
  const retries = chunks.find((c) => c.anchor === "retries");
  assert.ok(retries?.text.startsWith("Webhooks › Delivery › Retries (v2.4)\n\n"));
  assert.equal(retries?.headingPath, "Webhooks › Delivery › Retries");
  assert.ok(retries?.text.includes("| 2 | 10 minutes |"), "the table stays with its section");
  for (const chunk of chunks) {
    assert.equal(chunk.pagePath, "guides/webhooks.md");
    assert.equal(chunk.title, "Webhooks");
    assert.equal(chunk.version, "2.4");
    assert.deepEqual(chunk.aclPrincipals, ["tenant:*"]);
    assert.equal(chunk.tokenEstimate, estimateTokens(chunk.text));
  }
  assert.equal(breadcrumb("Webhooks", ["Delivery"], "v2.4"), "Webhooks › Delivery (v2.4)");
  assert.equal(breadcrumb("Webhooks", [], "latest"), "Webhooks (latest)");
});

test("never splits a fenced code block, even when it exceeds the budget", () => {
  const page = parseMarkdown("guides/webhooks.md", source);
  const chunks = chunkPage(page, meta, { maxTokens: 800 });
  const example = chunks.filter((c) => c.anchor === "example");
  assert.equal(example.length, 1);
  const only = example[0];
  assert.ok(only);
  assert.ok(only.tokenEstimate > 800, "the oversized code block is kept whole");
  assert.ok(only.text.includes("```js\n") && only.text.trimEnd().endsWith("```"));
  assert.ok(only.text.includes(longCode));
});

test("splits overlong sections on paragraph boundaries within the budget", () => {
  const page = parseMarkdown("guides/webhooks.md", source);
  const chunks = chunkPage(page, meta, { minTokens: 100, maxTokens: 300 });
  const parts = chunks.filter((c) => c.anchor === "troubleshooting");
  assert.ok(parts.length >= 2, `expected several parts, got ${parts.length}`);
  for (const part of parts) {
    assert.ok(part.tokenEstimate <= 300, `part has ${part.tokenEstimate} tokens`);
    assert.ok(part.text.startsWith("Webhooks › Troubleshooting (v2.4)\n\n"));
    const body = part.text.slice(part.text.indexOf("\n\n") + 2);
    for (const paragraph of body.split("\n\n")) assert.match(paragraph, /^Paragraph \d+ explains.*budget\.$/, "whole paragraphs only");
  }
  const last = parts[parts.length - 1];
  assert.ok(last && last.tokenEstimate >= 100, "the last part is rebalanced above minTokens");
});

test("ids are stable, 32 hex chars, and change only with the chunk's content", () => {
  const page = parseMarkdown("guides/webhooks.md", source);
  const first = chunkPage(page, meta);
  const again = chunkPage(parseMarkdown("guides/webhooks.md", source), meta);
  assert.deepEqual(
    first.map((c) => c.id),
    again.map((c) => c.id),
  );
  for (const chunk of first) {
    assert.match(chunk.id, /^[0-9a-f]{32}$/);
    assert.equal(chunk.contentHash, sha256Hex(chunk.text));
  }
  assert.equal(new Set(first.map((c) => c.id)).size, first.length);

  const edited = chunkPage(parseMarkdown("guides/webhooks.md", source.replace("at least once", "at most once")), meta);
  const changed = first.filter((c, i) => c.id !== edited[i]?.id).map((c) => c.anchor);
  assert.deepEqual(changed, ["delivery"]);
  // The version is part of the indexed text, so another version yields other ids.
  const v25 = chunkPage(page, { ...meta, version: "2.5" });
  assert.ok(v25.every((c, i) => c.id !== first[i]?.id));
});

test("keeps MDX components whole and drops imports and expressions", () => {
  const mdx = [
    'import { Callout } from "../components/callout";',
    "",
    "# Webhooks",
    "",
    "{/* docops-ignore style/passive-voice */}",
    "",
    "## Delivery",
    "",
    '<Callout type="warning">',
    "",
    "Events can arrive **out of order**.",
    "",
    "</Callout>",
    "",
    "Use the event `created` timestamp to order them.",
  ].join("\n");
  const chunks = chunkPage(parseMarkdown("guides/webhooks.mdx", mdx), meta);
  assert.equal(chunks.length, 1);
  assert.equal(
    chunks[0]?.text,
    'Webhooks › Delivery (v2.4)\n\n<Callout type="warning">\n\nEvents can arrive **out of order**.\n\n</Callout>\n\nUse the event `created` timestamp to order them.',
  );
});

test("chunks the fixture corpus without frontmatter, comments or the H1", () => {
  const text = readFileSync(new URL("../../../examples/acme-payments/docs/guides/refunds.md", import.meta.url), "utf8");
  const chunks = chunkPage(parseMarkdown("guides/refunds.md", text), { ...meta, url: "/2.4/guides/refunds", stale: true });
  assert.deepEqual(
    chunks.map((c) => c.anchor),
    [null, "full-refunds", "partial-refunds"],
  );
  assert.ok(chunks.every((c) => c.stale === true));
  const all = chunks.map((c) => c.text).join("\n");
  assert.ok(!all.includes("owners:"));
  assert.ok(!all.includes("docops:snippet"));
  assert.ok(!all.includes("# Refund a payment"));
});
