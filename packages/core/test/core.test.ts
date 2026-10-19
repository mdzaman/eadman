import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, fingerprint, isUuid, matchesGlob, uuidv7, gateBlocked } from "../src/index.ts";

test("uuidv7 is valid, version 7, and time-ordered", () => {
  const ids = Array.from({ length: 200 }, () => uuidv7());
  for (const id of ids) {
    assert.ok(isUuid(id), id);
    assert.equal(id[14], "7");
  }
  assert.deepEqual([...ids].sort(), ids, "ids generated in sequence must sort in sequence");
});

test("canonical JSON is key-order independent", () => {
  const a = canonicalJson({ b: 1, a: [true, null, { y: "x", x: 2 }], c: undefined });
  const b = canonicalJson({ a: [true, null, { x: 2, y: "x" }], b: 1 });
  assert.equal(a, '{"a":[true,null,{"x":2,"y":"x"}],"b":1}');
  assert.equal(a, b);
  assert.equal(fingerprint({ z: 1, a: 2 }), fingerprint({ a: 2, z: 1 }));
});

test("glob matching", () => {
  assert.ok(matchesGlob("docs/guides/payments.md", "**/*.md"));
  assert.ok(matchesGlob("payments.md", "**/*.md"));
  assert.ok(matchesGlob("runbooks/db/failover.md", "runbooks/**"));
  assert.ok(!matchesGlob("guides/x.md", "runbooks/**"));
  assert.ok(matchesGlob("guides/x.mdx", "**/*.{md,mdx}"));
  assert.ok(!matchesGlob("guides/_drafts/x.md", "guides/*.md"));
  assert.ok(matchesGlob("guides/_drafts/x.md", "**/_drafts/**"));
});

test("gate evaluation honors failOn", () => {
  const warning = { ruleId: "x/y", category: "x", severity: "warning" as const, origin: "deterministic" as const, message: "", evidence: {}, fingerprint: "1" };
  assert.equal(gateBlocked([warning], "error"), false);
  assert.equal(gateBlocked([warning], "warning"), true);
  assert.equal(gateBlocked([{ ...warning, severity: "error" }], "never"), false);
});
