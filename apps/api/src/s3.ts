import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { badRequest, sha256Hex } from "@docops/core";
import type { BlobStore } from "./context.ts";

// ---------------------------------------------------------------------------- AWS Signature Version 4

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary (STS) credentials carry a session token; it is sent and signed as x-amz-security-token. */
  sessionToken?: string | undefined;
}

export interface SignableRequest {
  method: string;
  url: URL;
  /** Extra headers to send and sign. host, x-amz-date, x-amz-content-sha256 and x-amz-security-token are added. */
  headers?: Record<string, string> | undefined;
  /** Lowercase hex SHA-256 of the body (for a blob, its digest), or "UNSIGNED-PAYLOAD". */
  payloadHash: string;
}

export interface SigningContext {
  region: string;
  service: string;
  credentials: AwsCredentials;
  now: Date;
}

export interface SignedRequest {
  /** The headers to send, Authorization included. Host is left to fetch, which derives it from the URL that was signed. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/** SHA-256 of an empty body: the payload hash of a GET. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** S3's UriEncode: every byte except A-Z a-z 0-9 - . _ ~ becomes %XX, so also the ! ' ( ) * that encodeURIComponent keeps. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** S3 does not normalize paths: each segment is encoded exactly once, slashes stay. */
function canonicalUri(url: URL): string {
  return url.pathname.split("/").map((segment) => uriEncode(decode(segment))).join("/");
}

/** Names and values encoded separately, then sorted by name (and value). A bare `?acl` becomes `acl=`. */
function canonicalQuery(url: URL): string {
  return url.search
    .slice(1)
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return [uriEncode(decode(eq === -1 ? pair : pair.slice(0, eq))), eq === -1 ? "" : uriEncode(decode(pair.slice(eq + 1)))] as const;
    })
    .sort(([an, av], [bn, bv]) => (an < bn ? -1 : an > bn ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();

/**
 * Sign a request with AWS Signature Version 4 (single-chunk payload, Authorization header), as described in
 * https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html. Every header sent is signed.
 */
export function signRequest(request: SignableRequest, context: SigningContext): SignedRequest {
  const amzDate = context.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(request.headers ?? {})) headers.set(name.toLowerCase(), value.trim().replace(/ {2,}/g, " "));
  headers.set("host", request.url.host);
  headers.set("x-amz-content-sha256", request.payloadHash);
  headers.set("x-amz-date", amzDate);
  if (context.credentials.sessionToken) headers.set("x-amz-security-token", context.credentials.sessionToken);

  const names = [...headers.keys()].sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method,
    canonicalUri(request.url),
    canonicalQuery(request.url),
    names.map((name) => `${name}:${headers.get(name)}\n`).join(""),
    signedHeaders,
    request.payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${context.region}/${context.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${context.credentials.secretAccessKey}`, dateStamp), context.region), context.service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  headers.delete("host");
  return {
    headers: {
      ...Object.fromEntries(headers),
      authorization: `AWS4-HMAC-SHA256 Credential=${context.credentials.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}

// ---------------------------------------------------------------------------- S3-compatible blob store

export interface S3BlobStoreOptions {
  bucket: string;
  region: string;
  /** The service URL without the bucket, for example http://minio:9000. Default: https://s3.<region>.amazonaws.com. */
  endpoint?: string | undefined;
  /** https://endpoint/bucket/key instead of https://bucket.endpoint/key. Most self-hosted services need it. */
  forcePathStyle?: boolean | undefined;
  credentials: AwsCredentials;
  fetch?: typeof fetch | undefined;
  /** Tries per operation when the network fails, a try times out, or S3 answers 429, 500, 502, 503 or 504. Default 3. */
  maxAttempts?: number | undefined;
  /** Timeout of one try, in milliseconds. Default 60000. */
  timeoutMs?: number | undefined;
  /** Delay before the first retry, in milliseconds; it doubles on each retry, with jitter. Default 100. */
  retryDelayMs?: number | undefined;
}

export class S3Error extends Error {
  /** HTTP status from S3, or 0 when no answer arrived. */
  readonly status: number;
  /** S3 error code, for example AccessDenied or NoSuchBucket. */
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "S3Error";
    this.status = status;
    this.code = code;
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Object keys mirror FsBlobStore's layout under its root (cas/<tenant>/<digest[0:2]>/<digest>, json/<key>.json), so
 * copying DOCOPS_BLOB_DIR into the bucket as it is (for example with `aws s3 sync`) moves existing blobs over.
 */
function casKey(tenantId: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest) || !/^[0-9a-f-]{36}$/.test(tenantId)) throw badRequest("invalid digest");
  return `cas/${tenantId}/${digest.slice(0, 2)}/${digest}`;
}

function jsonKey(key: string): string {
  const name = key.replace(/[^\w/.-]/g, "_");
  // URL parsers collapse "." and ".." segments, so such a key would address a different object.
  if (name.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) throw badRequest("invalid key");
  return `json/${name}.json`;
}

/**
 * Content-addressed blobs and JSON documents in an S3-compatible bucket (AWS S3, MinIO, Ceph RGW, ...), signed with
 * SigV4 over fetch. Every API replica can use the same bucket, so no shared volume is needed.
 */
export class S3BlobStore implements BlobStore {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint: URL;
  /** Path-style when forced, and also when the bucket cannot be a host name label (dots break TLS) or the endpoint is an IP. */
  readonly pathStyle: boolean;
  private readonly credentials: AwsCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(options: S3BlobStoreOptions) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) || options.bucket.includes("..")) {
      throw new Error(`invalid S3 bucket name "${options.bucket}": use 3 to 63 lowercase letters, digits, dots and hyphens`);
    }
    if (!/^[a-z0-9-]+$/.test(options.region)) throw new Error(`invalid S3 region "${options.region}"`);
    if (!options.credentials.accessKeyId || !options.credentials.secretAccessKey) throw new Error("S3 credentials need an access key ID and a secret access key");
    const domain = options.region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
    // URL.parse returns null instead of throwing an error that would carry the raw text, credentials included.
    const endpoint = URL.parse(options.endpoint ?? `https://s3.${options.region}.${domain}`);
    if (!endpoint) throw new Error("invalid S3 endpoint: not a URL");
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
      // origin + pathname leaves out any credentials written into the URL.
      throw new Error(`invalid S3 endpoint ${endpoint.origin}${endpoint.pathname}: use http(s)://host[:port], with no credentials, path or query`);
    }
    this.bucket = options.bucket;
    this.region = options.region;
    this.endpoint = endpoint;
    this.pathStyle = Boolean(options.forcePathStyle) || options.bucket.includes(".") || isIP(endpoint.hostname.replace(/^\[|\]$/g, "")) !== 0;
    this.credentials = options.credentials;
    this.fetchImpl = options.fetch ?? fetch;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.retryDelayMs = options.retryDelayMs ?? 100;
  }

  objectUrl(key: string): URL {
    const path = key.split("/").map(uriEncode).join("/");
    return this.pathStyle ? new URL(`/${this.bucket}/${path}`, this.endpoint) : new URL(`${this.endpoint.protocol}//${this.bucket}.${this.endpoint.host}/${path}`);
  }

  async put(tenantId: string, digest: string, bytes: Uint8Array): Promise<void> {
    const key = casKey(tenantId, digest);
    if (sha256Hex(bytes) !== digest) throw badRequest("content does not match its sha256 digest");
    // The digest is the payload hash S3 checks the body against, so a corrupted upload is refused there too.
    await this.send("PUT", key, { bytes, sha256: digest, contentType: "application/octet-stream" });
  }

  async get(tenantId: string, digest: string): Promise<Uint8Array | null> {
    const response = await this.send("GET", casKey(tenantId, digest));
    return response ? new Uint8Array(await response.arrayBuffer()) : null;
  }

  async putJson(key: string, value: unknown): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(value));
    await this.send("PUT", jsonKey(key), { bytes, sha256: sha256Hex(bytes), contentType: "application/json" });
  }

  async getJson<T>(key: string): Promise<T | null> {
    const response = await this.send("GET", jsonKey(key));
    return response ? (JSON.parse(await response.text()) as T) : null;
  }

  /** The response of a successful request, or null for a GET of a missing key. Anything else throws an S3Error. */
  private async send(method: "GET" | "PUT", key: string, body?: { bytes: Uint8Array; sha256: string; contentType: string }): Promise<Response | null> {
    const url = this.objectUrl(key);
    for (let attempt = 1; ; attempt++) {
      const signed = signRequest(
        { method, url, headers: body ? { "content-type": body.contentType } : {}, payloadHash: body?.sha256 ?? EMPTY_SHA256 },
        { region: this.region, service: "s3", credentials: this.credentials, now: new Date() },
      );
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method, headers: signed.headers, body: body?.bytes, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (error) {
        if (attempt < this.maxAttempts) {
          await this.backoff(attempt);
          continue;
        }
        const cause = (error as { cause?: { message?: string } }).cause?.message;
        throw new S3Error(`S3 ${method} ${key} failed: ${(error as Error).message}${cause ? ` (${cause})` : ""}`, 0);
      }
      if (response.ok) return response;
      const text = await response.text().catch(() => "");
      const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
      // A missing key is not an error; a missing bucket is a misconfiguration and must not look like an empty store.
      if (method === "GET" && response.status === 404 && code !== "NoSuchBucket") return null;
      if (RETRYABLE.has(response.status) && attempt < this.maxAttempts) {
        await this.backoff(attempt);
        continue;
      }
      const message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1];
      throw new S3Error(`S3 ${method} ${key} failed: ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`, response.status, code);
    }
  }

  private backoff(attempt: number): Promise<void> {
    const ms = this.retryDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() / 2);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function flag(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "" || /^(false|0|no)$/i.test(value)) return false;
  if (/^(true|1|yes)$/i.test(value)) return true;
  throw new Error(`${name} must be true or false, got "${value}"`);
}

/** S3 settings for the API, read when DOCOPS_S3_BUCKET is set. Throws on an incomplete configuration, so the process stops at start. */
export function s3OptionsFromEnv(env: NodeJS.ProcessEnv): S3BlobStoreOptions {
  const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!accessKeyId || !secretAccessKey) throw new Error("DOCOPS_S3_BUCKET is set, so AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required");
  return {
    bucket: env.DOCOPS_S3_BUCKET ?? "",
    region: env.DOCOPS_S3_REGION || "us-east-1",
    endpoint: env.DOCOPS_S3_ENDPOINT || undefined,
    forcePathStyle: flag("DOCOPS_S3_FORCE_PATH_STYLE", env.DOCOPS_S3_FORCE_PATH_STYLE),
    credentials: { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN || undefined },
  };
}
