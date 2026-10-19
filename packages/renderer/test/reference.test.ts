import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { renderSite, type BuildResult } from "../src/index.ts";
import { acmeInput, articleOf, fileText, hasFile, page, siteInput } from "./helpers.ts";

const SHAPES = `openapi: 3.0.3
info:
  title: Shapes API
  version: "1.0"
servers:
  - url: https://{region}.shapes.example/v2
    variables:
      region:
        default: eu
security:
  - apiKey: []
components:
  securitySchemes:
    apiKey:
      type: apiKey
      in: header
      name: X-API-Key
    basic:
      type: http
      scheme: basic
  schemas:
    Base:
      type: object
      required: [id]
      properties:
        id:
          type: string
          readOnly: true
        meta:
          $ref: "#/components/schemas/Meta"
    Meta:
      type: object
      properties:
        labels:
          type: object
          properties:
            color:
              type: string
              enum: [red, blue]
            deep:
              type: object
              properties:
                deeper:
                  type: string
    Circle:
      allOf:
        - $ref: "#/components/schemas/Base"
        - type: object
          required: [radius]
          properties:
            radius:
              type: number
              minimum: 0
              description: Radius in **cm**.
    Square:
      allOf:
        - $ref: "#/components/schemas/Base"
        - type: object
          properties:
            side:
              type: number
    Node:
      type: object
      properties:
        name:
          type: string
        children:
          type: array
          items:
            $ref: "#/components/schemas/Node"
paths:
  /shapes:
    post:
      operationId: create shape
      summary: Create a shape
      deprecated: true
      parameters:
        - name: dry_run
          in: query
          required: true
          schema:
            type: boolean
        - name: X-Request-Id
          in: header
          required: true
          schema:
            type: string
            format: uuid
        - name: secret
          in: query
          x-internal: true
          schema:
            type: string
      requestBody:
        content:
          application/json:
            schema:
              oneOf:
                - $ref: "#/components/schemas/Circle"
                - $ref: "#/components/schemas/Square"
      responses:
        "201":
          description: Created.
          headers:
            Location:
              description: URL of the shape.
              schema:
                type: string
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Circle"
        default:
          description: Error.
  /tree:
    get:
      summary: Get the tree
      security: []
      responses:
        "200":
          description: The tree.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Node"
  /hidden:
    x-internal: true
    get:
      operationId: hiddenOp
      responses:
        "200":
          description: OK
  /remote:
    get:
      operationId: remoteRef
      responses:
        "200":
          description: Remote schema.
          content:
            application/json:
              schema:
                $ref: "https://evil.example/schema.json"
`;

function shapesInput(includeInternal = false) {
  return siteInput([page("index.mdx", "# Home\n\n<ApiOperation op=\"GET /tree\" />\n")], {
    openapi: [{ sourceId: "shapes", title: "Shapes API reference", outDir: "/api/shapes/", content: SHAPES, includeInternal }],
  });
}

