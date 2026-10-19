import assert from "node:assert/strict";
import { Script } from "node:vm";
import { describe, test } from "node:test";
import { renderSite } from "../src/index.ts";
import { DOCOPS_JS } from "../src/assets.ts";
import { articleOf, fileText, htmlFiles, page, siteInput, startTags } from "./helpers.ts";

const XSS_MD = `# Hostile page

<script>alert(1)</script>

<img src=x onerror=alert(1)>

[x](javascript:alert(1)) and [y](JAVASCRIPT:alert(2)) and [z](JaVaScRiPt:alert(3)) and [w](data:text/html;base64,PHNjcmlwdD4=)

[ref link][evil]

![tracking](javascript:alert(4)) ![inline](data:image/png;base64,AAAA)

Inline <span onmouseover="alert(5)">hover</span> and <a href="javascript:alert(6)">raw link</a>.

<iframe src="https://evil.example"></iframe>

<style>body { display: none }</style>

[evil]: javascript:alert(7)
`;

/** No scripts (other than the portal script), frames, styles, handlers or unsafe URLs in real markup. */
function assertSafeMarkup(html: string, label: string): void {
  const tags = startTags(html);
  const scripts = tags.filter((t) => t.name === "script");
  assert.equal(scripts.length, 1, `${label}: only the portal script`);
  // Relative to the page ("./", "../../"), or absolute in 404.html.
  assert.match(scripts[0]?.attributes.get("src") ?? "", /^(?:\.\/|(?:\.\.\/)+|\/)assets\/docops\.js$/, `${label}: only the portal script`);
  for (const tag of tags) {
    assert.ok(!["iframe", "object", "embed", "style", "base", "frame"].includes(tag.name), `${label}: <${tag.name}>`);
    for (const [name, value] of tag.attributes) {
      assert.ok(!name.startsWith("on"), `${label}: <${tag.name} ${name}>`);
      assert.notEqual(name, "style", `${label}: <${tag.name} style>`);
      if (name === "href" || name === "src" || name === "action" || name === "formaction") {
        assert.doesNotMatch(value, /^\s*(javascript|data|vbscript):/i, `${label}: <${tag.name} ${name}="${value}">`);
      }
    }
  }
}

function assertNoActiveContent(html: string, label: string): void {
  assertSafeMarkup(html, label);
  const article = articleOf(html);
  assert.doesNotMatch(html, /javascript:/i, `${label}: javascript: URL`);
  assert.doesNotMatch(article, /alert\(/, `${label}: script text`);
}

describe("XSS hardening (T18)", () => {
  test("raw HTML, event handlers and javascript:/data: URLs never reach the output", async () => {
    const result = await renderSite(siteInput([page("hostile.md", XSS_MD)]));
    const html = fileText(result, "hostile/index.html");
    assertNoActiveContent(html, "hostile.md");
    const article = articleOf(html);
    // Link text survives; the dangerous href does not.
    assert.match(article, /<a>x<\/a> and <a>y<\/a>/);
    assert.match(article, /<a>ref link<\/a>/);
    // Images with rejected sources degrade to their alt text.
    assert.match(article, /<p>tracking inline<\/p>/);
    assert.doesNotMatch(article, /<img/);
    // Raw HTML is dropped entirely (not escaped into visible text).
    assert.match(article, /<p>Inline hover and raw link\.<\/p>/);
  });

  test("hostile MDX is never executed or passed through", async () => {
    const flag = "__docopsRendererPwned";
    const source = `import fs from "node:fs"
export const pwn = (globalThis.${flag} = "esm")

# Hostile MDX

{globalThis.${flag} = "expression"}

Inline {globalThis.${flag} = "inline"} expression.

<script>{globalThis.${flag} = "script"}</script>

<div onClick={() => alert(1)} style={{ color: "red" }}>div text</div>

<img src="x" onError="alert(1)" />

<iframe src="https://evil.example" />

<Widget onLoad="alert(1)" href="javascript:alert(2)">widget text</Widget>

<a href="javascript:alert(3)">anchor text</a>
`;
    const result = await renderSite(siteInput([page("hostile.mdx", source)]));
    assert.equal((globalThis as Record<string, unknown>)[flag], undefined, "nothing was evaluated");
    const html = fileText(result, "hostile/index.html");
    assertNoActiveContent(html, "hostile.mdx");
    const article = articleOf(html);
    assert.doesNotMatch(article, /globalThis|node:fs|export const/);
    assert.doesNotMatch(article, /\sstyle=/);
    assert.match(article, /<p>div text<\/p>/);
    // Unknown components keep their children but none of their attributes.
    assert.match(article, /<div data-component="Widget"><p>widget text<\/p><\/div>/);
    assert.match(article, /<p>anchor text<\/p>/);
  });

  test("OpenAPI descriptions are rendered as sanitized Markdown", async () => {
    const spec = `openapi: 3.1.0
info:
  title: Evil <script>alert(1)</script> API
  version: "1"
  description: "Hello <img src=x onerror=alert(1)> [click](javascript:alert(2))"
paths:
  /things:
    get:
      operationId: listThings
      summary: List <b onmouseover=alert(3)>things</b>
      description: "Lists things.\\n\\n<script>alert(4)</script>"
      responses:
        "200":
          description: OK
`;
    const result = await renderSite(siteInput([], { openapi: [{ sourceId: "evil", title: "Evil API", outDir: "reference/evil", content: spec }] }));
    for (const { path, html } of htmlFiles(result)) {
      assertSafeMarkup(html, path);
      assert.ok(!startTags(html).some((t) => t.name === "img" || t.name === "b"), `${path}: no tags from spec text`);
      assert.doesNotMatch(articleOf(html), /javascript:/i, path);
    }
    const index = fileText(result, "reference/evil/index.html");
    // Plain-text fields (titles, summaries) are escaped, not interpreted.
    assert.match(index, /<h1>Evil &#x3C;script>alert\(1\)&#x3C;\/script> API<\/h1>/);
    const op = fileText(result, "reference/evil/operations/listThings/index.html");
    assert.match(op, /<p>Lists things\.<\/p>/);
  });

  test("the client script has no eval, no innerHTML and never stores credentials", () => {
    assert.doesNotThrow(() => new Script(DOCOPS_JS), "docops.js is valid JavaScript");
    assert.doesNotMatch(DOCOPS_JS, /\beval\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.doesNotMatch(DOCOPS_JS, /sessionStorage|indexedDB|document\.cookie/);
    // localStorage is only used for the non-sensitive keyboard-shortcut preference.
    const storageWrites = DOCOPS_JS.match(/localStorage\.setItem\([^)]*\)/g) ?? [];
    assert.deepEqual(storageWrites, ['localStorage.setItem("docops:" + key, value)']);
    assert.match(DOCOPS_JS, /writePreference\("shortcuts"/);
    assert.doesNotMatch(DOCOPS_JS, /writePreference\([^)]*token/i);
    assert.doesNotMatch(DOCOPS_JS, /console\.(log|info|debug)/);
    // Requests from the console never send ambient credentials.
    assert.match(DOCOPS_JS, /credentials: "omit"/);
  });
});
