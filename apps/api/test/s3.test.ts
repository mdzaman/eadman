import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { findRepository, withTenant } from "@docops/db";
import { createApp } from "../src/app.ts";
import { FsBlobStore } from "../src/context.ts";
import { S3BlobStore, S3Error, s3OptionsFromEnv, signRequest, uriEncode, type S3BlobStoreOptions } from "../src/s3.ts";
import { startFakeS3 } from "./fake-s3.ts";
import { createTestEnv } from "./helpers.ts";

const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const TENANT = "0192f0c4-7a5e-7b3c-9d2e-4f6a8b0c2d4e";
const KEYS = { accessKeyId: "AKIDDOCOPSTEST", secretAccessKey: "docops/test/secret+key" };

// The four worked examples of "Signature Calculations for the Authorization Header: Transferring Payload in a Single
// Chunk (AWS Signature Version 4)", https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
// (retrieved 2026-10-19). All use the documented example keys, bucket examplebucket in us-east-1, virtual-hosted URLs,
// and the timestamp 20130524T000000Z. Expected values are copied from the page, not computed.
const AWS_EXAMPLE_CONTEXT = {
  region: "us-east-1",
  service: "s3",
  credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
  now: new Date("2013-05-24T00:00:00Z"),
};
const PUT_PAYLOAD_HASH = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072";
interface AwsExample {
  name: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  payloadHash: string;
  canonicalRequest: string[];
  canonicalRequestHash: string;
  authorization: string;
}
const AWS_EXAMPLES: AwsExample[] = [
  {
    name: "GET Object",
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    headers: { Range: "bytes=0-9 " },
    payloadHash: EMPTY,
    canonicalRequest: ["GET", "/test.txt", "", "host:examplebucket.s3.amazonaws.com", "range:bytes=0-9", `x-amz-content-sha256:${EMPTY}`, "x-amz-date:20130524T000000Z", "", "host;range;x-amz-content-sha256;x-amz-date", EMPTY],
    canonicalRequestHash: "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
    authorization:
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  },
  {
    name: "PUT Object",
    method: "PUT",
    url: "https://examplebucket.s3.amazonaws.com/test$file.text",
    headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
    payloadHash: PUT_PAYLOAD_HASH,
    canonicalRequest: [
      "PUT",
      "/test%24file.text",
      "",
      "date:Fri, 24 May 2013 00:00:00 GMT",
      "host:examplebucket.s3.amazonaws.com",
      `x-amz-content-sha256:${PUT_PAYLOAD_HASH}`,
      "x-amz-date:20130524T000000Z",
      "x-amz-storage-class:REDUCED_REDUNDANCY",
      "",
      "date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class",
      PUT_PAYLOAD_HASH,
    ],
    canonicalRequestHash: "9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d",
    authorization:
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
  },
  {
    name: "GET Bucket Lifecycle",
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/?lifecycle",
    headers: {},
    payloadHash: EMPTY,
    canonicalRequest: ["GET", "/", "lifecycle=", "host:examplebucket.s3.amazonaws.com", `x-amz-content-sha256:${EMPTY}`, "x-amz-date:20130524T000000Z", "", "host;x-amz-content-sha256;x-amz-date", EMPTY],
    canonicalRequestHash: "9766c798316ff2757b517bc739a67f6213b4ab36dd5da2f94eaebf79c77395ca",
    authorization:
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
  },
  {
    name: "Get Bucket (List Objects)",
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J",
    headers: {},
    payloadHash: EMPTY,
    canonicalRequest: ["GET", "/", "max-keys=2&prefix=J", "host:examplebucket.s3.amazonaws.com", `x-amz-content-sha256:${EMPTY}`, "x-amz-date:20130524T000000Z", "", "host;x-amz-content-sha256;x-amz-date", EMPTY],
    canonicalRequestHash: "df57d21db20da04d7fa30298dd4488ba3a2b47ca3a489c74750e0f1e7df1b9b7",
    authorization:
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
  },
];

