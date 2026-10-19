/**
 * The contract between the UI (src/frontend/*) and the resolver functions (src/index.ts).
 *
 * Types only. Both sides import it, so a renamed function or a changed payload is a compile error
 * instead of a runtime "Resolver has no definition for ..." surprise. The UI calls resolvers
 * through `makeInvoke<ResolverDefinitions>()` (src/frontend/api.ts) and the resolvers are
 * registered through `Handlers<ResolverDefinitions>` (src/index.ts).
 */
import type { ApiResult, DocTasksResult, JiraVersion, Link, PageSummary, Readiness, TicketDocs } from "./view-model";

// ---- payloads (everything here is user input and is validated by the resolvers) ----

export interface GetTicketDocsPayload {
  /** Only a fallback: the resolver prefers the issue in the trusted Forge context, and checks that the user can see this one. */
  issueKey?: string;
}

export interface GetReadinessPayload {
  /** Only a fallback: the resolver prefers the project in the trusted Forge context, and checks that the user can browse this one. */
  project?: string;
  fixVersion: string;
}

export interface CreateDocTasksPayload {
  project?: string;
  fixVersion: string;
  /** The "Missing" tickets the user was shown. */
  ticketKeys: string[];
  /** One key per click, so a retried invocation cannot create tasks twice. */
  idempotencyKey?: string;
}

export interface LinkPagePayload {
  issueKey?: string;
  /** `PageSummary.id` from `searchPages`. */
  pageId: string;
  idempotencyKey?: string;
}

export interface SearchPagesPayload {
  query: string;
}

export interface ListFixVersionsPayload {
  project?: string;
}

export interface SaveConfigPayload {
  /** DocOps space (UUID) searched by "Link documentation". Empty string clears it. */
  spaceId?: string;
  /** Jira project keys the app is active for. Empty means all projects. */
  projects?: string[];
}

// ---- results ----

export interface PageSearchResult {
  items: PageSummary[];
  hasMore: boolean;
}

/** Non-content settings kept in Forge hosted storage (`kvs`), scoped to this installation. */
export interface AdminConfig {
  spaceId: string | null;
  projects: string[];
  updatedAt: string | null;
}

export interface InstallationInfo {
  /** `app.installationId` in the Forge Invocation Token: what DocOps maps to a tenant. */
  installationId: string;
  cloudId: string | null;
}

export interface AdminSettings {
  config: AdminConfig;
  installation: InstallationInfo;
}

export interface ConnectionStatus {
  spaceId: string;
}

/**
 * Resolver function name -> (payload) => result. A `type` alias (not an interface) so it satisfies
 * the index-signature constraint of `Definitions` in @forge/resolver.
 */
export type ResolverDefinitions = {
  getTicketDocs: (payload: GetTicketDocsPayload) => Promise<ApiResult<TicketDocs>>;
  getReadiness: (payload: GetReadinessPayload) => Promise<ApiResult<Readiness>>;
  createDocTasks: (payload: CreateDocTasksPayload) => Promise<ApiResult<DocTasksResult>>;
  linkPage: (payload: LinkPagePayload) => Promise<ApiResult<Link>>;
  searchPages: (payload: SearchPagesPayload) => Promise<ApiResult<PageSearchResult>>;
  listFixVersions: (payload: ListFixVersionsPayload) => Promise<ApiResult<JiraVersion[]>>;
  getConfig: () => Promise<ApiResult<AdminSettings>>;
  saveConfig: (payload: SaveConfigPayload) => Promise<ApiResult<AdminConfig>>;
  checkConnection: () => Promise<ApiResult<ConnectionStatus>>;
};
