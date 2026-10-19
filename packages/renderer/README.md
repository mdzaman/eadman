# @docops/renderer

Turns parsed Markdown/MDX pages (`@docops/markdown`) and OpenAPI 3.x documents into the static,
accessible documentation portal. Pure function of its input: no file system or network access,
deterministic output (same input → byte-identical files and manifest).

```ts
import { renderSite } from "@docops/renderer";

const result = await renderSite({
  site: { title: "Acme Payments Docs", lang: "en", primaryColor: "#0B5FFF", editUrl: "https://github.com/acme/payments/edit/main/{path}", baseUrl: "https://docs.acme.example/payments" },
  project: { id: "payments", name: "Acme Payments" },
  docsRoot: "docs",
  pages, snippets,                       // from loadPages()
  variables: config.variables,
  openapi: [{ sourceId: "payments-api", title: "Payments API reference", outDir: "reference/payments-api", content }],
  version: { name: "2.4", available: [{ name: "2.4", url: "/" }] },
  basePath: "/",
  previousManifest,                      // optional, for stats.cachedPages
});
// result.files: BuiltFile[] to write/upload; result.manifest; result.a11y; result.stats
```

Exports: `renderSite`, `pageUrl`, `pageOutputPath`, `resolveDocUrl`, `substituteVariables`,
`CONTENT_SECURITY_POLICY`, `RENDERER_VERSION` and the types `RenderSiteInput`, `BuiltFile`,
`BuildManifest`, `BuildResult`, `A11yIssue`, `PageMeta`, `SearchEntry`, ….

## Output

| Path | Content |
|---|---|
| `index.html`, `guides/payments/index.html`, … | One page per Markdown/MDX page (pretty URLs) |
| `<outDir>/index.html` | API overview: version, description, servers, security schemes, operations by tag |
| `<outDir>/tags/<tag>/index.html` | Operations of one tag |
| `<outDir>/operations/<operationId or slug>/index.html` | One page per operation (`id="op-…"`) |
| `search-index.json` | `[{ url, title, headings, text, version }]` |
| `assets/docops.css`, `assets/theme.css`, `assets/docops.js` | Styles, theme tokens, progressive-enhancement script |
| `404.html`, `robots.txt`, `sitemap.xml` | Sitemap only when `site.baseUrl` is set and the build is not a preview |

Links inside pages are relative to the page (`../../guides/refunds/`), so one signed build works
wherever it is mounted: at `/`, under `/sites/<tenant>/<space>/<env>/` as it is promoted from dev to
prod, in a preview or on a file share. `basePath` is where the site is published; it is used only for
absolute URLs (canonical links, `sitemap.xml`, `manifest.pages[].url`) and in `404.html`, which a CDN
serves at any depth. `search-index.json` URLs are relative to the site root. Configured version URLs
are kept as given.

Images and other files referenced by pages are rewritten to the matching relative path but not copied;
the CLI copies them. Two sources that map to the same output path fail the build.

## Markdown and MDX

- Links to `.md`/`.mdx` become pretty URLs (resolved relative to the linking file; links in
  snippets resolve relative to the snippet). `/docs/x.md` (repo-absolute) is mapped through `docsRoot`.
- `{{ name }}` variables in text, inline code, code blocks and link URLs (not frontmatter); unknown
  names stay as written. In MDX, `{{ name }}` parses as an expression and is substituted too.
- Snippets: `<!-- docops:snippet name="x" -->` and `<Snippet name="x" />`, nested, cycle-safe.
- GFM alerts and `<Callout>` → `<aside class="callout callout-note" role="note">`.
- `<Tabs>/<Tab>`, `<CodeGroup>`: all panels visible with headings without JavaScript; the script
  turns them into a WAI-ARIA tablist. `<ApiOperation op="POST /v1/payments" | operationId="…" source="…">`,
  `<JiraStatus key="PAY-1">`, `<FeatureFlag>` (renders children). Unknown components →
  `<div data-component="Name">`; HTML-like lowercase elements are unwrapped (dangerous ones dropped).

## Security (threats T18/T19)

- MDX is never executed: ESM is dropped, expressions render nothing, attributes are read as literals.
- Raw HTML in Markdown is dropped; bodies are sanitized with an allowlist (`hast-util-sanitize`),
  so `javascript:`/`data:` URLs and event handlers cannot reach the page.
- No inline scripts or `style` attributes anywhere; every page carries
  `CONTENT_SECURITY_POLICY` as a `<meta>`. Serve the same policy as an HTTP header too:
  browsers ignore `frame-ancestors` in a `<meta>` CSP. `PORTAL_SECURITY_HEADERS` in `@docops/core`
  holds the full header set, and the API's site server sends it with every file.
- Try-it console: the bearer token lives only in a password field (`autocomplete="off"`), is never
  written to storage or logged, and requests use `credentials: "omit"` to servers from the spec.

## Incremental builds and accessibility

`manifest.pages[].inputHash = sha256(page.source + used snippet sources + canonical JSON of variables + RENDERER_VERSION)`;
`stats.cachedPages` counts content pages whose hash matches `previousManifest`. Bump
`RENDERER_VERSION` whenever output changes for the same input.

`result.a11y` reports `a11y/img-alt`, `a11y/heading-order`, `a11y/link-text`, `a11y/table-headers`
(content pages, with source lines; issues inside snippets point at the directive) and
`a11y/html-lang` (page `"*"`, when `site.lang` is not a BCP 47 tag).