test("the SigV4 signer reproduces AWS's published S3 examples", () => {
  assert.equal(sha(""), EMPTY);
  assert.equal(sha("Welcome to Amazon S3."), PUT_PAYLOAD_HASH, "the PUT example's payload is the string 'Welcome to Amazon S3.'");
  for (const example of AWS_EXAMPLES) {
    const signed = signRequest({ method: example.method, url: new URL(example.url), headers: example.headers, payloadHash: example.payloadHash }, AWS_EXAMPLE_CONTEXT);
    assert.equal(signed.canonicalRequest, example.canonicalRequest.join("\n"), example.name);
    assert.equal(sha(signed.canonicalRequest), example.canonicalRequestHash, example.name);
    assert.equal(signed.stringToSign, ["AWS4-HMAC-SHA256", "20130524T000000Z", "20130524/us-east-1/s3/aws4_request", example.canonicalRequestHash].join("\n"), example.name);
    assert.equal(signed.headers.authorization, example.authorization, example.name);
    assert.equal(signed.headers["x-amz-date"], "20130524T000000Z");
    assert.equal(signed.headers["x-amz-content-sha256"], example.payloadHash);
    assert.equal(signed.headers.host, undefined, "fetch sends Host from the URL that was signed");
  }
});

test("temporary credentials add a signed x-amz-security-token; UriEncode follows S3's rules", () => {
  const signed = signRequest(
    { method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), payloadHash: EMPTY },
    { ...AWS_EXAMPLE_CONTEXT, credentials: { ...AWS_EXAMPLE_CONTEXT.credentials, sessionToken: "session/token=" } },
  );
  assert.equal(signed.headers["x-amz-security-token"], "session/token=");
  assert.match(signed.headers.authorization ?? "", /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
  assert.match(signed.canonicalRequest, /\nx-amz-security-token:session\/token=\n/);

  assert.equal(uriEncode("AZaz09-._~"), "AZaz09-._~");
  assert.equal(uriEncode("a b+c/d"), "a%20b%2Bc%2Fd");
  assert.equal(uriEncode("!'()*$"), "%21%27%28%29%2A%24");
  assert.equal(uriEncode("é"), "%C3%A9");
});

const bytes = new TextEncoder().encode("<!doctype html><title>Hello</title><h1>Acme</h1>");
const digest = sha(bytes);
const casKey = `cas/${TENANT}/${digest.slice(0, 2)}/${digest}`;

test("put, get, putJson and getJson round-trip through an S3 server (path-style)", async () => {
  const s3 = await startFakeS3({ bucket: "docops-blobs", keys: { [KEYS.accessKeyId]: KEYS.secretAccessKey } });
  try {
    const store = new S3BlobStore({ bucket: "docops-blobs", region: "us-east-1", endpoint: s3.endpoint, forcePathStyle: true, credentials: KEYS });
    assert.equal(store.pathStyle, true);

    await store.put(TENANT, digest, bytes);
    assert.deepEqual(await store.get(TENANT, digest), bytes);
    assert.deepEqual([s3.requests[0]?.method, s3.requests[0]?.path, s3.requests[0]?.status], ["PUT", `/docops-blobs/${casKey}`, 200]);
    assert.equal(s3.requests[0]?.headers["x-amz-content-sha256"], digest, "the blob digest is the signed payload hash");
    assert.deepEqual([...(s3.objects.get(casKey)?.body ?? [])], [...bytes]);
    assert.equal(await store.get(TENANT, sha("never uploaded")), null);

    const snapshot = { commitSha: "a".repeat(40), pages: [{ path: "guides/payments.md", title: "Paiements à l'étranger" }] };
    await store.putJson(`snapshots/${TENANT}/repo/${"a".repeat(40)}`, snapshot);
    assert.ok(s3.objects.has(`json/snapshots/${TENANT}/repo/${"a".repeat(40)}.json`));
    assert.deepEqual(await store.getJson(`snapshots/${TENANT}/repo/${"a".repeat(40)}`), snapshot);
    assert.equal(await store.getJson(`snapshots/${TENANT}/repo/${"b".repeat(40)}`), null);
    assert.ok(s3.requests.every((r) => r.status === 200 || r.status === 404));

    // Refused before anything is sent: content that does not match its digest, a malformed digest, and a key with a
    // dot segment (a URL would collapse it and address another tenant's object).
    const sent = s3.requests.length;
    await assert.rejects(store.put(TENANT, sha("something else"), bytes), { status: 400 });
    await assert.rejects(store.put(TENANT, "not-a-digest", bytes), { status: 400 });
    await assert.rejects(store.putJson(`snapshots/${TENANT}/repo/../../other-tenant/repo/x`, {}), { status: 400 });
    await assert.rejects(store.getJson("snapshots/./x"), { status: 400 });
    assert.equal(s3.requests.length, sent);
  } finally {
    await s3.close();
  }
});

