/** Line-level diff helpers. DocOps computes every diff itself; models never write one. */

export type DiffOp = { type: " " | "-" | "+"; line: string };

/** Edit script between two line arrays (common prefix and suffix trimmed, LCS in between). */
export function diffLines(before: readonly string[], after: readonly string[]): DiffOp[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  const ops: DiffOp[] = before.slice(0, prefix).map((line) => ({ type: " ", line }));
  ops.push(...lcsOps(a, b));
  ops.push(...before.slice(before.length - suffix).map((line): DiffOp => ({ type: " ", line })));
  return ops;
}

function lcsOps(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? (table[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: " ", line: a[i] as string });
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      ops.push({ type: "-", line: a[i] as string });
      i++;
    } else {
      ops.push({ type: "+", line: b[j] as string });
      j++;
    }
  }
  while (i < n) ops.push({ type: "-", line: a[i++] as string });
  while (j < m) ops.push({ type: "+", line: b[j++] as string });
  return ops;
}

/** Length of the longest common subsequence of two line arrays. */
export function commonLineCount(a: readonly string[], b: readonly string[]): number {
  return diffLines(a, b).filter((op) => op.type === " ").length;
}

/**
 * A unified diff (`git apply`-compatible) between two versions of a file.
 * Returns "" when nothing changed.
 */
export function unifiedDiff(path: string, before: readonly string[], after: readonly string[], context = 3): string {
  const ops = diffLines(before, after);
  const changes: number[] = [];
  ops.forEach((op, i) => {
    if (op.type !== " ") changes.push(i);
  });
  if (changes.length === 0) return "";

  // Group changes whose context windows touch.
  const groups: Array<[number, number]> = [];
  for (const index of changes) {
    const last = groups[groups.length - 1];
    if (last && index - last[1] <= 2 * context) last[1] = index;
    else groups.push([index, index]);
  }

  // Old/new line numbers (0-based) before each op.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const op of ops) {
    oldAt.push(oldLine);
    newAt.push(newLine);
    if (op.type !== "+") oldLine++;
    if (op.type !== "-") newLine++;
  }

  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const [first, last] of groups) {
    const start = Math.max(0, first - context);
    const end = Math.min(ops.length - 1, last + context);
    const hunk = ops.slice(start, end + 1);
    const oldCount = hunk.filter((op) => op.type !== "+").length;
    const newCount = hunk.filter((op) => op.type !== "-").length;
    const oldStart = (oldAt[start] ?? 0) + (oldCount > 0 ? 1 : 0);
    const newStart = (newAt[start] ?? 0) + (newCount > 0 ? 1 : 0);
    lines.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`);
    for (const op of hunk) lines.push(`${op.type}${op.line}`);
  }
  return `${lines.join("\n")}\n`;
}

function range(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}