describe("OpenAPI reference rendering", () => {
  let result: BuildResult;
  let create: string;
  before(async () => {
    result = await renderSite(shapesInput());
    create = articleOf(fileText(result, "api/shapes/operations/create-shape/index.html"));
  });

  test("unsafe operationIds become slugs; operations without one use METHOD + path", () => {
    assert.match(create, /^<article id="op-create-shape" class="doc api-reference api-page-operation">/);
    assert.ok(hasFile(result, "api/shapes/operations/get-tree/index.html"));
    assert.ok(hasFile(result, "api/shapes/operations/remoteRef/index.html"));
    assert.match(fileText(result, "index.html"), /href="\.\/api\/shapes\/operations\/get-tree\/"><span class="method method-get">GET<\/span>/);
  });

  test("path-level and parameter-level x-internal are hidden unless includeInternal", async () => {
    assert.equal(result.files.some((f) => f.path.includes("hiddenOp")), false);
    assert.doesNotMatch(create, /secret/);
    const internal = await renderSite(shapesInput(true));
    assert.ok(hasFile(internal, "api/shapes/operations/hiddenOp/index.html"));
    assert.match(fileText(internal, "api/shapes/operations/create-shape/index.html"), /<code>secret<\/code>/);
  });

  test("deprecated notice and parameter tables per location", () => {
    assert.match(create, /<aside class="callout callout-caution" role="note"><p class="callout-title">Deprecated<\/p>/);
    assert.match(create, /<caption id="table-1">Query parameters<\/caption>[\s\S]*?<code>dry_run<\/code><\/th><td>boolean<\/td><td>required<\/td>/);
    assert.match(create, /<caption id="table-2">Header parameters<\/caption>[\s\S]*?<code>X-Request-Id<\/code><\/th><td>string<\/td><td>required<\/td>[\s\S]*?Format: <code>uuid<\/code>/);
  });

  test("oneOf variants with allOf-merged, nested (depth ≤ 3) request properties", () => {
    assert.match(create, /<p>Exactly one of these schemas:<\/p>\s*<ul><li><code>Circle<\/code><\/li><li><code>Square<\/code><\/li><\/ul>/);
    const option1 = /<caption id="table-3">Request body \(application\/json\), option 1: Circle<\/caption>[\s\S]*?<\/table>/.exec(create)?.[0] ?? "";
    assert.ok(option1, "Circle table");
    assert.match(option1, /<code>radius<\/code><\/th><td>number<\/td><td>required<\/td><td>Radius in <strong>cm<\/strong>\.<\/td><td><ul class="constraints"><li>Minimum: 0<\/li><\/ul>/);
    assert.match(option1, /<tr class="depth-3"><th scope="row"><code>meta\.labels\.color<\/code><\/th>/);
    assert.match(option1, /Allowed: <code>red<\/code>, <code>blue<\/code>/);
    assert.doesNotMatch(option1, /deeper/); // depth 4
    assert.doesNotMatch(option1, /<code>id<\/code>/); // read-only properties are not sent
    assert.match(create, /option 2: Square<\/caption>[\s\S]*?<code>side<\/code>/);
  });

  test("responses: headers, schemas, read-only properties and default", () => {
    assert.match(create, /<h3 id="response-201">201 Created<\/h3>/);
    assert.match(create, /<caption id="table-\d+">201 Created: response headers<\/caption>[\s\S]*?<code>Location<\/code>/);
    assert.match(create, /201 Created response body \(application\/json\)<\/caption>[\s\S]*?<code>id<\/code><\/th><td>string<\/td><td>required<\/td><td><\/td><td><ul class="constraints"><li>Read-only<\/li>/);
    assert.match(create, /<h3 id="response-default">Default response<\/h3>\s*<p>Error\.<\/p>/);
  });

  test("security: API key header, explicit opt-out", () => {
    assert.match(create, /Requires <code>apiKey<\/code> — API key in header "X-API-Key"\./);
    const tree = articleOf(fileText(result, "api/shapes/operations/get-tree/index.html"));
    assert.match(tree, /<p>This operation does not require authentication\.<\/p>/);
    // Recursive schemas stop at the cycle.
    assert.match(tree, /<code>children<\/code><\/th><td>array of Node<\/td>/);
    assert.doesNotMatch(tree, /children\[\]\.children/);
  });

  test("code samples use server variable defaults, placeholders and a synthesized body", () => {
    assert.match(
      create,
      /curl -X POST 'https:\/\/eu\.shapes\.example\/v2\/shapes\?dry_run=\{dry_run\}' \\\n {2}-H "X-API-Key: \$API_KEY" \\\n {2}-H 'X-Request-Id: \{X-Request-Id\}' \\\n {2}-H 'Content-Type: application\/json' \\\n {2}-d '\{\n {2}"radius": 0\n\}'/,
    );
    assert.match(create, /"X-API-Key": "YOUR_API_KEY",/);
    assert.match(create, /<textarea id="try-it-body" name="body" rows="10" spellcheck="false" data-content-type="application\/json">\{\n {2}"radius": 0\n\}<\/textarea>/);
    // Enumerable parameters become selects in the console.
    assert.match(create, /<select id="try-it-query-dry-run" data-param-in="query" data-param-name="dry_run" required/);
  });

  test("unresolvable remote $refs do not fail the build", () => {
    const remote = articleOf(fileText(result, "api/shapes/operations/remoteRef/index.html"));
    assert.match(remote, /<h3 id="response-200">200 OK<\/h3>\s*<p>Remote schema\.<\/p>\s*<p>Content type: <code>application\/json<\/code><\/p>/);
  });

  test("untagged APIs list operations on the index; schemes are summarized", () => {
    const index = articleOf(fileText(result, "api/shapes/index.html"));
    assert.match(index, /<h2 id="other-operations">Operations<\/h2>/);
    assert.match(index, /<code>https:\/\/eu\.shapes\.example\/v2<\/code>/);
    assert.match(index, /<th scope="row"><code>basic<\/code><\/th><td>http<\/td><td>HTTP basic<\/td>/);
    assert.equal(result.files.some((f) => f.path.startsWith("api/shapes/tags/")), false);
    // ApiOperation resolves METHOD + path.
    assert.match(fileText(result, "index.html"), /<a class="api-operation-link" href="\.\/api\/shapes\/operations\/get-tree\/">/);
  });

  test("acme: includeInternal publishes the internal operation", async () => {
    const input = await acmeInput();
    const internal = await renderSite({ ...input, openapi: input.openapi.map((o) => ({ ...o, includeInternal: true })) });
    assert.ok(hasFile(internal, "reference/payments-api/operations/reconcilePayment/index.html"));
    assert.equal(internal.stats.referencePages, 1 + 2 + 6);
  });

  test("specs without servers use a {baseUrl} placeholder", async () => {
    const spec = "openapi: 3.1.0\ninfo:\n  title: Bare\n  version: '1'\npaths:\n  /ping:\n    get:\n      operationId: ping\n      responses:\n        '204':\n          description: Pong.\n";
    const bare = await renderSite(siteInput([], { openapi: [{ sourceId: "bare", title: "Bare", outDir: "bare", content: spec }] }));
    const html = fileText(bare, "bare/operations/ping/index.html");
    assert.match(html, /curl '\{baseUrl\}\/ping'/);
    assert.match(html, /<h3 id="response-204">204 No Content<\/h3>/);
    assert.match(html, /No security requirements are declared for this operation\./);
  });

  test("invalid documents and escaping outDirs are reported clearly", async () => {
    await assert.rejects(
      renderSite(siteInput([], { openapi: [{ sourceId: "broken", title: "B", outDir: "b", content: "title: not openapi\n" }] })),
      /OpenAPI source "broken": not an OpenAPI document/,
    );
    await assert.rejects(
      renderSite(siteInput([], { openapi: [{ sourceId: "escape", title: "E", outDir: "../outside", content: SHAPES }] })),
      /outDir "\.\.\/outside" must stay inside the site/,
    );
  });
});