/** A fetch that connects to 127.0.0.1:<port> whatever host the URL names, and sends that host in the Host header. */
function loopbackFetch(port: number): typeof fetch {
  return (input, init = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = { ...(init.headers as Record<string, string>), host: url.host };
      const req = request({ host: "127.0.0.1", port, method: init.method ?? "GET", path: `${url.pathname}${url.search}`, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500 })));
      });
      req.on("error", reject);
      req.end(init.body as Uint8Array | undefined);
    });
}

test("virtual-hosted URLs, a region other than us-east-1, and a session token", async () => {
  const s3 = await startFakeS3({ bucket: "docops-blobs", region: "eu-west-1", keys: { [KEYS.accessKeyId]: KEYS.secretAccessKey }, sessionToken: "FwoGZXIvYXdzEXAMPLE", virtualHost: "s3.docops.test" });
  try {
    const options: S3BlobStoreOptions = {
      bucket: "docops-blobs",
      region: "eu-west-1",
      endpoint: `http://s3.docops.test:${s3.port}`,
      credentials: { ...KEYS, sessionToken: "FwoGZXIvYXdzEXAMPLE" },
      fetch: loopbackFetch(s3.port),
    };
    const store = new S3BlobStore(options);
    assert.equal(store.pathStyle, false);
    await store.put(TENANT, digest, bytes);
    assert.deepEqual(await store.get(TENANT, digest), bytes);
    const [put] = s3.requests;
    assert.deepEqual([put?.host, put?.path, put?.status], [`docops-blobs.s3.docops.test:${s3.port}`, `/${casKey}`, 200]);
    assert.match(String(put?.headers.authorization), /\/eu-west-1\/s3\/aws4_request,SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);

    const withoutToken = new S3BlobStore({ ...options, credentials: KEYS });
    await assert.rejects(withoutToken.get(TENANT, digest), (error: unknown) => error instanceof S3Error && error.status === 403 && error.code === "AccessDenied");
  } finally {
    await s3.close();
  }
});

test("retries throttling and 5xx answers, but not a refused signature; a missing bucket is an error, not an empty store", async () => {
  const s3 = await startFakeS3({ bucket: "docops-blobs", keys: { [KEYS.accessKeyId]: KEYS.secretAccessKey } });
  const store = (overrides: Partial<S3BlobStoreOptions> = {}) =>
    new S3BlobStore({ bucket: "docops-blobs", region: "us-east-1", endpoint: s3.endpoint, forcePathStyle: true, credentials: KEYS, retryDelayMs: 1, ...overrides });
  try {
    s3.failNext(2);
    await store().put(TENANT, digest, bytes);
    assert.deepEqual(s3.requests.map((r) => r.status), [503, 503, 200], "the third try succeeds");

    s3.failNext(3, 500);
    await assert.rejects(store().get(TENANT, digest), (error: unknown) => error instanceof S3Error && error.status === 500 && error.code === "InternalError");
    assert.equal(s3.requests.length, 6, "three tries, then the error");

    await assert.rejects(store({ credentials: { ...KEYS, secretAccessKey: "wrong" } }).get(TENANT, digest), (error: unknown) => {
      assert.ok(error instanceof S3Error);
      assert.deepEqual([error.status, error.code], [403, "SignatureDoesNotMatch"]);
      assert.doesNotMatch(error.message, /wrong|docops\/test\/secret/, "no secret in the message");
      return true;
    });
    assert.equal(s3.requests.length, 7, "a refused signature is not retried");

    await assert.rejects(store({ bucket: "missing-bucket" }).get(TENANT, digest), (error: unknown) => error instanceof S3Error && error.status === 404 && error.code === "NoSuchBucket");
  } finally {
    await s3.close();
  }
  await assert.rejects(store({ maxAttempts: 2 }).get(TENANT, digest), (error: unknown) => error instanceof S3Error && error.status === 0 && /fetch failed/.test(error.message));
});

