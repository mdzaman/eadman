import { randomBytes } from "node:crypto";

let lastMs = 0;
let sequence = 0;

/**
 * UUIDv7 (RFC 9562): 48-bit Unix milliseconds, version, 12 bits of a monotonic
 * per-millisecond counter (rand_a), variant, 62 random bits. Time-ordered, so
 * B-tree inserts stay local. On PostgreSQL 18 `uuidv7()` is equivalent.
 */
export function uuidv7(now: number = Date.now()): string {
  if (now === lastMs) {
    sequence = (sequence + 1) & 0xfff;
  } else {
    lastMs = now;
    sequence = randomBytes(2).readUInt16BE(0) & 0x7ff;
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
