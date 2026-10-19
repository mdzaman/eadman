import { test } from "node:test";
import assert from "node:assert/strict";
import { isIgnored, parseMarkdown, syncIncludes } from "../src/index.ts";

const source = `---
title: Accept a payment
type: how-to
tickets: [PAY-101]
---

# Accept a payment

Send \`POST /v1/payments\` with an \`amount\` in minor units. See [refunds](refunds.md#partial-refunds)
and the [API](https://api.acme.example/docs).

## Capture later

| Field | Type |
|---|---|
| \`capture\` | boolean |

<!-- docops-ignore drift/stale-reference -->
\`\`\`bash test
curl -X POST https://api.acme.example/v1/payments -d '{"amount": 2000}'
\`\`\`

![diagram](img/flow.png)

## Capture later
`;

test("parses frontmatter, headings, anchors and links with line numbers", () => {
  const page = parseMarkdown("guides/payments.md", source);
  assert.equal(page.title, "Accept a payment");
  assert.equal(page.pageType, "how_to");
  assert.deepEqual(page.frontmatter.tickets, ["PAY-101"]);
  assert.deepEqual(page.headings.map((h) => h.anchor), ["accept-a-payment", "capture-later", "capture-later-1"]);
  const refunds = page.links.find((l) => l.url.startsWith("refunds"));
  assert.equal(refunds?.kind, "internal");
  assert.equal(refunds?.line, 9);
  assert.equal(page.links.find((l) => l.isImage)?.text, "diagram");
  assert.equal(page.links.find((l) => l.kind === "external")?.url, "https://api.acme.example/docs");
});

test("captures inline code with context and code blocks with meta", () => {
  const page = parseMarkdown("guides/payments.md", source);
  assert.deepEqual(page.inlineCode.slice(0, 2).map((c) => [c.value, c.line, c.context]), [
    ["POST /v1/payments", 9, "prose"],
    ["amount", 9, "prose"],
  ]);
  assert.equal(page.inlineCode.find((c) => c.value === "capture")?.context, "table");
  const block = page.codeBlocks[0];
  assert.equal(block?.lang, "bash");
  assert.equal(block?.meta, "test");
  assert.equal(block?.line, 19);
  assert.equal(block?.section, 2);
});

test("ignore pragmas apply to the next block only", () => {
  const page = parseMarkdown("guides/payments.md", source);
  assert.equal(isIgnored(page, "drift/stale-reference", 20), true);
  assert.equal(isIgnored(page, "drift/stale-reference", 9), false);
  assert.equal(isIgnored(page, "links/broken-internal", 20), false);
});

test("MDX pages parse JSX components and snippet references", () => {
  const page = parseMarkdown("guides/x.mdx", "# Title\n\n<Callout type=\"note\">Hi `code`</Callout>\n\n<Snippet name=\"support\" />\n");
  assert.equal(page.format, "mdx");
  assert.deepEqual(page.snippets, [{ name: "support", line: 5 }]);
});

test("include blocks are rendered and detected as stale", async () => {
  const text = 'Intro\n<!-- docops:include path="x.sql" lang="sql" -->\nold\n<!-- docops:end-include -->\n';
  const read = async () => "SELECT 1;\n";
  const first = await syncIncludes("/docs/a.md", text, read);
  assert.equal(first.includes[0]?.upToDate, false);
  assert.match(first.content, /```sql\nSELECT 1;\n```\n<!-- docops:end-include -->/);
  const second = await syncIncludes("/docs/a.md", first.content, read);
  assert.equal(second.includes[0]?.upToDate, true);
  assert.equal(second.content, first.content);
});
