import { createHash } from "node:crypto";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Canonical JSON (RFC 8785 / JCS subset): object keys sorted by UTF-16 code units,
 * no insignificant whitespace, ECMAScript number serialization. `undefined` members
 * are dropped exactly like JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("canonicalJson: non-finite numbers are not representable");
    }
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== "function")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Fingerprint of a normalized attribute bag: sha256(JCS(attributes)). */
export function fingerprint(attributes: unknown): string {
  return sha256Hex(canonicalJson(attributes));
}

/** Short, stable identifier for findings (rule + location + subject). */
export function findingFingerprint(parts: Array<string | number | undefined>): string {
  return sha256Hex(parts.map((p) => (p === undefined ? "" : String(p))).join("␟")).slice(0, 32);
}
