import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { canonicalJson } from "@docops/core";
import { parseMarkdown } from "@docops/markdown";
import { RENDERER_VERSION, renderSite, type BuildResult } from "../src/index.ts";
import { acmeInput, fileText, hasFile, htmlFiles, page, siteInput } from "./helpers.ts";

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

describe("manifest and determinism", () => {
  test("every file has a sha256 digest and byte size; output is sorted", async () => {
    const result = await renderSite(await acmeInput());
    assert.equal(result.manifest.schema, "docops.build.v1");
    assert.equal(result.manifest.rendererVersion, RENDERER_VERSION);
    const paths = result.files.map((f) => f.path);
    assert.deepEqual(paths, [...paths].sort());
    for (const file of result.files) {
      assert.equal(file.digest, sha256(file.content), file.path);
      assert.equal(file.size, Buffer.byteLength(file.content), file.path);
    }
    assert.deepEqual(
      result.manifest.files,
      result.files.map(({ path, digest, size, contentType }) => ({ path, digest, size, contentType })),
    );
    assert.deepEqual(
      result.manifest.pages.map((p) => [p.source, p.url, p.title]),
      [
        ["concepts/idempotency.md", "/concepts/idempotency/", "Idempotent requests"],
        ["guides/payments.md", "/guides/payments/", "Accept a payment"],
        ["guides/refunds.md", "/guides/refunds/", "Refund a payment"],
        ["index.md", "/", "Acme Payments"],
        ["runbooks/payments-outage.md", "/runbooks/payments-outage/", "Runbook: payment processor timeouts"],
      ],
    );
  });

  test("inputHash = sha256(source + used snippet sources + variables JSON + renderer version)", async () => {
    const input = await acmeInput();
    const result = await renderSite(input);
    const refunds = input.pages.find((p) => p.path === "guides/refunds.md");
    const payments = input.pages.find((p) => p.path === "guides/payments.md");
    const support = input.snippets.get("support");
    assert.ok(refunds && payments && support);
    const vars = canonicalJson(input.variables);
    const hashOf = (source: string) => result.manifest.pages.find((p) => p.source === source)?.inputHash;
    assert.equal(hashOf("guides/refunds.md"), sha256(refunds.source + support.source + vars + RENDERER_VERSION));
    assert.equal(hashOf("guides/payments.md"), sha256(payments.source + vars + RENDERER_VERSION));
  });

  test("the same input renders byte-identical output and manifest", async () => {
    const first = await renderSite(await acmeInput());
    const second = await renderSite(await acmeInput());
    assert.deepEqual(second.manifest, first.manifest);
    assert.deepEqual(
      second.files.map((f) => [f.path, f.content]),
      first.files.map((f) => [f.path, f.content]),
    );
    assert.deepEqual(second.stats, first.stats);
    // Page order in the input does not matter.
    const input = await acmeInput();
    const reversed = await renderSite({ ...input, pages: [...input.pages].reverse() });
    assert.deepEqual(reversed.manifest, first.manifest);
  });

  test("cachedPages counts pages whose inputHash is unchanged", async () => {
    const input = await acmeInput();
    const first = await renderSite(input);
    assert.equal(first.stats.cachedPages, 0);

    const unchanged = await renderSite({ ...input, previousManifest: first.manifest });
    assert.equal(unchanged.stats.cachedPages, unchanged.stats.pages);

    const pages = input.pages.map((p) =>
      p.path === "concepts/idempotency.md" ? parseMarkdown(p.path, `${p.source}\nOne more sentence.\n`) : p,
    );
    const edited = await renderSite({ ...input, pages, previousManifest: first.manifest });
    assert.equal(edited.stats.cachedPages, edited.stats.pages - 1);

    // A snippet change invalidates exactly the pages that inline it.
    const snippets = new Map(input.snippets);
    snippets.set("support", parseMarkdown("_snippets/support.md", "> [!NOTE]\n> Ask {{ supportEmail }}.\n"));
    const snippetChange = await renderSite({ ...input, snippets, previousManifest: first.manifest });
    assert.equal(snippetChange.stats.cachedPages, snippetChange.stats.pages - 2); // index.md and guides/refunds.md

    // Variables feed every page.
    const varsChange = await renderSite({ ...input, variables: { ...input.variables, productName: "Acme Pay" }, previousManifest: first.manifest });
    assert.equal(varsChange.stats.cachedPages, 0);
  });
});

