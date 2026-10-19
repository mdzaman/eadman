import type { Writable } from "node:stream";

export interface CliContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: Pick<Writable, "write">;
  stderr: Pick<Writable, "write">;
  fetch: typeof fetch;
  color: boolean;
  /** Current time (injectable for tests). */
  now: () => Date;
}

export function defaultContext(): CliContext {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    fetch,
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    now: () => new Date(),
  };
}

export const EXIT = { OK: 0, GATE_FAILED: 1, USAGE: 2, INTERNAL: 3, PLATFORM: 4 } as const;

export class UsageError extends Error {}

export function out(ctx: CliContext, text: string): void {
  ctx.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function err(ctx: CliContext, text: string): void {
  ctx.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}
