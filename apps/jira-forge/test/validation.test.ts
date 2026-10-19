import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SEARCH_QUERY_LENGTH,
  MAX_TICKET_KEYS,
  allInProject,
  isIssueKey,
  isProjectEnabled,
  isProjectKey,
  isUuid,
  jqlQuote,
  newIdempotencyKey,
  normalizeSearchQuery,
  normalizeVersionName,
  parseProjectList,
  parseTicketKeys,
  projectKeyOfIssue,
  readIdempotencyKey,
  readIssueKey,
  readIssueKeyWithSource,
  readProjectKey,
  readProjectKeyWithSource,
} from "../src/validation.ts";

test("issue and project keys follow the OpenAPI pattern", () => {
  for (const key of ["PAY-123", "AB-1", "A1_B-99", "ZZZ_TEAM-100000"]) assert.ok(isIssueKey(key), key);
  for (const key of ["pay-123", "PAY-", "PAY123", "-1", "PAY-1a", "P-1", "PAY-1\n", "PAY-1/../x", "PAY-1 ", "", "PAY--1", 42, null, undefined, {}]) {
    assert.ok(!isIssueKey(key), String(key));
  }
  for (const key of ["PAY", "AB", "A1_B", "SEC_OPS"]) assert.ok(isProjectKey(key), key);
  for (const key of ["pay", "P", "1AB", "PAY-1", "PAY KEY", "PAY/..", "", 7]) assert.ok(!isProjectKey(key), String(key));
  assert.equal(projectKeyOfIssue("PAY-123"), "PAY");
  assert.equal(projectKeyOfIssue("A1_B-9"), "A1_B");
});

test("uuid check", () => {
  assert.ok(isUuid("0192d4c1-7a3e-7c11-8a54-3f9b2d1c0e77"));
  assert.ok(isUuid("0192D4C1-7A3E-7C11-8A54-3F9B2D1C0E77"));
  for (const value of ["", "not-a-uuid", "0192d4c1-7a3e-7c11-8a54-3f9b2d1c0e7", "0192d4c1-7a3e-7c11-8a54-3f9b2d1c0e77/../x", 5, undefined]) {
    assert.ok(!isUuid(value), String(value));
  }
});

test("the issue key comes from the trusted Forge context before the payload", () => {
  const context = { extension: { issue: { key: "PAY-1" }, project: { key: "PAY" } } };
  assert.equal(readIssueKey(context, { issueKey: "SEC-9" }), "PAY-1", "a forged payload must not override the context");
  assert.equal(readIssueKey({}, { issueKey: "SEC-9" }), "SEC-9", "the payload is only a fallback");
  assert.equal(readIssueKey(context, undefined), "PAY-1");
  assert.equal(readIssueKey({ extension: { issue: { key: "../../etc" } } }, { issueKey: "SEC-9" }), "SEC-9", "an invalid context value is ignored");
  assert.equal(readIssueKey({}, { issueKey: "pay-1" }), undefined);
  assert.equal(readIssueKey(undefined, undefined), undefined);
  assert.equal(readIssueKey({ extension: null }, null), undefined);
});

test("the project key comes from the trusted context before the payload", () => {
  const context = { extension: { project: { key: "PAY" } } };
  assert.equal(readProjectKey(context, { project: "SEC" }), "PAY");
  assert.equal(readProjectKey({}, { project: "SEC" }), "SEC");
  assert.equal(readProjectKey({}, { project: "sec" }), undefined);
  assert.equal(readProjectKey({}, {}), undefined);
});

test("version names and search queries are normalized", () => {
  assert.equal(normalizeVersionName(" 2.4.0 "), "2.4.0");
  assert.equal(normalizeVersionName("Release 2026.10 (beta)"), "Release 2026.10 (beta)");
  assert.equal(normalizeVersionName("a\u0000b"), "a b", "control characters become spaces");
  assert.equal(normalizeVersionName(""), undefined);
  assert.equal(normalizeVersionName("   "), undefined);
  assert.equal(normalizeVersionName("x".repeat(256)), undefined);
  assert.equal(normalizeVersionName(240), undefined);

  assert.equal(normalizeSearchQuery("  refund   a\tpayment \n"), "refund a payment");
  assert.equal(normalizeSearchQuery(undefined), "");
  assert.equal(normalizeSearchQuery(12), "");
  assert.equal(normalizeSearchQuery("a".repeat(500)).length, MAX_SEARCH_QUERY_LENGTH);
});

