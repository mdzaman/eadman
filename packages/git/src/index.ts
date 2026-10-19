import { execFile } from "node:child_process";

/** Thin, shell-free wrapper around the git CLI (no option injection: refs are validated). */
export class GitError extends Error {
  readonly args: string[];
  readonly stderr: string;
  constructor(args: string[], stderr: string) {
    super(`git ${args.join(" ")} failed: ${stderr.trim().split("\n")[0] ?? ""}`);
    this.args = args;
    this.stderr = stderr;
  }
}

export function git(cwd: string, args: string[], options: { allowFailure?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } }, (error, stdout, stderr) => {
      if (error && !options.allowFailure) reject(new GitError(args, String(stderr || error.message)));
      else resolve(String(stdout));
    });
  });
}

const SAFE_REF = /^(?!-)[\w./@{}^~+-]{1,255}$/;

export function assertSafeRef(ref: string): string {
  if (!SAFE_REF.test(ref) || ref.includes("..") && !/^[\w./-]+\.\.\.?[\w./-]+$/.test(ref)) throw new Error(`unsafe git ref: ${JSON.stringify(ref)}`);
  return ref;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true })).trim() === "true";
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

export async function resolveRef(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--verify", "--quiet", `${assertSafeRef(ref)}^{commit}`])).trim();
}

export async function mergeBase(cwd: string, a: string, b = "HEAD"): Promise<string | null> {
  const out = await git(cwd, ["merge-base", assertSafeRef(a), assertSafeRef(b)], { allowFailure: true });
  return out.trim() || null;
}

/** Reader for files at a revision (`git show <ref>:<path>`); null when the path does not exist there. */
export function fileReaderAt(cwd: string, ref: string): (path: string) => Promise<string | null> {
  const safe = assertSafeRef(ref);
  return async (path) => {
    if (path.startsWith("-") || path.includes("\0")) return null;
    try {
      return await git(cwd, ["show", `${safe}:${path.replace(/^\.\//, "")}`]);
    } catch {
      return null;
    }
  };
}

/**
 * Files changed between `base` and HEAD (three-dot: since the merge base), plus, when
 * `includeWorkingTree`, uncommitted and untracked files (CI checkouts usually have none).
 */
export async function changedFiles(cwd: string, base: string, options: { includeWorkingTree?: boolean } = {}): Promise<Set<string>> {
  const files = new Set<string>();
  const diff = await git(cwd, ["diff", "--name-only", "--no-renames", `${assertSafeRef(base)}...HEAD`]);
  for (const line of diff.split("\n")) if (line.trim()) files.add(line.trim());
  if (options.includeWorkingTree ?? true) {
    const status = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
    for (const line of status.split("\n")) {
      const path = line.slice(3).trim();
      if (path) files.add(path.includes(" -> ") ? (path.split(" -> ")[1] ?? path) : path);
    }
  }
  return files;
}

export interface HeadInfo {
  sha: string;
  ref: string;
  committedAt: string;
}

export async function headInfo(cwd: string): Promise<HeadInfo> {
  const [sha = "", committedAt = ""] = (await git(cwd, ["log", "-1", "--format=%H%n%cI"])).trim().split("\n");
  const branch = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true })).trim();
  return { sha, ref: branch || process.env.GITHUB_HEAD_REF || process.env.CI_COMMIT_REF_NAME || sha.slice(0, 12), committedAt };
}

export interface CommitInfo {
  sha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
}

export async function commitsBetween(cwd: string, from: string, to = "HEAD"): Promise<CommitInfo[]> {
  const sep = "\u001e";
  const out = await git(cwd, ["log", `--format=%H%x1f%s%x1f%b%x1f%an%x1f%cI${sep}`, `${assertSafeRef(from)}..${assertSafeRef(to)}`]);
  return out
    .split(sep)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = "", subject = "", body = "", author = "", date = ""] = record.split("\u001f");
      return { sha, subject, body: body.trim(), author, date };
    });
}

/** `owner/name` from the origin remote (GitHub, GitLab, Bitbucket, Azure DevOps URLs). */
export function parseRemoteUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  const ssh = /^[\w.-]+@[\w.-]+:(.+)$/.exec(trimmed);
  if (ssh?.[1]) return ssh[1].replace(/^\/+/, "");
  try {
    const parsed = new URL(trimmed);
    const parts = parsed.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parsed.hostname.endsWith("dev.azure.com") && parts.length >= 4) return `${parts[0]}/${parts[3]}`;
    return parts.length >= 2 ? parts.join("/") : null;
  } catch {
    return null;
  }
}

export async function remoteFullName(cwd: string, remote = "origin"): Promise<string | null> {
  const url = (await git(cwd, ["remote", "get-url", remote], { allowFailure: true })).trim();
  return url ? parseRemoteUrl(url) : null;
}

export async function listTags(cwd: string, pattern = "*"): Promise<string[]> {
  const out = await git(cwd, ["tag", "--list", pattern, "--sort=-creatordate"]);
  return out.split("\n").map((t) => t.trim()).filter(Boolean);
}

/**
 * New-file line ranges covered by each file's diff hunks (`git diff -U3 base...HEAD`).
 * GitHub only accepts review comments (and therefore ```suggestion blocks) on these lines.
 */
export async function diffLineRanges(cwd: string, base: string, context = 3): Promise<Map<string, Array<[number, number]>>> {
  const out = await git(cwd, ["diff", `-U${context}`, "--no-renames", "--no-color", `${assertSafeRef(base)}...HEAD`]);
  const ranges = new Map<string, Array<[number, number]>>();
  let file: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? null : line.replace(/^\+\+\+ b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (length > 0) ranges.set(file, [...(ranges.get(file) ?? []), [start, start + length - 1]]);
    }
  }
  return ranges;
}

export function lineInRanges(ranges: Map<string, Array<[number, number]>>, file: string, line: number): boolean {
  return (ranges.get(file) ?? []).some(([a, b]) => line >= a && line <= b);
}
