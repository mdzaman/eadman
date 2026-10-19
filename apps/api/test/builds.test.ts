import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { withTenant } from "@docops/db";
import { createTestEnv } from "./helpers.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const files = {
  "index.html": "<!doctype html><html lang=en><title>Home</title><h1>Acme</h1></html>",
  "guides/payments/index.html": "<!doctype html><html lang=en><title>Payments</title></html>",
  "assets/docops.css": "body{font-family:system-ui}",
};
const manifest = Object.entries(files).map(([path, content]) => ({
  path,
  digest: sha(content),
  size: Buffer.byteLength(content),
  contentType: path.endsWith(".css") ? "text/css" : "text/html; charset=utf-8",
}));

async function upload(env: Awaited<ReturnType<typeof createTestEnv>>, kind: "branch" | "preview", extra: Record<string, unknown> = {}) {
  const created = await env.request("/v1/builds", { method: "POST", token: env.tokens.ci, json: { spaceKey: "payments", versionName: "latest", audience: "public", commitSha: "a".repeat(40), kind, manifest: { files: manifest }, stats: { pageCount: 2, cachedPages: 0 }, ...extra } });
  assert.equal(created.status, 201);
  const { build, missingDigests } = (await created.json()) as { build: { id: string }; missingDigests: string[] };
  for (const digest of missingDigests) {
    const [path, content] = Object.entries(files).find(([, c]) => sha(c) === digest)!;
    const put = await env.request(`/v1/blobs/${digest}`, { method: "PUT", token: env.tokens.ci, body: content, headers: { "content-type": path.endsWith(".css") ? "text/css" : "text/html" } });
    assert.equal(put.status, 201);
  }
  return { buildId: build.id, missingDigests };
}

test("content-addressed publish: only missing blobs upload, digests are verified", async () => {
  const env = await createTestEnv();
  const first = await upload(env, "branch");
  assert.equal(first.missingDigests.length, 3);
  const second = await upload(env, "branch");
  assert.equal(second.missingDigests.length, 0, "unchanged files are never re-uploaded");

  const lying = await env.request(`/v1/blobs/${sha("something else")}`, { method: "PUT", token: env.tokens.ci, body: "tampered", headers: { "content-type": "text/plain" } });
  assert.equal(lying.status, 400, "the server verifies sha256(content) == digest");

  const traversal = await env.request("/v1/builds", { method: "POST", token: env.tokens.ci, json: { spaceKey: "payments", commitSha: "a".repeat(40), kind: "branch", manifest: { files: [{ ...manifest[0], path: "../etc/passwd" }] } } });
  assert.equal(traversal.status, 400);
});

test("finalize signs the manifest; promotion verifies the signature; the site is served with security headers", async () => {
  const env = await createTestEnv();
  const { buildId } = await upload(env, "branch");
  const finalized = (await (await env.request(`/v1/builds/${buildId}/finalize`, { method: "POST", token: env.tokens.ci })).json()) as { status: string; signature: string };
  assert.equal(finalized.status, "ready");
  assert.match(finalized.signature, /^ed25519:[0-9a-f]{16}:/);

  const promoted = await env.request("/v1/deployments", { method: "POST", token: env.tokens.ci, json: { buildId, environment: "prod" } });
  assert.equal(promoted.status, 201);
  const deployment = (await promoted.json()) as { url: string; status: string };
  assert.equal(deployment.status, "active");
  assert.equal(deployment.url, "http://docops.test/sites/acme/payments/prod/");

  const page = await env.request("/sites/acme/payments/prod/guides/payments/");
  assert.equal(page.status, 200);
  assert.equal(await page.text(), files["guides/payments/index.html"]);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(page.headers.get("etag"), `"${sha(files["guides/payments/index.html"])}"`);
  const cached = await env.request("/sites/acme/payments/prod/guides/payments/", { headers: { "if-none-match": page.headers.get("etag")! } });
  assert.equal(cached.status, 304);
  assert.equal((await env.request("/sites/acme/payments/prod/missing/")).status, 404);

  // Tampering with the stored signature (or manifest) makes promotion fail closed.
  await withTenant(env.deps.db, env.tenantId, (tx) => tx.query("UPDATE builds SET manifest_digest = $2 WHERE id = $1", [buildId, "0".repeat(64)]));
  const refused = await env.request("/v1/deployments", { method: "POST", token: env.tokens.ci, json: { buildId, environment: "staging" } });
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as { code: string }).code, "signature_invalid");
});

test("previews require a signed, expiring preview token", async () => {
  const env = await createTestEnv();
  const { buildId } = await upload(env, "preview", { pullRequestNumber: 7 });
  const finalized = (await (await env.request(`/v1/builds/${buildId}/finalize`, { method: "POST", token: env.tokens.ci })).json()) as { previewUrl: string };
  assert.match(finalized.previewUrl, /^http:\/\/docops\.test\/sites\/acme\/payments\/preview-pr-7\/\?pt=/);
  const path = finalized.previewUrl.replace("http://docops.test", "");
  const ok = await env.request(path);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal((await env.request("/sites/acme/payments/preview-pr-7/")).status, 403);
  assert.equal((await env.request("/sites/acme/payments/preview-pr-7/?pt=9999999999.forged")).status, 403);
});

test("authorization: scopes and roles gate promotion; oversized blobs are rejected", async () => {
  const env = await createTestEnv({ maxBlobBytes: 100 });
  const { buildId } = await upload(env, "branch");
  await env.request(`/v1/builds/${buildId}/finalize`, { method: "POST", token: env.tokens.ci });
  const viewer = await env.request("/v1/deployments", { method: "POST", token: env.tokens.viewer, json: { buildId, environment: "prod" } });
  assert.equal(viewer.status, 403, "viewer role cannot promote even with an admin-scoped token");
  const readonly = await env.request("/v1/deployments", { method: "POST", token: env.tokens.readonly, json: { buildId, environment: "prod" } });
  assert.equal(readonly.status, 403, "org_owner with a docs:read token cannot promote");
  const big = "x".repeat(200);
  const tooLarge = await env.request(`/v1/blobs/${sha(big)}`, { method: "PUT", token: env.tokens.ci, body: big, headers: { "content-type": "text/plain" } });
  assert.equal(tooLarge.status, 413);
});