test("configuration from the environment", () => {
  const env = { DOCOPS_S3_BUCKET: "docops-blobs", AWS_ACCESS_KEY_ID: "AKIDDOCOPSTEST", AWS_SECRET_ACCESS_KEY: "secret" };
  assert.throws(() => s3OptionsFromEnv({ DOCOPS_S3_BUCKET: "docops-blobs" }), /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required/);

  const aws = new S3BlobStore(s3OptionsFromEnv(env));
  assert.deepEqual([aws.region, aws.endpoint.href, aws.pathStyle], ["us-east-1", "https://s3.us-east-1.amazonaws.com/", false]);
  assert.equal(aws.objectUrl(casKey).href, `https://docops-blobs.s3.us-east-1.amazonaws.com/${casKey}`);
  assert.equal(new S3BlobStore(s3OptionsFromEnv({ ...env, DOCOPS_S3_REGION: "eu-central-1" })).endpoint.href, "https://s3.eu-central-1.amazonaws.com/");

  const minio = s3OptionsFromEnv({ ...env, DOCOPS_S3_ENDPOINT: "http://minio.storage.svc:9000", DOCOPS_S3_FORCE_PATH_STYLE: "true", AWS_SESSION_TOKEN: "token" });
  assert.deepEqual(minio.credentials, { accessKeyId: "AKIDDOCOPSTEST", secretAccessKey: "secret", sessionToken: "token" });
  assert.equal(new S3BlobStore(minio).objectUrl("json/a.json").href, "http://minio.storage.svc:9000/docops-blobs/json/a.json");
  assert.equal(s3OptionsFromEnv({ ...env, DOCOPS_S3_FORCE_PATH_STYLE: "false" }).forcePathStyle, false);

  // Virtual-hosted URLs need the bucket as a host name label: a dotted bucket (TLS wildcard) or an IP endpoint use paths.
  assert.equal(new S3BlobStore(s3OptionsFromEnv({ ...env, DOCOPS_S3_BUCKET: "docs.example.com" })).objectUrl("k").href, "https://s3.us-east-1.amazonaws.com/docs.example.com/k");
  assert.equal(new S3BlobStore(s3OptionsFromEnv({ ...env, DOCOPS_S3_ENDPOINT: "http://10.0.0.5:9000" })).pathStyle, true);
  assert.equal(new S3BlobStore(s3OptionsFromEnv({ ...env, DOCOPS_S3_ENDPOINT: "http://[fd00::5]:9000" })).pathStyle, true);

  assert.throws(() => s3OptionsFromEnv({ ...env, DOCOPS_S3_FORCE_PATH_STYLE: "sometimes" }), /DOCOPS_S3_FORCE_PATH_STYLE must be true or false/);
  assert.throws(() => new S3BlobStore(s3OptionsFromEnv({ ...env, DOCOPS_S3_BUCKET: "Docops_Blobs" })), /invalid S3 bucket name/);
  assert.throws(() => new S3BlobStore(s3OptionsFromEnv({ ...env, DOCOPS_S3_ENDPOINT: "https://gateway.example.com/s3" })), /invalid S3 endpoint/);
  assert.throws(() => new S3BlobStore(s3OptionsFromEnv({ ...env, DOCOPS_S3_ENDPOINT: "https://key:secret@s3.example.com" })), (error: Error) => /invalid S3 endpoint/.test(error.message) && !error.message.includes("secret"));
  assert.throws(() => new S3BlobStore(s3OptionsFromEnv({ ...env, DOCOPS_S3_ENDPOINT: "s3 example com:secret" })), (error: Error) => error.message === "invalid S3 endpoint: not a URL");
});

