import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ALL_ROUTES } from "../src/app.ts";

const spec = parse(readFileSync(new URL("../../../api/openapi.yaml", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, { operationId: string; "x-docops-phase"?: string }>>;
};
const declared = new Map<string, { operationId: string; phase?: string }>();
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (["get", "post", "put", "patch", "delete"].includes(method)) declared.set(`${method.toUpperCase()} ${path}`, { operationId: op.operationId, phase: op["x-docops-phase"] });
  }
}

test("every implemented route is declared in api/openapi.yaml with the same operationId", () => {
  for (const route of ALL_ROUTES) {
    const op = declared.get(`${route.method} ${route.path}`);
    assert.ok(op, `${route.method} ${route.path} is implemented but not in the spec`);
    assert.equal(op.operationId, route.operationId, `${route.method} ${route.path}`);
  }
});

test("routes are unique and the MVP implementation coverage is reported", () => {
  const keys = ALL_ROUTES.map((r) => `${r.method} ${r.path}`);
  assert.equal(new Set(keys).size, keys.length, "duplicate route");
  const mvp = [...declared.values()].filter((o) => o.phase === "mvp");
  const implemented = new Set(ALL_ROUTES.map((r) => r.operationId));
  const missing = mvp.filter((o) => !implemented.has(o.operationId)).map((o) => o.operationId);
  console.log(`# MVP operations implemented: ${mvp.length - missing.length}/${mvp.length}${missing.length ? ` (not yet: ${missing.join(", ")})` : ""}`);
  assert.ok(mvp.length - missing.length >= 40, "the scaffold implements the MVP surface");
});
