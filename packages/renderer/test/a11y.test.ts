import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderSite } from "../src/index.ts";
import { fileText, page, siteInput } from "./helpers.ts";

describe("static accessibility audit", () => {
  test("flags images without alt text and skipped heading levels with source lines", async () => {
    const source = `---
title: Diagram
---

# Diagram

![](img/flow.png)

#### Too deep

Text.
`;
    const result = await renderSite(siteInput([page("guides/diagram.md", source)]));
    assert.deepEqual(result.a11y, [
      { page: "guides/diagram.md", rule: "a11y/img-alt", message: 'Image "/guides/img/flow.png" has empty alt text; describe the image', line: 7 },
      { page: "guides/diagram.md", rule: "a11y/heading-order", message: "Heading level skipped: h1 is followed by h4", line: 9 },
    ]);
  });

  test("flags non-descriptive link text, duplicate h1s and empty table headers", async () => {
    const source = `# First

Read the guide [here](other.md) or [click here](https://example.com), or [Read more…](other.md).

[Payments guide](other.md) is fine.

# Second

|   |   |
|---|---|
| a | b |
`;
    const result = await renderSite(siteInput([page("links.md", source), page("other.md", "# Other\n")]));
    const issues = result.a11y.map((i) => [i.rule, i.line, i.message]);
    assert.deepEqual(issues, [
      ["a11y/link-text", 3, 'Link text "here" is not descriptive; say where the link goes'],
      ["a11y/link-text", 3, 'Link text "click here" is not descriptive; say where the link goes'],
      ["a11y/link-text", 3, 'Link text "Read more…" is not descriptive; say where the link goes'],
      ["a11y/heading-order", 7, "More than one h1 heading on the page; use h2 for sections"],
      ["a11y/table-headers", 9, "Table header cells are empty"],
    ]);
  });

  test("pages without an h1 get the title as h1, so h2 sections are not a skip", async () => {
    const result = await renderSite(siteInput([page("notes.md", "---\ntitle: Release notes\n---\n\n## 2.4.0\n\nChanges.\n")]));
    assert.deepEqual(result.a11y, []);
    assert.match(fileText(result, "notes/index.html"), /<article class="doc"><h1>Release notes<\/h1>/);
  });

  test("issues inside snippets are reported at the including directive's line", async () => {
    const snippets = new Map([["logo", page("_snippets/logo.md", "![](logo.png)\n")]]);
    const result = await renderSite(siteInput([page("a.md", "# A\n\nIntro.\n\n<!-- docops:snippet name=\"logo\" -->\n")], { snippets }));
    assert.deepEqual(
      result.a11y.map((i) => [i.page, i.rule, i.line]),
      [["a.md", "a11y/img-alt", 5]],
    );
  });

  test("an invalid site language is reported once and falls back to en", async () => {
    const result = await renderSite(siteInput([page("a.md", "# A\n")], { site: { title: "T", lang: "" } }));
    assert.deepEqual(result.a11y, [
      { page: "*", rule: "a11y/html-lang", message: 'site.lang "" is not a valid BCP 47 language tag; pages use lang="en"' },
    ]);
    assert.match(fileText(result, "a/index.html"), /<html lang="en"/);
    const german = await renderSite(siteInput([page("a.md", "# A\n")], { site: { title: "T", lang: "de-CH" } }));
    assert.match(fileText(german, "a/index.html"), /<html lang="de-CH"/);
    assert.deepEqual(german.a11y, []);
  });

  test("generated components keep the heading outline intact", async () => {
    const source = `# Install

<Tabs>
  <Tab label="npm">Run npm.</Tab>
  <Tab label="pnpm">Run pnpm.</Tab>
</Tabs>

## Configure

### Options

<Tabs>
  <Tab label="YAML">Write YAML.</Tab>
</Tabs>
`;
    const result = await renderSite(siteInput([page("install.mdx", source)]));
    assert.deepEqual(result.a11y, []);
    const html = fileText(result, "install/index.html");
    assert.match(html, /<h2 class="tab-heading">npm<\/h2>/);
    assert.match(html, /<h4 class="tab-heading">YAML<\/h4>/);
  });
});
