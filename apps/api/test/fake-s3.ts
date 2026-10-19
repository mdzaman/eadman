import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * An in-process stand-in for one S3 bucket: PUT and GET object, path-style or virtual-hosted. It checks SigV4 the way S3
 * does, with code written apart from src/s3.ts: the canonical request is rebuilt from what arrived on the socket.
 */
export interface FakeS3Options {
  bucket: string;
  /** Access key ID → secret access key. */
  keys: Record<string, string>;
  region?: string;
  /** When set, requests must carry this token in a signed x-amz-security-token header. */
  sessionToken?: string;
  /** Requests for the host <bucket>.<virtualHost> are virtual-hosted; all others are path-style. */
  virtualHost?: string;
}

export interface FakeS3Request {
  method: string;
  host: string;
  path: string;
  headers: IncomingHttpHeaders;
  status: number;
}

export interface FakeS3 {
  /** http://127.0.0.1:<port> */
  endpoint: string;
  port: number;
  /** The bucket's objects by key. */
  objects: Map<string, { body: Buffer; contentType: string }>;
  requests: FakeS3Request[];
  /** Answer the next `count` requests with `status` (503 SlowDown by default), whatever they are. */
  failNext(count: number, status?: number): void;
  close(): Promise<void>;
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();

/** UriEncode as in the AWS documentation's Java example: byte by byte, unreserved characters kept, %XX in uppercase. */
function awsUriEncode(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** null when the request is authentic, else the [status, S3 error code] S3 would answer with. */
function verify(req: IncomingMessage, body: Buffer, options: FakeS3Options & { region: string }): [number, string] | null {
  const header = (name: string): string => {
    const value = req.headers[name];
    return Array.isArray(value) ? value.join(",") : (value ?? "");
  };
  const auth = /^AWS4-HMAC-SHA256 Credential=([^/,]+)\/(\d{8})\/([^/,]+)\/s3\/aws4_request,SignedHeaders=([a-z0-9;-]+),Signature=([0-9a-f]{64})$/.exec(header("authorization"));
  if (!auth) return [403, "AccessDenied"];
  const [, accessKeyId = "", date = "", region = "", signedHeaders = "", signature = ""] = auth;
  const secret = options.keys[accessKeyId];
  if (secret === undefined) return [403, "InvalidAccessKeyId"];
  const amzDate = header("x-amz-date");
  if (region !== options.region || !amzDate.startsWith(date)) return [400, "AuthorizationHeaderMalformed"];
  const sent = Date.parse(amzDate.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z"));
  if (!(Math.abs(sent - Date.now()) <= 15 * 60_000)) return [403, "RequestTimeTooSkewed"];
  const signed = signedHeaders.split(";");
  const required = ["host", "x-amz-content-sha256", "x-amz-date", ...(options.sessionToken ? ["x-amz-security-token"] : [])];
  if (required.some((name) => !signed.includes(name))) return [403, "AccessDenied"];
  if (options.sessionToken && header("x-amz-security-token") !== options.sessionToken) return [403, "InvalidToken"];
  const payloadHash = header("x-amz-content-sha256");
  if (payloadHash !== "UNSIGNED-PAYLOAD" && payloadHash !== sha256(body)) return [400, "XAmzContentSHA256Mismatch"];

  const [path = "/", query = ""] = (req.url ?? "/").split("?");
  const canonicalRequest = [
    req.method ?? "",
    path.split("/").map((segment) => awsUriEncode(decodeURIComponent(segment))).join("/"),
    query
      .split("&")
      .filter(Boolean)
      .map((pair) => pair.split("=").map((part) => awsUriEncode(decodeURIComponent(part))))
      .map(([name = "", value = ""]) => `${name}=${value}`)
      .sort()
      .join("&"),
    signed.map((name) => `${name}:${header(name).trim()}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, `${date}/${region}/s3/aws4_request`, sha256(canonicalRequest)].join("\n");
  const signingKey = [region, "s3", "aws4_request"].reduce<Buffer>((key, part) => hmac(key, part), hmac(`AWS4${secret}`, date));
  return hmac(signingKey, stringToSign).toString("hex") === signature ? null : [403, "SignatureDoesNotMatch"];
}

export async function startFakeS3(input: FakeS3Options): Promise<FakeS3> {
  const options = { ...input, region: input.region ?? "us-east-1" };
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const requests: FakeS3Request[] = [];
  let failures = 0;
  let failureStatus = 503;

  const handle = (req: IncomingMessage, res: ServerResponse, body: Buffer): void => {
    const host = req.headers.host ?? "";
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const record: FakeS3Request = { method: req.method ?? "", host, path, headers: req.headers, status: 0 };
    requests.push(record);
    const reply = (status: number, payload: Buffer | string, contentType: string): void => {
      record.status = status;
      res.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    };
    const error = (status: number, code: string): void =>
      reply(status, `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${code} (fake S3)</Message></Error>`, "application/xml");

    if (failures > 0) {
      failures--;
      return error(failureStatus, failureStatus === 503 ? "SlowDown" : "InternalError");
    }
    const refused = verify(req, body, options);
    if (refused) return error(...refused);

    const segments = path.slice(1).split("/").map((segment) => decodeURIComponent(segment));
    const hostname = host.replace(/:\d+$/, "");
    const virtual = options.virtualHost !== undefined && hostname.endsWith(`.${options.virtualHost}`);
    const bucket = virtual ? hostname.slice(0, -(options.virtualHost!.length + 1)) : (segments.shift() ?? "");
    const key = segments.join("/");
    if (bucket !== options.bucket) return error(404, "NoSuchBucket");
    if (req.method === "PUT") {
      objects.set(key, { body, contentType: String(req.headers["content-type"] ?? "binary/octet-stream") });
      res.setHeader("etag", `"${createHash("md5").update(body).digest("hex")}"`);
      return reply(200, "", "text/plain");
    }
    if (req.method === "GET") {
      const object = objects.get(key);
      return object ? reply(200, object.body, object.contentType) : error(404, "NoSuchKey");
    }
    return error(405, "MethodNotAllowed");
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => handle(req, res, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    port,
    objects,
    requests,
    failNext(count, status = 503) {
      failures = count;
      failureStatus = status;
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
