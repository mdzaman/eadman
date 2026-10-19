import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { CONTENT_SECURITY_POLICY, renderSite, type BuildResult, type SearchEntry } from "../src/index.ts";
import { acmeInput, articleOf, fileText, hasFile, htmlFiles, startTags } from "./helpers.ts";

const PUBLIC_OPERATIONS = ["createPayment", "listPayments", "getPayment", "capturePayment", "createRefund"];

describe("acme-payments example", () => {
  let result: BuildResult;
  before(async () => {
    result = await renderSite(await acmeInput());
  });

  test("emits pretty-URL pages, assets and site files", () => {
    for (const path of [
      "index.html",
      "guides/payments/index.html",
      "guides/refunds/index.html",
      "concepts/idempotency/index.html",
      "runbooks/payments-outage/index.html",
      "404.html",
      "search-index.json",
      "sitemap.xml",
      "robots.txt",
      "assets/docops.css",
      "assets/theme.css",
      "assets/docops.js",
    ]) {
      assert.ok(hasFile(result, path), `missing ${path}`);
    }
    // Snippets are inlined, never rendered as pages.
    assert.equal(result.files.some((f) => f.path.includes("_snippets")), false);
    assert.equal(result.stats.pages, 5);
    assert.equal(result.stats.referencePages, 1 + 2 + PUBLIC_OPERATIONS.length); // index + 2 tags + operations
    assert.equal(result.stats.files, result.files.length);
    assert.equal(result.stats.bytes, result.files.reduce((n, f) => n + f.size, 0));
  });

  test("rewrites internal .md links to pretty URLs relative to the linking page", () => {
    const html = articleOf(fileText(result, "guides/payments/index.html"));
    assert.match(html, /<a href="\.\.\/\.\.\/guides\/refunds\/#partial-refunds">partial refunds<\/a>/);
    assert.match(html, /<a href="\.\.\/\.\.\/concepts\/idempotency\/">idempotency key<\/a>/);
    const home = articleOf(fileText(result, "index.html"));
    assert.match(home, /href="\.\/guides\/payments\/"/);
    assert.doesNotMatch(home, /\.md"/);
  });

  test("substitutes variables in code blocks, inline code and text", () => {
    const html = articleOf(fileText(result, "guides/payments/index.html"));
    assert.match(html, /<code class="language-bash">curl -X POST https:\/\/api\.acme\.example\/v1\/payments \\/);
    assert.doesNotMatch(html, /\{\{\s*apiBaseUrl\s*\}\}/);
    const home = articleOf(fileText(result, "index.html"));
    assert.match(home, /<p>Acme Payments lets you accept card and bank payments/);
    assert.match(home, /<code>https:\/\/api\.acme\.example<\/code>/);
  });

  test("inlines the support snippet as a note callout with variables applied", () => {
    for (const path of ["guides/refunds/index.html", "index.html"]) {
      const html = articleOf(fileText(result, path));
      assert.match(
        html,
        /<aside class="callout callout-note" role="note"><p class="callout-title">Note<\/p><p>Need help\? Email payments-support@acme\.example\.<\/p><\/aside>/,
        path,
      );
      assert.doesNotMatch(html, /docops:snippet|\[!NOTE\]/);
    }
  });

  test("generates reference pages for public operations only", () => {
    for (const id of PUBLIC_OPERATIONS) {
      const html = fileText(result, `reference/payments-api/operations/${id}/index.html`);
      assert.match(html, new RegExp(`<article id="op-${id}"`), id);
    }
    assert.ok(hasFile(result, "reference/payments-api/index.html"));
    assert.ok(hasFile(result, "reference/payments-api/tags/payments/index.html"));
    assert.ok(hasFile(result, "reference/payments-api/tags/refunds/index.html"));
    // x-internal: true operation is excluded everywhere: pages, sidebar and search.
    assert.equal(result.files.some((f) => /reconcile/i.test(f.path)), false);
    for (const { path, html } of htmlFiles(result)) assert.doesNotMatch(html, /reconcile/i, path);
    assert.doesNotMatch(fileText(result, "search-index.json"), /reconcile/i);
  });

  test("operation pages document parameters, bodies, responses, security and samples", () => {
    const create = fileText(result, "reference/payments-api/operations/createPayment/index.html");
    assert.match(create, /<h1><span class="method method-post">POST<\/span> <code class="api-path">\/v1\/payments<\/code><\/h1>/);
    assert.match(create, /<p class="api-summary lead">Create a payment<\/p>/);
    assert.match(create, /<caption id="table-1">Header parameters<\/caption>/);
    assert.match(create, /<th scope="row"><code>Idempotency-Key<\/code><\/th><td>string<\/td><td>optional<\/td>/);
    assert.match(create, /<caption id="table-2">Request body \(application\/json\)<\/caption>/);
    assert.match(create, /<th scope="row"><code>amount<\/code><\/th><td>integer<\/td><td>required<\/td>/);
    assert.match(create, /Allowed: <code>usd<\/code>, <code>eur<\/code>, <code>gbp<\/code>/);
    assert.match(create, /<h3 id="response-201">201 Created<\/h3>/);
    assert.match(create, /<h3 id="response-409">409 Conflict<\/h3>/);
    assert.match(create, /Requires <code>bearerAuth<\/code> — HTTP bearer token\./);
    // curl + fetch samples using the first server and the media-type example.
    assert.match(create, /curl -X POST 'https:\/\/api\.acme\.example\/v1\/payments' \\/);
    assert.match(create, /-H "Authorization: Bearer \$API_TOKEN"/);
    assert.match(create, /"amount": 2000/);
    assert.match(create, /const response = await fetch\("https:\/\/api\.acme\.example\/v1\/payments", \{/);
    assert.match(create, /body: JSON\.stringify\(\{/);

    const list = fileText(result, "reference/payments-api/operations/listPayments/index.html");
    assert.match(list, /<caption id="table-1">Query parameters<\/caption>/);
    assert.match(list, /Default: <code>20<\/code>/);
    assert.match(list, /<th scope="row"><code>data\[\]\.status<\/code><\/th><td>string \(PaymentStatus\)<\/td><td>required<\/td>/);
    assert.match(list, /<td>array of Payment<\/td>/);

    const get = fileText(result, "reference/payments-api/operations/getPayment/index.html");
    // Path parameters stay as placeholders in the samples.
    assert.match(get, /curl '?https:\/\/api\.acme\.example\/v1\/payments\/\{payment_id\}/);
    assert.match(get, /<caption id="table-1">Path parameters<\/caption>/);
    assert.match(get, /<th scope="row"><code>payment_id<\/code><\/th><td>string<\/td><td>required<\/td>/);
  });

  test("operation pages include a progressive-enhancement Try it console", () => {
    const html = fileText(result, "reference/payments-api/operations/createPayment/index.html");
    assert.match(html, /<section class="try-it" data-try-it="" hidden aria-labelledby="try-it">/);
    assert.match(html, /<select id="try-it-server" name="server"><option value="https:\/\/api\.acme\.example">Production/);
    assert.match(html, /<input id="try-it-token" name="token" type="password" autocomplete="off"/);
    assert.match(html, /<textarea id="try-it-body" name="body"[^>]*>\{\n {2}"amount": 2000/);
    assert.match(html, /<button type="submit" class="button">Send request<\/button>/);
    assert.match(html, /<pre class="try-it-response" aria-live="polite"/);
    const get = fileText(result, "reference/payments-api/operations/getPayment/index.html");
    assert.match(get, /data-param-in="path" data-param-name="payment_id" required/);
  });

  test("reference index lists servers, security schemes and operations by tag", () => {
    const html = articleOf(fileText(result, "reference/payments-api/index.html"));
    assert.match(html, /<h1>Acme Payments API<\/h1>/);
    assert.match(html, /Version <code>2\.4\.0<\/code>/);
    assert.match(html, /<p>Accept card and bank payments and issue refunds\.<\/p>/);
    assert.match(html, /<code>https:\/\/sandbox\.api\.acme\.example<\/code> — Sandbox/);
    assert.match(html, /<caption id="table-1">Security schemes<\/caption>/);
    assert.match(html, /<h2 id="tag-payments">Payments<\/h2>/);
    assert.match(html, /<h2 id="tag-refunds">Refunds<\/h2>/);
    assert.match(html, /href="\.\.\/\.\.\/reference\/payments-api\/operations\/createRefund\/"/);
  });

  test("every table has column header cells", () => {
    for (const { path, html } of htmlFiles(result)) {
      const tables = html.match(/<table[\s>][\s\S]*?<\/table>/g) ?? [];
      for (const table of tables) assert.match(table, /<th scope="col">/, path);
    }
    assert.match(fileText(result, "guides/refunds/index.html"), /<th scope="col">Field<\/th>/);
  });

  test("layout: lang, skip link first, landmarks, current page and CSP", () => {
    for (const { path, html } of htmlFiles(result)) {
      assert.match(html, /^<!doctype html>\n<html lang="en"/, path);
      assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`), path);
      assert.match(html, /<meta charset="utf-8">/, path);
      assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, path);
      // The skip link is the first focusable element in <body>.
      const body = html.slice(html.indexOf("<body>"));
      const firstFocusable = /<(a|button|input|select|textarea)\b[^>]*>/.exec(body)?.[0];
      assert.equal(firstFocusable, `<a class="skip-link" href="#content">`, path);
      assert.match(html, /<main id="content" tabindex="-1">/, path);
      assert.match(html, /<nav class="sidebar" aria-label="Documentation">/, path);
      assert.match(html, /<form class="search" role="search" method="get"><label for="docops-search-input" class="search-label">Search<\/label>/, path);
    }
    const html = fileText(result, "guides/payments/index.html");
    assert.match(html, /<title>Accept a payment · Acme Payments Docs<\/title>/);
    assert.match(html, /<a href="\.\.\/\.\.\/guides\/payments\/" aria-current="page">Accept a payment<\/a>/);
    assert.equal(html.match(/aria-current="page"/g)?.length, 2); // sidebar + version switcher
    assert.match(html, /<nav class="version-switcher" aria-label="Versions">[\s\S]*<a href="\/" aria-current="page">2\.4<\/a><\/li><li><a href="\/2\.3\/">2\.3<\/a>/); // configured version URLs are kept as given
    assert.match(html, /<link rel="canonical" href="https:\/\/docs\.acme\.example\/payments\/guides\/payments\/">/);
    assert.match(html, /<script src="\.\.\/\.\.\/assets\/docops\.js" defer><\/script>/);
  });

  test("sidebar follows the directory tree with the index first", () => {
    const html = fileText(result, "guides/refunds/index.html");
    const sidebar = html.slice(html.indexOf('<nav class="sidebar"'), html.indexOf("</nav>", html.indexOf('<nav class="sidebar"')));
    const labels = [...sidebar.matchAll(/<(?:a href="[^"]*"(?: aria-current="page")?|span class="nav-group")>(.*?)<\/(?:a|span)>/g)].map((m) => m[1]);
    assert.deepEqual(labels.slice(0, 8), [
      "Acme Payments",
      "Concepts",
      "Idempotent requests",
      "Guides",
      "Accept a payment",
      "Refund a payment",
      "Runbooks",
      "Runbook: payment processor timeouts",
    ]);
    assert.match(sidebar, /<span class="nav-group">Payments API reference<\/span><ul><li><a href="\.\.\/\.\.\/reference\/payments-api\/">Overview<\/a>/);
    assert.match(sidebar, /<span class="method method-post">POST<\/span> Create a payment<\/a>/);
  });

  test("headings get ParsedPage anchors, a self-link and an on-page TOC", () => {
    const html = fileText(result, "guides/payments/index.html");
    assert.match(html, /<h1 id="accept-a-payment">Accept a payment<\/h1>/);
    assert.match(
      html,
      /<div class="heading-wrapper"><h2 id="capture-later">Capture later<\/h2><a class="heading-anchor" href="#capture-later" aria-label="Link to section: Capture later">#<\/a><\/div>/,
    );
    assert.match(
      html,
      /<nav class="toc" aria-label="On this page"><p class="toc-title" aria-hidden="true">On this page<\/p><ul><li><a href="#capture-later">Capture later<\/a><\/li><li><a href="#check-a-payment">Check a payment<\/a><\/li><\/ul><\/nav>/,
    );
    // Fewer than two h2/h3 headings: no TOC.
    assert.doesNotMatch(fileText(result, "concepts/idempotency/index.html"), /aria-label="On this page"/);
  });

  test("page footer shows review date, owners, tickets and the edit link", () => {
    const html = fileText(result, "guides/payments/index.html");
    const footer = html.slice(html.indexOf('<footer class="page-footer">'));
    assert.match(footer, /<dt>Last reviewed<\/dt><dd><time datetime="2026-09-15">2026-09-15<\/time><\/dd>/);
    assert.match(footer, /<dt>Owners<\/dt><dd>@acme\/payments-docs<\/dd>/);
    assert.match(footer, /<dt>Tickets<\/dt><dd>PAY-101<\/dd>/);
    assert.match(
      footer,
      /<a href="https:\/\/github\.com\/acme\/payments\/edit\/main\/docs\/guides\/payments\.md" rel="noopener noreferrer">Edit this page<\/a>/,
    );
    assert.doesNotMatch(footer, /stale-warning/);
  });

  test("no inline scripts or style attributes anywhere (strict CSP)", () => {
    for (const { path, html } of htmlFiles(result)) {
      const tags = startTags(html);
      const scripts = tags.filter((t) => t.name === "script");
      assert.equal(scripts.length, 1, path);
      // Pages link relative to their own depth; 404.html is served at any depth, so it uses the base path.
      const depth = path.split("/").length - 1;
      const expected = path === "404.html" ? "/assets/docops.js" : `${depth === 0 ? "./" : "../".repeat(depth)}assets/docops.js`;
      assert.equal(scripts[0]?.attributes.get("src"), expected, path);
      assert.doesNotMatch(html, /<script\b[^>]*>[^<]+<\/script>/, path);
      assert.ok(!tags.some((t) => t.name === "style"), `${path}: <style>`);
      for (const tag of tags) {
        assert.ok(!tag.attributes.has("style"), `${path}: <${tag.name} style>`);
        assert.ok(![...tag.attributes.keys()].some((name) => name.startsWith("on")), `${path}: <${tag.name}> event handler`);
      }
    }
  });

  test("links are relative, so one build works under any path prefix", () => {
    for (const file of result.files) {
      assert.doesNotMatch(fileText(result, file.path), /__docops_base__/, file.path);
    }
    const html = fileText(result, "guides/payments/index.html");
    assert.match(html, /<html lang="en" data-base-path="\.\.\/\.\.\/"/);
    // Mounted where the API serves a promoted build, every link stays inside that deployment.
    const page = new URL("https://docops.test/sites/acme/payments/prod/guides/payments/");
    for (const m of html.matchAll(/(?:href|src)="(\.[^"]*)"/g)) {
      assert.ok(new URL(m[1] ?? "", page).pathname.startsWith("/sites/acme/payments/prod/"), m[1]);
    }
  });

  test("search index covers content and reference pages", () => {
    const entries = JSON.parse(fileText(result, "search-index.json")) as SearchEntry[];
    const urls = entries.map((e) => e.url);
    // Relative to the site root; the portal script prefixes them with the page's data-base-path.
    assert.ok(urls.includes("guides/payments/"));
    assert.ok(urls.includes("reference/payments-api/operations/createPayment/"));
    assert.equal(entries.length, result.stats.pages + result.stats.referencePages);
    const payments = entries.find((e) => e.url === "guides/payments/");
    assert.equal(payments?.title, "Accept a payment");
    assert.deepEqual(payments?.headings, ["Capture later", "Check a payment"]);
    assert.equal(payments?.version, "2.4");
    assert.match(payments?.text ?? "", /^Accept a payment Create a payment with POST \/v1\/payments\. Send an idempotency key/);
    for (const entry of entries) {
      assert.ok(entry.text.split(/\s+/).length <= 300, entry.url);
      assert.doesNotMatch(entry.text, /curl -X/, "code blocks are not indexed");
    }
  });

  test("404, sitemap, robots.txt and theme", () => {
    const notFound = fileText(result, "404.html");
    assert.match(notFound, /<title>Page not found · Acme Payments Docs<\/title>/);
    assert.match(notFound, /<meta name="robots" content="noindex">/);
    assert.match(notFound, /<a href="\/">Go to the documentation home page<\/a>/);

    const sitemap = fileText(result, "sitemap.xml");
    assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(sitemap, /<loc>https:\/\/docs\.acme\.example\/payments\/guides\/payments\/<\/loc>/);
    assert.match(sitemap, /<loc>https:\/\/docs\.acme\.example\/payments\/reference\/payments-api\/operations\/createPayment\/<\/loc>/);
    assert.doesNotMatch(sitemap, /404/);

    assert.equal(fileText(result, "robots.txt"), "User-agent: *\nAllow: /\n\nSitemap: https://docs.acme.example/payments/sitemap.xml\n");
    assert.match(fileText(result, "assets/theme.css"), /--docops-primary: #0b5fff;/);
  });

  test("files carry content types, digests and sizes", () => {
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    assert.equal(byPath.get("index.html")?.contentType, "text/html; charset=utf-8");
    assert.equal(byPath.get("assets/docops.css")?.contentType, "text/css; charset=utf-8");
    assert.equal(byPath.get("assets/docops.js")?.contentType, "text/javascript; charset=utf-8");
    assert.equal(byPath.get("search-index.json")?.contentType, "application/json; charset=utf-8");
    assert.equal(byPath.get("sitemap.xml")?.contentType, "application/xml; charset=utf-8");
    assert.equal(byPath.get("robots.txt")?.contentType, "text/plain; charset=utf-8");
  });

  test("the example is free of accessibility findings", () => {
    assert.deepEqual(result.a11y, []);
  });
});