test("two API replicas share builds and snapshots through the bucket, with no shared disk", async () => {
  const s3 = await startFakeS3({ bucket: "docops-blobs", keys: { [KEYS.accessKeyId]: KEYS.secretAccessKey } });
  try {
    const options: S3BlobStoreOptions = { bucket: "docops-blobs", region: "us-east-1", endpoint: s3.endpoint, forcePathStyle: true, credentials: KEYS };
    const env = await createTestEnv({ blobs: new S3BlobStore(options) }); // replica A
    const replicaB = createApp({ ...env.deps, blobs: new S3BlobStore(options) }); // same database and bucket, nothing else shared

    const html = new TextDecoder().decode(bytes);
    const created = await env.request("/v1/builds", {
      method: "POST",
      token: env.tokens.ci,
      json: { spaceKey: "payments", versionName: "latest", audience: "public", commitSha: "c".repeat(40), kind: "branch", manifest: { files: [{ path: "index.html", digest, size: bytes.byteLength, contentType: "text/html; charset=utf-8" }] } },
    });
    assert.equal(created.status, 201);
    const { build, missingDigests } = (await created.json()) as { build: { id: string }; missingDigests: string[] };
    assert.deepEqual(missingDigests, [digest]);
    assert.equal((await env.request(`/v1/blobs/${digest}`, { method: "PUT", token: env.tokens.ci, body: html, headers: { "content-type": "text/html" } })).status, 201);
    assert.ok(s3.objects.has(`cas/${env.tenantId}/${digest.slice(0, 2)}/${digest}`));
    assert.equal(((await (await env.request(`/v1/builds/${build.id}/finalize`, { method: "POST", token: env.tokens.ci })).json()) as { status: string }).status, "ready");
    assert.equal((await env.request("/v1/deployments", { method: "POST", token: env.tokens.ci, json: { buildId: build.id, environment: "prod" } })).status, 201);

    const page = await replicaB.request("/sites/acme/payments/prod/");
    assert.equal(page.status, 200);
    assert.equal(await page.text(), html);
    assert.equal(page.headers.get("etag"), `"${digest}"`);

    const commitSha = "d".repeat(40);
    const accepted = await env.request("/v1/snapshots", {
      method: "POST",
      token: env.tokens.ci,
      json: { repository: { provider: "github", fullName: "acme/payments" }, commitSha, ref: "refs/heads/feature/s3", spaceKey: "payments", pages: [], entities: [] },
    });
    assert.equal(accepted.status, 202);
    const repo = await withTenant(env.deps.db, env.tenantId, (tx) => findRepository(tx, "github", "acme/payments"));
    const stored = await replicaB.request(`/v1/repositories/${repo?.id}/snapshots/${commitSha}`, { headers: { authorization: `Bearer ${env.tokens.owner}` } });
    assert.equal(stored.status, 200);
    assert.equal(((await stored.json()) as { commitSha: string }).commitSha, commitSha);
  } finally {
    await s3.close();
  }
});

test("a filesystem blob directory copied into the bucket as it is reads back through S3BlobStore", async () => {
  const dir = mkdtempSync(join(tmpdir(), "docops-blobs-"));
  const fs = new FsBlobStore(dir);
  await fs.put(TENANT, digest, bytes);
  await fs.putJson(`snapshots/${TENANT}/repo/${"e".repeat(40)}`, { migrated: true });

  const s3 = await startFakeS3({ bucket: "docops-blobs", keys: { [KEYS.accessKeyId]: KEYS.secretAccessKey } });
  try {
    // What `aws s3 sync <DOCOPS_BLOB_DIR> s3://docops-blobs` does: one object per file, keyed by its relative path.
    for (const file of readdirSync(dir, { recursive: true }).map(String)) {
      if (statSync(join(dir, file)).isFile()) s3.objects.set(file.split(sep).join("/"), { body: readFileSync(join(dir, file)), contentType: "binary/octet-stream" });
    }
    const store = new S3BlobStore({ bucket: "docops-blobs", region: "us-east-1", endpoint: s3.endpoint, forcePathStyle: true, credentials: KEYS });
    assert.deepEqual(await store.get(TENANT, digest), bytes);
    assert.deepEqual(await store.getJson(`snapshots/${TENANT}/repo/${"e".repeat(40)}`), { migrated: true });
  } finally {
    await s3.close();
  }
});
