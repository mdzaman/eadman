import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";

/**
 * SSRF guard for outbound requests made on behalf of repository content
 * (external link checking, remote $ref, webhook URLs): threat T17.
 */
function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inCidr4(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base ?? "0.0.0.0") & mask);
}

const BLOCKED_V4 = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
  "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
];

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_V4.some((cidr) => inCidr4(address, cidr));
  if (family === 6) {
    const a = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped?.[1]) return isPublicAddress(mapped[1]);
    if (a === "::" || a === "::1") return false;
    if (/^f[cd][0-9a-f]{2}:/.test(a)) return false; // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]:/.test(a)) return false; // fe80::/10 link local
    if (/^ff[0-9a-f]{2}:/.test(a)) return false; // multicast
    if (a.startsWith("64:ff9b:") || a.startsWith("2001:db8:")) return false;
    return true;
  }
  return false;
}

export class BlockedUrlError extends Error {}

/** DNS lookup that refuses non-public addresses. The validated address is used for the connection (no rebinding). */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 4);
    const list = Array.isArray(addresses) ? addresses : [];
    const blocked = list.find((a) => !isPublicAddress(a.address));
    if (blocked || list.length === 0) {
      return callback(new BlockedUrlError(`refusing to connect to non-public address for ${hostname}`), "", 4);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    const first = list[0]!;
    callback(null, first.address, first.family);
  });
};

export interface LinkCheckResult {
  ok: boolean;
  status?: number | undefined;
  error?: string | undefined;
}

export function assertCheckableUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError(`unsupported scheme ${url.protocol}`);
  if (url.username || url.password) throw new BlockedUrlError("credentials in URL are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) throw new BlockedUrlError(`refusing to connect to non-public address ${host}`);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) throw new BlockedUrlError(`refusing to connect to ${host}`);
  return url;
}

/** HEAD (falling back to GET on 405/501) with SSRF guard, timeout and no redirect following. */
export function checkUrl(raw: string, timeoutMs = 5000): Promise<LinkCheckResult> {
  let url: URL;
  try {
    url = assertCheckableUrl(raw);
  } catch (error) {
    return Promise.resolve({ ok: false, error: (error as Error).message });
  }
  const attempt = (method: "HEAD" | "GET") =>
    new Promise<LinkCheckResult>((resolve) => {
      const client = url.protocol === "https:" ? https : http;
      const req = client.request(
        url,
        { method, lookup: guardedLookup, timeout: timeoutMs, headers: { "user-agent": "DocOps-LinkChecker/1.0 (+https://docs.docops.example/link-checker)" } },
        (res) => {
          res.resume();
          const status = res.statusCode ?? 0;
          resolve({ ok: status < 400, status });
        },
      );
      req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
      req.on("error", (error) => resolve({ ok: false, error: error.message }));
      req.end();
    });
  return attempt("HEAD").then((r) => (r.status === 405 || r.status === 501 ? attempt("GET") : r));
}
