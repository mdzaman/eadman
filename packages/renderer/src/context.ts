import type { ParsedPage } from "@docops/markdown";
import type { Variables } from "./variables.ts";

/** An API operation as seen by `<ApiOperation>` and the sidebar. */
export interface OperationRef {
  sourceId: string;
  method: string;
  path: string;
  operationId?: string | undefined;
  summary?: string | undefined;
  deprecated: boolean;
  /** Absolute URL path of the operation page. */
  url: string;
}

export interface OperationQuery {
  /** "POST /v1/payments" (or an operationId). */
  op?: string | undefined;
  operationId?: string | undefined;
  source?: string | undefined;
}

export interface OperationLookup {
  find(query: OperationQuery): OperationRef | undefined;
}

/** Everything Markdown rendering needs from the site build. */
export interface RenderContext {
  basePath: string;
  /** Normalized repo-relative docs root ("docs"). */
  docsRoot: string;
  variables: Variables;
  snippets: Map<string, ParsedPage>;
  operations: OperationLookup;
}

export const emptyOperations: OperationLookup = { find: () => undefined };
