import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { assertCheckableUrl, checkUrl, guardedLookup, isPublicAddress } from "../src/ssrf.ts";

test("classifies private, loopback, link-local and metadata addresses as non-public", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("refuses non-http schemes, credentials and internal hostnames before connecting", () => {
  for (const url of ["file:///etc/passwd", "gopher://x", "http://user:pw@example.com/", "http://localhost:8080/", "http://metadata.google.internal/", "http://[::1]/"]) {
    assert.throws(() => assertCheckableUrl(url), url);
  }
});

test("never connects to a loopback server (SSRF), even via a hostname that resolves to it", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const direct = await checkUrl(`http://127.0.0.1:${port}/`);
    assert.equal(direct.ok, false);
    // The DNS-level guard: a hostname that resolves to loopback (via /etc/hosts, no network) is refused.
    const lookupError = await new Promise<Error | null>((resolve) =>
      guardedLookup("localhost", { family: 0 }, (error) => resolve(error ?? null)),
    );
    assert.match(String(lookupError?.message), /non-public address/);
    assert.equal(hits, 0, "the guarded client must not have reached the server");
  } finally {
    server.close();
  }
});
