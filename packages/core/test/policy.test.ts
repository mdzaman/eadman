import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { can, PERMISSIONS, ROLE_PERMISSIONS, ROLES, type Grant, type Permission, type Role } from "../src/policy.ts";

const docPath = new URL("../../../docs/08-security-compliance.md", import.meta.url);

/** Parses the RBAC matrix table from the security design document. */
function parseDocMatrix(): Map<Permission, Map<Role, Grant | null>> {
  const lines = readFileSync(docPath, "utf8").split("\n");
  const headerIndex = lines.findIndex((l) => l.startsWith("| Permission |"));
  assert.ok(headerIndex >= 0, "RBAC table header not found in docs/08-security-compliance.md");
  const header = lines[headerIndex]!.split("|").map((c) => c.trim()).filter(Boolean).slice(1);
  const matrix = new Map<Permission, Map<Role, Grant | null>>();
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").map((c) => c.trim()).filter((c, i, all) => i > 0 && i < all.length - 1);
    const permission = cells[0]!.replaceAll("`", "") as Permission;
    const row = new Map<Role, Grant | null>();
    header.forEach((role, i) => {
      const cell = cells[i + 1];
      row.set(role as Role, cell === "✓" ? "allow" : cell === "own" ? "own" : null);
    });
    matrix.set(permission, row);
  }
  return matrix;
}

test("RBAC matrix in the security doc matches the enforced policy (no drift)", () => {
  const doc = parseDocMatrix();
  assert.deepEqual([...doc.keys()].sort(), [...PERMISSIONS].sort(), "permission rows differ");
  for (const permission of PERMISSIONS) {
    for (const role of ROLES) {
      const documented = doc.get(permission)?.get(role) ?? null;
      const enforced = ROLE_PERMISSIONS[permission][role] ?? null;
      assert.equal(enforced, documented, `${permission} × ${role}: code=${enforced} doc=${documented}`);
    }
  }
});

test("deny by default and scope containment", () => {
  const spaceEditor = [{ role: "editor" as const, scopeType: "space" as const, scopeId: "space-1" }];
  assert.equal(can(spaceEditor, "page.propose", { spaceId: "space-1" }), true);
  assert.equal(can(spaceEditor, "page.propose", { spaceId: "space-2" }), false, "space binding must not leak");
  assert.equal(can(spaceEditor, "deployment.promote.prod", { spaceId: "space-1" }), false);
  assert.equal(can([], "page.read"), false);
});

test("separation of duties: admins cannot export audit, auditors cannot change config", () => {
  const admin = [{ role: "org_admin" as const, scopeType: "org" as const, scopeId: null }];
  const auditor = [{ role: "auditor" as const, scopeType: "org" as const, scopeId: null }];
  assert.equal(can(admin, "audit.export"), false);
  assert.equal(can(auditor, "audit.export"), true);
  assert.equal(can(auditor, "integration.manage"), false);
  assert.equal(can(auditor, "page.propose"), false);
});

test("own-scoped token management", () => {
  const viewer = [{ role: "viewer" as const, scopeType: "org" as const, scopeId: null }];
  assert.equal(can(viewer, "token.manage", { ownedByPrincipal: true }), true);
  assert.equal(can(viewer, "token.manage", { ownedByPrincipal: false }), false);
});
