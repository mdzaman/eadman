import { canonicalJson, type AttributeDelta, type EntityChange, type EntityDefinition } from "@docops/core";

/** Attribute paths whose changes never make docs wrong on their own. */
const COSMETIC = new Set(["description", "summary", "title"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Leaf-level attribute deltas. Arrays are compared as whole values. */
export function diffAttributes(before: unknown, after: unknown, prefix = ""): AttributeDelta[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffAttributes(before[k], after[k], prefix ? `${prefix}.${k}` : k));
  }
  if (canonicalJson(before ?? null) === canonicalJson(after ?? null)) return [];
  return [{ path: prefix, before, after }];
}

function withoutNames(e: EntityDefinition): string {
  const { name: _name, description: _description, operationId: _opId, path: _path, ...rest } = e.attributes;
  return canonicalJson(rest);
}

function isBreaking(change: Omit<EntityChange, "breaking" | "userVisible">): boolean {
  const entity = change.before ?? change.after;
  if (!entity || entity.visibility === "internal") return false;
  if (change.type === "removed" || change.type === "renamed") return true;
  if (change.type === "added") return change.after?.kind === "api.parameter" && change.after.attributes.required === true;
  for (const d of change.deltas) {
    const leaf = d.path.split(".").pop() ?? d.path;
    if (leaf === "required" && d.before !== true && d.after === true) return true;
    if (d.path === "requestBody.required" && d.after === true) return true;
    if (["type", "format", "in", "ref"].includes(leaf)) return true;
    if (leaf === "enum" && Array.isArray(d.before)) {
      const after = new Set((Array.isArray(d.after) ? d.after : []).map((v) => canonicalJson(v)));
      if (d.before.some((v) => !after.has(canonicalJson(v)))) return true;
    }
    if (d.path === "responses" && Array.isArray(d.before)) {
      const after = new Set(Array.isArray(d.after) ? d.after : []);
      if (d.before.some((code) => !after.has(code))) return true;
    }
  }
  return false;
}

function userVisible(change: Omit<EntityChange, "breaking" | "userVisible">): boolean {
  if (change.type !== "modified") return true;
  return change.deltas.some((d) => !COSMETIC.has(d.path.split(".").pop() ?? "") && !d.path.startsWith("x-"));
}

/**
 * Diff two entity snapshots. Detects renames (same parent and kind, identical
 * attributes apart from naming fields) and classifies breaking / user-visible changes.
 */
export function diffEntities(base: readonly EntityDefinition[], head: readonly EntityDefinition[]): EntityChange[] {
  const before = new Map(base.map((e) => [e.key, e]));
  const after = new Map(head.map((e) => [e.key, e]));
  const removed = base.filter((e) => !after.has(e.key));
  const added = head.filter((e) => !before.has(e.key));
  const changes: Array<Omit<EntityChange, "breaking" | "userVisible">> = [];

  // Rename detection: pair removed/added entities with the same kind and parent.
  const pairedAdded = new Set<string>();
  const pairedRemoved = new Set<string>();
  for (const r of removed) {
    const candidates = added.filter(
      (a) => !pairedAdded.has(a.key) && a.kind === r.kind && a.parentKey === r.parentKey && a.sourceKey === r.sourceKey,
    );
    const sameShape = candidates.filter((a) => withoutNames(a) === withoutNames(r));
    const sameOperationId =
      r.kind === "api.operation" && r.attributes.operationId
        ? candidates.filter((a) => a.attributes.operationId === r.attributes.operationId)
        : [];
    const match = sameOperationId[0] ?? (sameShape.length === 1 ? sameShape[0] : undefined);
    if (match) {
      pairedAdded.add(match.key);
      pairedRemoved.add(r.key);
      changes.push({
        type: "renamed",
        key: r.key,
        kind: r.kind,
        before: r,
        after: match,
        renamedTo: match.key,
        deltas: diffAttributes(r.attributes, match.attributes),
      });
    }
  }
  for (const r of removed) if (!pairedRemoved.has(r.key)) changes.push({ type: "removed", key: r.key, kind: r.kind, before: r, deltas: [] });
  for (const a of added) if (!pairedAdded.has(a.key)) changes.push({ type: "added", key: a.key, kind: a.kind, after: a, deltas: [] });
  for (const [key, b] of before) {
    const a = after.get(key);
    if (!a || a.fingerprint === b.fingerprint) continue;
    changes.push({ type: "modified", key, kind: b.kind, before: b, after: a, deltas: diffAttributes(b.attributes, a.attributes) });
  }

  return changes
    .map((c) => ({ ...c, breaking: isBreaking(c), userVisible: userVisible(c) }))
    .sort((x, y) => x.key.localeCompare(y.key));
}

/** One-line human description of a change, used in findings and PR comments. */
export function describeChange(change: EntityChange): string {
  const name = change.before?.name ?? change.after?.name ?? change.key;
  switch (change.type) {
    case "added":
      return `added ${change.kind} ${name}`;
    case "removed":
      return `removed ${change.kind} ${name}`;
    case "renamed":
      return `renamed ${change.kind} ${name} → ${change.after?.name}`;
    case "modified":
      return `${change.kind} ${name}: ${change.deltas
        .slice(0, 3)
        .map((d) => `${d.path} ${formatDelta(d.before, d.after)}`)
        .join("; ")}${change.deltas.length > 3 ? "; …" : ""}`;
  }
}

/** `30000 → 60000`, or for arrays only what changed: `−amount +amount_cents`. */
function formatDelta(before: unknown, after: unknown): string {
  if (Array.isArray(before) && Array.isArray(after)) {
    const b = new Set(before.map((v) => canonicalJson(v)));
    const a = new Set(after.map((v) => canonicalJson(v)));
    const removed = before.filter((v) => !a.has(canonicalJson(v))).map((v) => `−${formatValue(v)}`);
    const added = after.filter((v) => !b.has(canonicalJson(v))).map((v) => `+${formatValue(v)}`);
    if (removed.length + added.length > 0) return [...removed, ...added].join(" ");
  }
  return `${formatValue(before)} → ${formatValue(after)}`;
}

export function formatValue(value: unknown): string {
  if (value === undefined) return "∅";
  if (typeof value === "string") return value;
  return canonicalJson(value);
}
