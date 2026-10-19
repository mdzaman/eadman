/**
 * Typed calls from the UI to the resolver functions in src/index.ts.
 *
 * `invoke` and `makeInvoke` are from @forge/bridge@7.2.0 (`out/invoke/invoke.d.ts`): the resolver
 * name, payload and result are checked against `ResolverDefinitions`. A call that fails inside
 * the bridge (rate limit, network) is turned into the same `ApiResult` error shape the resolvers
 * return, so screens handle one kind of failure.
 */
import { makeInvoke } from "@forge/bridge";

import type { ResolverDefinitions, SaveConfigPayload } from "../contract";
import type { ApiResult } from "../view-model";

const invokeResolver = makeInvoke<ResolverDefinitions>();

async function run<T>(call: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  try {
    return await call();
  } catch (error) {
    console.error("Resolver call failed", error instanceof Error ? error.message : error);
    return { ok: false, error: { status: 0, title: "The Jira app could not be reached" } };
  }
}

export const api = {
  getTicketDocs: (issueKey: string | undefined) => run(() => invokeResolver("getTicketDocs", { issueKey })),
  getReadiness: (project: string | undefined, fixVersion: string) => run(() => invokeResolver("getReadiness", { project, fixVersion })),
  createDocTasks: (project: string | undefined, fixVersion: string, ticketKeys: string[], idempotencyKey: string) =>
    run(() => invokeResolver("createDocTasks", { project, fixVersion, ticketKeys, idempotencyKey })),
  linkPage: (issueKey: string | undefined, pageId: string, idempotencyKey: string) => run(() => invokeResolver("linkPage", { issueKey, pageId, idempotencyKey })),
  searchPages: (query: string) => run(() => invokeResolver("searchPages", { query })),
  listFixVersions: (project: string | undefined) => run(() => invokeResolver("listFixVersions", { project })),
  getConfig: () => run(() => invokeResolver("getConfig")),
  saveConfig: (settings: SaveConfigPayload) => run(() => invokeResolver("saveConfig", settings)),
  checkConnection: () => run(() => invokeResolver("checkConnection")),
};