test("ticket key lists: every entry must be a ticket key", () => {
  assert.deepEqual(parseTicketKeys(["PAY-1", "PAY-2", "PAY-1"]), { keys: ["PAY-1", "PAY-2"], invalid: false });
  assert.deepEqual(parseTicketKeys([]), { keys: [], invalid: false });
  assert.equal(parseTicketKeys(["PAY-1", "pay-2"]).invalid, true);
  assert.equal(parseTicketKeys(["PAY-1", 7]).invalid, true);
  assert.equal(parseTicketKeys("PAY-1").invalid, true);
  assert.equal(parseTicketKeys(undefined).invalid, true);
  assert.equal(parseTicketKeys(Array.from({ length: MAX_TICKET_KEYS + 1 }, (_, i) => `PAY-${i + 1}`)).invalid, true);
  assert.equal(parseTicketKeys(Array.from({ length: MAX_TICKET_KEYS }, (_, i) => `PAY-${i + 1}`)).invalid, false);
});

test("project lists: separators, case, duplicates, invalid entries", () => {
  assert.deepEqual(parseProjectList("pay, SEC;ops  pay"), { projects: ["PAY", "SEC", "OPS"], invalid: [] });
  assert.deepEqual(parseProjectList(""), { projects: [], invalid: [] });
  assert.deepEqual(parseProjectList(" , ; "), { projects: [], invalid: [] });
  assert.deepEqual(parseProjectList("PAY, 9bad, a/b, x"), { projects: ["PAY"], invalid: ["9bad", "a/b", "x"] });
});

test("an empty project list enables every project", () => {
  assert.equal(isProjectEnabled([], "PAY"), true);
  assert.equal(isProjectEnabled(["PAY", "SEC"], "SEC"), true);
  assert.equal(isProjectEnabled(["PAY", "SEC"], "OPS"), false);
});

test("idempotency keys: accepted only when well formed; generated keys are accepted", () => {
  assert.equal(readIdempotencyKey("0192d4c1-7a3e-7c11-8a54-3f9b2d1c0e77"), "0192d4c1-7a3e-7c11-8a54-3f9b2d1c0e77");
  assert.equal(readIdempotencyKey("short"), undefined);
  assert.equal(readIdempotencyKey("has space in it"), undefined);
  assert.equal(readIdempotencyKey("line\nbreak-key"), undefined);
  assert.equal(readIdempotencyKey("x".repeat(129)), undefined);
  assert.equal(readIdempotencyKey(undefined), undefined);
  const generated = newIdempotencyKey();
  assert.equal(readIdempotencyKey(generated), generated);
  assert.notEqual(newIdempotencyKey(), generated);
});

test("a key from the Forge context is trusted; a key from the payload is not", () => {
  const context = { extension: { issue: { key: "PAY-1" }, project: { key: "PAY" } } };
  assert.deepEqual(readIssueKeyWithSource(context, undefined), { key: "PAY-1", trusted: true });
  assert.deepEqual(readIssueKeyWithSource({}, { issueKey: "SEC-9" }), { key: "SEC-9", trusted: false });
  assert.deepEqual(readProjectKeyWithSource(context, undefined), { key: "PAY", trusted: true });
  assert.deepEqual(readProjectKeyWithSource({}, { project: "SEC" }), { key: "SEC", trusted: false });
});

test("the context wins over a different key in the payload, and the result stays trusted", () => {
  const context = { extension: { issue: { key: "PAY-1" }, project: { key: "PAY" } } };
  // The forged payload key is ignored entirely, so no visibility check is needed for the context key.
  assert.deepEqual(readIssueKeyWithSource(context, { issueKey: "SEC-9" }), { key: "PAY-1", trusted: true });
  assert.deepEqual(readProjectKeyWithSource(context, { project: "SEC" }), { key: "PAY", trusted: true });
  // The same key in both places is still trusted: the context is what counts.
  assert.deepEqual(readIssueKeyWithSource(context, { issueKey: "PAY-1" }), { key: "PAY-1", trusted: true });
});

test("a malformed context value is ignored and the payload fallback is untrusted", () => {
  assert.deepEqual(readIssueKeyWithSource({ extension: { issue: { key: "../../etc" } } }, { issueKey: "SEC-9" }), { key: "SEC-9", trusted: false });
  assert.deepEqual(readProjectKeyWithSource({ extension: { project: { key: "pay" } } }, { project: "SEC" }), { key: "SEC", trusted: false });
  // Wrong types and shapes never throw and never count as trusted.
  for (const context of [undefined, null, 42, "x", [], { extension: null }, { extension: { issue: null } }, { extension: { issue: { key: 7 } } }]) {
    assert.deepEqual(readIssueKeyWithSource(context, { issueKey: "SEC-9" }), { key: "SEC-9", trusted: false }, JSON.stringify(context));
  }
});

