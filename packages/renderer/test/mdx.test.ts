import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { renderSite, type BuildResult } from "../src/index.ts";
import { acmeRoot, articleOf, fileText, page, siteInput } from "./helpers.ts";

const MDX = `---
title: Components
---
import { Thing } from "./thing.js"
export const meta = { flag: true }

# Components for {{ productName }}

Inline {1 + 1} expression, {{ productName }} variable and {{ notDefined }} placeholder.

<Tabs>
  <Tab label="macOS">
    Install with **brew**.

    ### Verify

    Run \`acme --version\`.
  </Tab>
  <Tab label="Windows">Use winget.</Tab>
</Tabs>

<Callout type="warning">Careful *now*</Callout>

<Callout type="danger" title="Heads up">
Multi-line callout with a [guide](../guides/payments.md#capture-later).
</Callout>

<ApiOperation op="POST /v1/payments" />

<ApiOperation operationId="getPayment" source="payments-api" />

<ApiOperation op="DELETE /v1/nothing" />

Inline <ApiOperation operationId="createRefund" /> and <JiraStatus key="PAY-123" /> status.

<JiraStatus key="PAY-7" />

<Mystery foo="bar">Hidden **content** stays</Mystery>

<FeatureFlag name="beta">Flagged text</FeatureFlag>

<CodeGroup>
\`\`\`bash title="cURL"
curl {{ apiBaseUrl }}/v1/payments
\`\`\`
\`\`\`js
await fetch("{{ apiBaseUrl }}/v1/payments")
\`\`\`
</CodeGroup>

<Snippet name="support" />

{/* an MDX comment */}
`;

describe("MDX components", () => {
  let result: BuildResult;
  let article: string;
  before(async () => {
    const snippet = page("_snippets/support.md", "> [!NOTE]\n> Need help? Email {{ supportEmail }}.\n");
    const content = await readFile(join(acmeRoot, "api/openapi.yaml"), "utf8");
    result = await renderSite(
      siteInput([page("guides/components.mdx", MDX), page("guides/payments.md", "# Accept a payment\n\n## Capture later\n")], {
        snippets: new Map([["support", snippet]]),
        variables: { productName: "Acme", apiBaseUrl: "https://api.acme.example", supportEmail: "help@acme.example" },
        openapi: [{ sourceId: "payments-api", title: "Payments API", outDir: "reference/payments-api", content }],
        basePath: "/docs/",
      }),
    );
    article = articleOf(fileText(result, "guides/components/index.html"));
  });

  test("ESM is dropped and expressions are not evaluated", () => {
    assert.doesNotMatch(article, /import|export|Thing|flag/);
    assert.doesNotMatch(article, /an MDX comment/);
    // `{1 + 1}` renders nothing (neither "2" nor its source).
    assert.match(article, /<p>Inline {2}expression, Acme variable and \{\{ notDefined \}\} placeholder\.<\/p>/);
    assert.match(article, /<h1 id="[^"]+">Components for Acme<\/h1>/);
  });

  test("Tabs degrade to labelled sections with headings", () => {
    assert.match(
      article,
      /<div class="tabs" data-tabs=""><section class="tab-panel" data-tab-label="macOS"><h2 class="tab-heading">macOS<\/h2><p>Install with <strong>brew<\/strong>\.<\/p>/,
    );
    assert.match(article, /<h3 id="verify">Verify<\/h3>/);
    // A one-line <Tab> still becomes a panel.
    assert.match(article, /<section class="tab-panel" data-tab-label="Windows"><h2 class="tab-heading">Windows<\/h2><p>Use winget\.<\/p><\/section><\/div>/);
  });

  test("Callout renders an accessible aside (also when written on one line)", () => {
    assert.match(article, /<aside class="callout callout-warning" role="note"><p class="callout-title">Warning<\/p><p>Careful <em>now<\/em><\/p><\/aside>/);
    assert.match(
      article,
      /<aside class="callout callout-caution" role="note"><p class="callout-title">Heads up<\/p><p>Multi-line callout with a <a href="\.\.\/\.\.\/guides\/payments\/#capture-later">guide<\/a>\.<\/p><\/aside>/,
    );
    assert.doesNotMatch(article, /<p><aside/);
  });

  test("ApiOperation links to the operation reference page", () => {
    assert.match(
      article,
      /<div class="api-operation"><a class="api-operation-link" href="\.\.\/\.\.\/reference\/payments-api\/operations\/createPayment\/"><span class="method method-post">POST<\/span> <code class="api-path">\/v1\/payments<\/code> <span class="api-summary">Create a payment<\/span><\/a><\/div>/,
    );
    assert.match(article, /href="\.\.\/\.\.\/reference\/payments-api\/operations\/getPayment\/"><span class="method method-get">GET<\/span>/);
    assert.match(article, /<div class="api-operation api-operation-missing" data-component="ApiOperation"><code>DELETE \/v1\/nothing<\/code> \(not found in the API reference\)<\/div>/);
    assert.match(article, /<p>Inline <a class="api-operation-inline" href="\.\.\/\.\.\/reference\/payments-api\/operations\/createRefund\/"><span class="method method-post">POST<\/span> <code class="api-path">\/v1\/refunds<\/code><\/a> and/);
  });

  test("JiraStatus, FeatureFlag and unknown components", () => {
    assert.match(article, /<span class="jira-status" data-jira-key="PAY-123">PAY-123<\/span> status\./);
    assert.match(article, /<p><span class="jira-status" data-jira-key="PAY-7">PAY-7<\/span><\/p>/);
    assert.match(article, /<p>Flagged text<\/p>/);
    assert.match(article, /<div data-component="Mystery"><p>Hidden <strong>content<\/strong> stays<\/p><\/div>/);
    assert.doesNotMatch(article, /foo="bar"|FeatureFlag/);
  });

  test("CodeGroup turns code blocks into tabs labelled by title or language", () => {
    assert.match(
      article,
      /<div class="tabs code-group" data-tabs=""><section class="tab-panel" data-tab-label="cURL"><h2 class="tab-heading">cURL<\/h2><div class="code-block" data-lang="bash"><pre tabindex="0"><code class="language-bash">curl https:\/\/api\.acme\.example\/v1\/payments<\/code><\/pre><\/div><\/section>/,
    );
    assert.match(article, /<section class="tab-panel" data-tab-label="JavaScript"><h2 class="tab-heading">JavaScript<\/h2>/);
    assert.match(article, /await fetch\("https:\/\/api\.acme\.example\/v1\/payments"\)/);
  });

  test("<Snippet> inlines a snippet with variables applied", () => {
    assert.match(article, /<aside class="callout callout-note" role="note"><p class="callout-title">Note<\/p><p>Need help\? Email help@acme\.example\.<\/p><\/aside>/);
    assert.deepEqual(result.a11y, []);
  });
});

