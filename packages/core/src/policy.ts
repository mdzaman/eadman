/**
 * RBAC matrix. Must match the table in docs/08-security-compliance.md §3;
 * packages/core/test/policy.test.ts parses that table and fails on any drift.
 */

export const ROLES = [
  "org_owner",
  "org_admin",
  "space_admin",
  "maintainer",
  "editor",
  "commenter",
  "viewer",
  "auditor",
  "billing_admin",
  "ci_publisher",
  "tracker_app",
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "page.read",
  "page.comment",
  "page.propose",
  "suggestion.decide",
  "link.manage",
  "checks.write",
  "preview.publish",
  "deployment.promote.nonprod",
  "deployment.promote.prod",
  "finding.dismiss",
  "gate.waive",
  "readiness.read",
  "readiness.doc_tasks",
  "analytics.read",
  "space.settings",
  "space.members",
  "audit.read",
  "audit.export",
  "tenant.export",
  "org.members",
  "org.sso",
  "integration.manage",
  "ai.settings",
  "webhook.manage",
  "token.manage",
  "billing.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** "own": allowed only on resources the principal owns (its own tokens). */
export type Grant = "allow" | "own";

const ALL: Role[] = [...ROLES];
const CONTENT_ROLES: Role[] = ["org_owner", "org_admin", "space_admin", "maintainer", "editor"];
const MAINTAINERS: Role[] = ["org_owner", "org_admin", "space_admin", "maintainer"];
const ADMINS: Role[] = ["org_owner", "org_admin"];

function grant(roles: Role[], value: Grant = "allow"): Partial<Record<Role, Grant>> {
  return Object.fromEntries(roles.map((r) => [r, value]));
}

export const ROLE_PERMISSIONS: Record<Permission, Partial<Record<Role, Grant>>> = {
  "page.read": grant(ALL.filter((r) => r !== "billing_admin")),
  "page.comment": grant([...CONTENT_ROLES, "commenter"]),
  "page.propose": grant(CONTENT_ROLES),
  "suggestion.decide": grant(CONTENT_ROLES),
  "link.manage": grant([...CONTENT_ROLES, "ci_publisher", "tracker_app"]),
  "checks.write": grant([...MAINTAINERS, "ci_publisher"]),
  "preview.publish": grant([...CONTENT_ROLES, "ci_publisher"]),
  "deployment.promote.nonprod": grant([...MAINTAINERS, "ci_publisher"]),
  "deployment.promote.prod": grant([...MAINTAINERS, "ci_publisher"]),
  "finding.dismiss": grant(MAINTAINERS),
  "gate.waive": grant(MAINTAINERS),
  "readiness.read": grant([...CONTENT_ROLES, "commenter", "viewer", "auditor", "tracker_app"]),
  "readiness.doc_tasks": grant([...MAINTAINERS, "tracker_app"]),
  "analytics.read": grant([...MAINTAINERS, "auditor"]),
  "space.settings": grant(["org_owner", "org_admin", "space_admin"]),
  "space.members": grant(["org_owner", "org_admin", "space_admin"]),
  "audit.read": grant([...ADMINS, "auditor"]),
  "audit.export": grant(["org_owner", "auditor"]),
  "tenant.export": grant(ADMINS),
  "org.members": grant(ADMINS),
  "org.sso": grant(ADMINS),
  "integration.manage": grant(ADMINS),
  "ai.settings": grant(ADMINS),
  "webhook.manage": grant(ADMINS),
  "token.manage": {
    ...grant(ADMINS),
    ...grant(["space_admin", "maintainer", "editor", "commenter", "viewer", "auditor", "billing_admin"], "own"),
  },
  "billing.manage": grant(["org_owner", "billing_admin"]),
};

/** Scope a role binding applies to. A binding covers its scope and everything beneath it. */
export interface RoleBinding {
  role: Role;
  scopeType: "org" | "space" | "page";
  scopeId: string | null;
}

export interface ResourceScope {
  spaceId?: string | undefined;
  pageId?: string | undefined;
  /** For "own"-gated permissions: is the principal the owner of the resource? */
  ownedByPrincipal?: boolean | undefined;
}

function bindingCovers(binding: RoleBinding, scope: ResourceScope): boolean {
  if (binding.scopeType === "org") return true;
  if (binding.scopeType === "space") return binding.scopeId !== null && binding.scopeId === scope.spaceId;
  return binding.scopeId !== null && binding.scopeId === scope.pageId;
}

/** Deny-by-default evaluation over a principal's role bindings. */
export function can(bindings: readonly RoleBinding[], permission: Permission, scope: ResourceScope = {}): boolean {
  const matrix = ROLE_PERMISSIONS[permission];
  for (const binding of bindings) {
    if (!bindingCovers(binding, scope)) continue;
    const g = matrix[binding.role];
    if (g === "allow") return true;
    if (g === "own" && scope.ownedByPrincipal === true) return true;
  }
  return false;
}

/** API token scopes cap what a credential may do; roles decide what the principal can do. */
export const TOKEN_SCOPES = [
  "docs:read",
  "docs:write",
  "checks:write",
  "builds:write",
  "deployments:write",
  "links:write",
  "readiness:read",
  "ai:use",
  "audit:read",
  "admin",
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export function hasScope(scopes: readonly string[], required: TokenScope): boolean {
  return scopes.includes("admin") || scopes.includes(required);
}