test("no usable key anywhere gives undefined", () => {
  assert.equal(readIssueKeyWithSource({}, {}), undefined);
  assert.equal(readIssueKeyWithSource({ extension: { issue: { key: "bad" } } }, { issueKey: "also bad" }), undefined);
  assert.equal(readProjectKeyWithSource(undefined, undefined), undefined);
  assert.equal(readProjectKeyWithSource({}, { project: "a/b" }), undefined);
});

test("the plain readers return the same key as the sourced ones", () => {
  const context = { extension: { issue: { key: "PAY-1" }, project: { key: "PAY" } } };
  for (const [ctx, payload] of [[context, { issueKey: "SEC-9", project: "SEC" }], [{}, { issueKey: "SEC-9", project: "SEC" }], [{}, {}]] as const) {
    assert.equal(readIssueKey(ctx, payload), readIssueKeyWithSource(ctx, payload)?.key);
    assert.equal(readProjectKey(ctx, payload), readProjectKeyWithSource(ctx, payload)?.key);
  }
});

test("ticket keys must belong to the project they are sent with", () => {
  assert.equal(allInProject(["PAY-1", "PAY-22"], "PAY"), true);
  assert.equal(allInProject([], "PAY"), true);
  assert.equal(allInProject(["PAY-1", "SEC-3"], "PAY"), false, "a key from another project is refused");
  assert.equal(allInProject(["PAYX-1"], "PAY"), false, "a prefix of the key is not the project");
  assert.equal(allInProject(["PA-1"], "PAY"), false);
  assert.equal(allInProject(["A1_B-9"], "A1_B"), true);
});

/** Reads one JQL string literal the way JQL does for the two escapes jqlQuote writes: \\ and \". */
function readJqlString(literal: string): { value: string; end: number } {
  assert.equal(literal[0], '"', "a literal starts with a double quote");
  let value = "";
  for (let i = 1; i < literal.length; i++) {
    const c = literal[i];
    if (c === "\\") {
      value += literal[i + 1] ?? "";
      i++;
    } else if (c === '"') {
      return { value, end: i + 1 };
    } else {
      value += c;
    }
  }
  throw new Error(`unterminated JQL string: ${literal}`);
}

test("jqlQuote wraps a value in double quotes and escapes backslash and double quote", () => {
  assert.equal(jqlQuote("2.4.0"), '"2.4.0"');
  assert.equal(jqlQuote(""), '""');
  assert.equal(jqlQuote('say "hi"'), '"say \\"hi\\""');
  assert.equal(jqlQuote("a\\b"), '"a\\\\b"');
  assert.equal(jqlQuote('\\"'), '"\\\\\\""', "the backslash is escaped before the quote, not after");
  assert.equal(jqlQuote("Release 2026.10 (beta) \u00e9\u00df\u4e2d"), '"Release 2026.10 (beta) \u00e9\u00df\u4e2d"');
});

test("a value cannot close the quote and add JQL of its own", () => {
  const injected = '1.0" OR project = "SEC';
  const quoted = jqlQuote(injected);
  assert.equal(quoted, '"1.0\\" OR project = \\"SEC"');
  const read = readJqlString(quoted);
  assert.equal(read.value, injected);
  assert.equal(read.end, quoted.length, "the whole text is one literal: nothing is left over to be read as JQL");
  // A trailing backslash must not escape the closing quote.
  const trailing = jqlQuote("2.4.0\\");
  assert.equal(trailing, '"2.4.0\\\\"');
  assert.equal(readJqlString(trailing).end, trailing.length);
});

test("jqlQuote round-trips arbitrary strings made of quotes, backslashes and ordinary characters", () => {
  const alphabet = ['"', "\\", "a", "Z", "9", " ", ".", "(", ")", "=", "'", "\u00e9"];
  let seed = 12345;
  const next = () => (seed = (seed * 48271) % 2147483647);
  for (let round = 0; round < 500; round++) {
    const length = next() % 12;
    const value = Array.from({ length }, () => alphabet[next() % alphabet.length]).join("");
    const quoted = jqlQuote(value);
    const read = readJqlString(quoted);
    assert.equal(read.value, value, JSON.stringify(value));
    assert.equal(read.end, quoted.length, `${JSON.stringify(value)} leaks past its closing quote`);
  }
});