describe("Markdown features", () => {
  test("GFM alerts, task lists, footnotes, images, external and reference links", async () => {
    const source = `# Features

> [!TIP]
> Use **sandbox** keys first.

> [!caution]
> Irreversible.

> A plain quote.

- [x] Done
- [ ] Todo

Footnote reference[^1].

[^1]: The footnote.

![Flow diagram](../img/flow.png "Flow") and ![Logo](https://cdn.example/logo.svg)

[Example](https://example.com) and [protocol-relative](//cdn.example/x) and [mail](mailto:docs@example.com) and [section](#features) and [file](../files/report.pdf) and [ref][r] and [up](../../outside.md)

[r]: ./other.mdx#part
`;
    const result = await renderSite(siteInput([page("guides/features.md", source), page("guides/other.mdx", "# Other\n")]));
    const html = articleOf(fileText(result, "guides/features/index.html"));
    assert.match(html, /<aside class="callout callout-tip" role="note"><p class="callout-title">Tip<\/p><p>Use <strong>sandbox<\/strong> keys first\.<\/p><\/aside>/);
    assert.match(html, /<aside class="callout callout-caution" role="note"><p class="callout-title">Caution<\/p><p>Irreversible\.<\/p><\/aside>/);
    assert.match(html, /<blockquote>\n<p>A plain quote\.<\/p>\n<\/blockquote>/);
    assert.match(html, /<li class="task-list-item"><input type="checkbox" checked disabled> Done<\/li>/);
    assert.match(html, /<sup><a href="#user-content-fn-1" id="user-content-fnref-1" data-footnote-ref aria-describedby="footnote-label">1<\/a><\/sup>/);
    assert.match(html, /<section data-footnotes class="footnotes"><h2 class="sr-only" id="footnote-label">Footnotes<\/h2>/);
    assert.match(html, /<img src="\.\.\/\.\.\/img\/flow\.png" alt="Flow diagram" title="Flow" loading="lazy" decoding="async">/);
    assert.match(html, /<img src="https:\/\/cdn\.example\/logo\.svg" alt="Logo" loading="lazy" decoding="async">/);
    assert.match(html, /<a href="https:\/\/example\.com" rel="noopener noreferrer">Example<\/a>/);
    assert.match(html, /<a href="\/\/cdn\.example\/x" rel="noopener noreferrer">protocol-relative<\/a>/);
    assert.match(html, /<a href="mailto:docs@example\.com">mail<\/a>/);
    assert.match(html, /<a href="#features">section<\/a>/);
    assert.match(html, /<a href="\.\.\/\.\.\/files\/report\.pdf">file<\/a>/);
    assert.match(html, /<a href="\.\.\/\.\.\/guides\/other\/#part">ref<\/a>/);
    // Links that escape the docs root are left as written (the link checker reports them).
    assert.match(html, /<a href="\.\.\/\.\.\/outside\.md">up<\/a>/);
  });

  test("variables apply to component labels; alerts tolerate a hard break after the marker", async () => {
    const mdx = `# Labels\n\n<Tabs>\n  <Tab label="{{ productName }} CLI">CLI.</Tab>\n</Tabs>\n\n<Callout type="tip" title="About {{ productName }}">Text.</Callout>\n`;
    const md = "# Alert\n\n> [!WARNING]  \n> Hard break after the marker.\n";
    const result = await renderSite(siteInput([page("labels.mdx", mdx), page("alert.md", md)], { variables: { productName: "Acme" } }));
    const labels = articleOf(fileText(result, "labels/index.html"));
    assert.match(labels, /<section class="tab-panel" data-tab-label="Acme CLI"><h2 class="tab-heading">Acme CLI<\/h2>/);
    assert.match(labels, /<p class="callout-title">About Acme<\/p>/);
    const alert = articleOf(fileText(result, "alert/index.html"));
    assert.match(alert, /<aside class="callout callout-warning" role="note"><p class="callout-title">Warning<\/p><p>Hard break after the marker\.<\/p><\/aside>/);
  });

  test("raw HTML is dropped, not escaped into the page", async () => {
    const result = await renderSite(siteInput([page("raw.md", "# Raw\n\n<div class=\"x\">\n\n**kept**\n\n</div>\n\nText <kbd>Ctrl</kbd> here.\n")]));
    const html = articleOf(fileText(result, "raw/index.html"));
    assert.match(html, /<p><strong>kept<\/strong><\/p>/);
    assert.match(html, /<p>Text Ctrl here\.<\/p>/);
    assert.doesNotMatch(html, /&#x3C;div|<div class="x"/);
  });

  test("nested snippets, inline snippets and missing snippets", async () => {
    const snippets = new Map([
      ["outer", page("_snippets/outer.md", "Outer {{ name }}.\n\n<!-- docops:snippet name=\"inner\" -->\n")],
      ["inner", page("_snippets/inner.md", "## Inner heading\n\nSee [the guide](../guides/a.md).\n")],
      ["loop", page("_snippets/loop.md", "Loop.\n\n<!-- docops:snippet name=\"loop\" -->\n")],
      ["word", page("_snippets/word.md", "inline *words*\n")],
    ]);
    const source = `# Page\n\n## Inner heading\n\n<!-- docops:snippet name="outer" -->\n\nBefore <!-- docops:snippet name="word" --> after.\n\n<!-- docops:snippet name="loop" -->\n\n<!-- docops:snippet name="missing" -->\n`;
    const result = await renderSite(siteInput([page("guides/page.md", source)], { snippets, variables: { name: "World" } }));
    const html = articleOf(fileText(result, "guides/page/index.html"));
    assert.match(html, /<p>Outer World\.<\/p>/);
    // Snippet links resolve relative to the snippet file; snippet headings get unique anchors.
    assert.match(html, /<h2 id="inner-heading">Inner heading<\/h2>/);
    assert.match(html, /<h2 id="inner-heading-1">Inner heading<\/h2>/);
    assert.match(html, /<a href="\.\.\/\.\.\/guides\/a\/">the guide<\/a>/);
    assert.match(html, /<p>Before inline <em>words<\/em> after\.<\/p>/);
    // A recursive snippet is expanded once, never infinitely.
    assert.equal(html.match(/<p>Loop\.<\/p>/g)?.length, 1);
    assert.doesNotMatch(html, /missing|docops:snippet/);
  });
});
