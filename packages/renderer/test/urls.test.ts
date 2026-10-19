import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pageOutputPath, pageUrl, resolveDocUrl, substituteVariables } from "../src/index.ts";

describe("pageUrl", () => {
  test("maps page paths to pretty URLs under the base path", () => {
    assert.equal(pageUrl("guides/payments.md", "/"), "/guides/payments/");
    assert.equal(pageUrl("index.md", "/"), "/");
    assert.equal(pageUrl("a/index.md", "/"), "/a/");
    assert.equal(pageUrl("a/b/index.mdx", "/"), "/a/b/");
    assert.equal(pageUrl("guides/payments.md", "/payments/2.4/"), "/payments/2.4/guides/payments/");
    assert.equal(pageUrl("index.md", "/payments/2.4/"), "/payments/2.4/");
    assert.equal(pageUrl("tutorial.mdx", "/docs"), "/docs/tutorial/");
  });

  test("maps page paths to output files", () => {
    assert.equal(pageOutputPath("guides/payments.md"), "guides/payments/index.html");
    assert.equal(pageOutputPath("index.md"), "index.html");
    assert.equal(pageOutputPath("a/index.mdx"), "a/index.html");
  });
});

describe("resolveDocUrl", () => {
  const ctx = { basePath: "/v2/", docsRoot: "docs" };

  test("rewrites links to Markdown pages relative to the linking page", () => {
    assert.equal(resolveDocUrl("refunds.md#partial-refunds", "guides/payments.md", ctx), "/v2/guides/refunds/#partial-refunds");
    assert.equal(resolveDocUrl("../concepts/idempotency.md", "guides/payments.md", ctx), "/v2/concepts/idempotency/");
    assert.equal(resolveDocUrl("./sub/index.mdx?tab=1#x", "guides/payments.md", ctx), "/v2/guides/sub/?tab=1#x");
    assert.equal(resolveDocUrl("../index.md", "guides/payments.md", ctx), "/v2/");
    assert.equal(resolveDocUrl("guides/my%20page.md", "index.md", ctx), "/v2/guides/my page/");
  });

  test("repo-absolute links into the docs root resolve; other absolute paths are kept", () => {
    assert.equal(resolveDocUrl("/docs/guides/refunds.md", "index.md", ctx), "/v2/guides/refunds/");
    assert.equal(resolveDocUrl("/guides/refunds.md", "index.md", ctx), "/v2/guides/refunds/");
    assert.equal(resolveDocUrl("/status", "index.md", ctx), "/status");
  });

  test("assets resolve under the base path; external, anchors and schemes are untouched", () => {
    assert.equal(resolveDocUrl("img/flow.png", "guides/payments.md", ctx), "/v2/guides/img/flow.png");
    assert.equal(resolveDocUrl("../files/", "guides/payments.md", ctx), "/v2/files/");
    assert.equal(resolveDocUrl("https://example.com/a.md", "index.md", ctx), "https://example.com/a.md");
    assert.equal(resolveDocUrl("//cdn.example/x.png", "index.md", ctx), "//cdn.example/x.png");
    assert.equal(resolveDocUrl("mailto:docs@example.com", "index.md", ctx), "mailto:docs@example.com");
    assert.equal(resolveDocUrl("#section", "index.md", ctx), "#section");
    assert.equal(resolveDocUrl("javascript:alert(1)", "index.md", ctx), "javascript:alert(1)"); // removed later by the sanitizer
    assert.equal(resolveDocUrl("../../outside.md", "guides/a.md", ctx), "../../outside.md");
  });
});

describe("substituteVariables", () => {
  const vars = { productName: "Acme Payments", port: 8443, beta: false, "api.base": "https://api" };

  test("replaces known variables with or without spaces", () => {
    assert.equal(substituteVariables("{{ productName }} on {{port}} (beta: {{ beta }})", vars), "Acme Payments on 8443 (beta: false)");
    assert.equal(substituteVariables("{{api.base}}/v1", vars), "https://api/v1");
  });

  test("leaves unknown variables and non-variables untouched", () => {
    assert.equal(substituteVariables("{{ unknown }} and {{ productName", vars), "{{ unknown }} and {{ productName");
    assert.equal(substituteVariables("{ productName } {{ 1 + 1 }}", vars), "{ productName } {{ 1 + 1 }}");
    assert.equal(substituteVariables("{{ toString }}", vars), "{{ toString }}");
  });
});