describe("site options", () => {
  test("preview builds: banner, noindex, robots disallow, no sitemap or canonical", async () => {
    const result: BuildResult = await renderSite(await acmeInput({ preview: true }));
    for (const { path, html } of htmlFiles(result)) {
      assert.match(html, /<meta name="robots" content="noindex">/, path);
      assert.match(html, /<a class="skip-link" href="#content">Skip to content<\/a>\n<div class="preview-banner" role="status">Preview build<\/div>/, path);
      assert.doesNotMatch(html, /rel="canonical"/, path);
    }
    assert.equal(fileText(result, "robots.txt"), "User-agent: *\nDisallow: /\n");
    assert.equal(hasFile(result, "sitemap.xml"), false);

    const normal = await renderSite(await acmeInput());
    const html = fileText(normal, "guides/payments/index.html");
    assert.doesNotMatch(html, /preview-banner|name="robots"/);
  });

  test("sitemap is skipped without site.baseUrl", async () => {
    const input = await acmeInput();
    const result = await renderSite({ ...input, site: { ...input.site, baseUrl: undefined } });
    assert.equal(hasFile(result, "sitemap.xml"), false);
    assert.equal(fileText(result, "robots.txt"), "User-agent: *\nAllow: /\n");
    assert.doesNotMatch(fileText(result, "index.html"), /rel="canonical"/);
  });

  test("basePath sets canonical, sitemap, manifest and 404 URLs; page links stay relative", async () => {
    const result = await renderSite(
      await acmeInput({
        basePath: "/payments/2.4/",
        version: { name: "2.4", available: [{ name: "2.5", url: "/payments/2.5/" }, { name: "2.4", url: "/payments/2.4/" }] },
      }),
    );
    const html = fileText(result, "guides/payments/index.html");
    // Links inside pages are relative, so the same build also works when mounted elsewhere.
    assert.match(html, /<html lang="en" data-base-path="\.\.\/\.\.\/" data-version="2\.4">/);
    assert.match(html, /<link rel="stylesheet" href="\.\.\/\.\.\/assets\/docops\.css">/);
    assert.match(html, /<script src="\.\.\/\.\.\/assets\/docops\.js" defer><\/script>/);
    assert.match(html, /<a href="\.\.\/\.\.\/guides\/refunds\/#partial-refunds">partial refunds<\/a>/);
    assert.match(html, /<a class="site-title" href="\.\.\/\.\.\/">/);
    assert.match(html, /href="\.\.\/\.\.\/reference\/payments-api\/operations\/createPayment\/"/);
    // Configured version URLs point at other builds and are kept as given.
    assert.match(html, /<li><a href="\/payments\/2\.5\/">2\.5<\/a><\/li><li><a href="\/payments\/2\.4\/" aria-current="page">2\.4<\/a><\/li>/);
    // Absolute URLs use basePath; the baseUrl path is not duplicated when basePath already contains it.
    assert.match(html, /<link rel="canonical" href="https:\/\/docs\.acme\.example\/payments\/2\.4\/guides\/payments\/">/);
    assert.match(fileText(result, "sitemap.xml"), /<loc>https:\/\/docs\.acme\.example\/payments\/2\.4\/guides\/payments\/<\/loc>/);
    assert.ok(result.manifest.pages.every((p) => p.url.startsWith("/payments/2.4/")));
    // A CDN serves 404.html at any depth, so its links are absolute.
    assert.match(fileText(result, "404.html"), /<script src="\/payments\/2\.4\/assets\/docops\.js" defer><\/script>/);
    // Output paths and search URLs stay relative to the build root.
    assert.ok(hasFile(result, "guides/payments/index.html"));
    const entries = JSON.parse(fileText(result, "search-index.json")) as Array<{ url: string }>;
    assert.ok(entries.every((e) => !e.url.startsWith("/") && !e.url.includes("__docops_base__")));
  });

  test("pageMeta overrides frontmatter: tickets link out and stale pages warn", async () => {
    const pageMeta = new Map([
      [
        "guides/payments.md",
        {
          owners: ["@acme/payments-docs", "@acme/sre"],
          tickets: [{ key: "PAY-101", url: "https://acme.atlassian.net/browse/PAY-101" }, { key: "PAY-102" }],
          reviewed: "2025-01-02",
          stale: true,
        },
      ],
    ]);
    const result = await renderSite(await acmeInput({ pageMeta }));
    const html = fileText(result, "guides/payments/index.html");
    const footer = html.slice(html.indexOf('<footer class="page-footer">'), html.indexOf("</footer>", html.indexOf('<footer class="page-footer">')));
    assert.match(footer, /<p class="stale-warning" role="note"><strong>This page may be out of date\.<\/strong>/);
    assert.match(footer, /<dt>Last reviewed<\/dt><dd><time datetime="2025-01-02">2025-01-02<\/time><\/dd>/);
    assert.match(footer, /<dd>@acme\/payments-docs, @acme\/sre<\/dd>/);
    assert.match(footer, /<a href="https:\/\/acme\.atlassian\.net\/browse\/PAY-101" rel="noopener noreferrer">PAY-101<\/a>, PAY-102/);
    // Pages without pageMeta still use their frontmatter.
    assert.match(fileText(result, "guides/refunds/index.html"), /<dt>Tickets<\/dt><dd>PAY-123<\/dd>/);
  });

  test("sidebar ordering: index first, then nav_order, then title", async () => {
    const result = await renderSite(
      siteInput([
        page("zeta.md", "---\ntitle: Zeta\nnav_order: 1\n---\n# Zeta\n"),
        page("alpha.md", "# Alpha\n"),
        page("index.md", "# Home\n"),
        page("guides/index.md", "---\nnav_order: 2\n---\n# All guides\n"),
        page("guides/b.md", "# Bravo\n"),
        page("guides/a.md", "# Able\n"),
        page("tools/cli.md", "# CLI\n"),
      ]),
    );
    const html = fileText(result, "alpha/index.html");
    const nav = html.slice(html.indexOf('<nav class="sidebar"'), html.indexOf("</details>"));
    const labels = [...nav.matchAll(/<(?:a href="([^"]*)"(?: aria-current="page")?|span class="nav-group")>(.*?)<\/(?:a|span)>/g)].map((m) => m[2]);
    assert.deepEqual(labels, ["Home", "Zeta", "All guides", "Able", "Bravo", "Alpha", "Tools", "CLI"]);
    assert.match(nav, /<a href="\.\.\/guides\/">All guides<\/a><ul><li><a href="\.\.\/guides\/a\/">Able<\/a>/);
    assert.match(nav, /<a href="\.\.\/alpha\/" aria-current="page">Alpha<\/a>/);
  });

  test("output path collisions fail loudly", async () => {
    await assert.rejects(
      renderSite(siteInput([page("guides.md", "# Guides\n"), page("guides/index.md", "# Guides index\n")])),
      /Output path collision: "guides\/index\.html"/,
    );
  });

  test("theme.css derives accessible link and focus colors from primaryColor", async () => {
    const luminance = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    };
    const contrast = (a: string, b: string): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const primaryColor of ["#FFD700", "#0B5FFF", "#000080", "#777"]) {
      const result = await renderSite(siteInput([], { site: { title: "T", lang: "en", primaryColor } }));
      const css = fileText(result, "assets/theme.css");
      const [light, dark] = [...css.matchAll(/--docops-link: (#[0-9a-f]{6});/g)].map((m) => m[1] ?? "");
      assert.ok(light && dark, primaryColor);
      assert.ok(contrast(light, "#ffffff") >= 4.5, `${primaryColor}: light link ${light}`);
      assert.ok(contrast(dark, "#0d1117") >= 4.5, `${primaryColor}: dark link ${dark}`);
      assert.match(css, new RegExp(`--docops-focus: ${light};`));
    }
    const gold = fileText(await renderSite(siteInput([], { site: { title: "T", lang: "en", primaryColor: "#FFD700" } })), "assets/theme.css");
    assert.match(gold, /--docops-primary: #ffd700;/);
    // Gold on white fails contrast, so the light-scheme link color is darkened.
    assert.doesNotMatch(gold, /:root \{\n {2}--docops-primary: #ffd700;\n {2}--docops-on-primary: #000000;\n {2}--docops-link: #ffd700;/);
    const invalid = await renderSite(siteInput([], { site: { title: "T", lang: "en", primaryColor: "red; } body { display: none" } }));
    assert.match(fileText(invalid, "assets/theme.css"), /--docops-primary: #0b5fff;/);
    assert.doesNotMatch(fileText(invalid, "assets/theme.css"), /display/);
  });

  test("portal stylesheet covers dark mode, focus, reduced motion and target size", async () => {
    const result = await renderSite(siteInput([]));
    const css = fileText(result, "assets/docops.css");
    assert.match(css, /@media \(prefers-color-scheme: dark\)/);
    assert.match(css, /:focus-visible \{ outline: 3px solid var\(--docops-focus\); outline-offset: 2px; \}/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /font-family: var\(--docops-font\)/);
    assert.match(css, /min-height: 1\.75rem/); // ≥ 24px targets
  });
});
