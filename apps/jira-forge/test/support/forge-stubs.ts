/**
 * In-memory stand-ins for @forge/api, @forge/kvs and @forge/resolver.
 *
 * test/resolvers.test.ts bundles src/index.ts with esbuild and points all three package names at this
 * one file, so the real resolver code runs without the Forge packages (which are not installed at the
 * repository root) and without a Forge runtime. Every stub mirrors the shape of the real API, which
 * the app's own typecheck verifies against the real typings; `route` is a copy of the real
 * implementation's escaping rules, because the path-traversal check is something the resolvers rely on.
 *
 * The test controls the stubs through `globalThis.__forgeStubState` (the bundle is a separate module
 * instance, so a global is the only channel).
 */

export interface DocOpsCall {
  remoteKey: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface Reply {
  status: number;
  /** Serialized as JSON unless `text` is given. */
  body?: unknown;
  text?: string;
}

/** What `asUser().requestJira` was called with. */
export interface JiraRequest {
  route: string;
  method: string;
  body: string | undefined;
}

export interface StubState {
  /** Answers Jira REST calls made as the user (`asUser().requestJira`). Receives the route, query included, and the request. */
  jira: (route: string, request: JiraRequest) => Reply | Error;
  /** Answers calls to the DocOps remote (`invokeRemote`). Throwing an Error simulates a platform failure. */
  docops: (call: DocOpsCall) => Reply | Error;
  kvs: Map<string, unknown>;
  /** When true every kvs call rejects. */
  kvsDown: boolean;
  installationId: string;
  /** Routes of the Jira calls, in order. */
  jiraCalls: string[];
  /** The same calls with their method and body. */
  jiraRequests: JiraRequest[];
  docopsCalls: DocOpsCall[];
}

declare global {
  var __forgeStubState: StubState | undefined;
}

function state(): StubState {
  const current = globalThis.__forgeStubState;
  if (current === undefined) throw new Error("globalThis.__forgeStubState is not set");
  return current;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function toResponse(reply: Reply): FetchResponse {
  const text = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    statusText: reply.status === 404 ? "Not Found" : reply.status === 401 ? "Unauthorized" : "",
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  };
}

// ---- @forge/api -------------------------------------------------------------------------------

/** Same escaping as @forge/api's route(): path parameters may not contain traversal characters. */
class Route {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}

const ENDS_PATH = ["?", "#"];
const FORBIDDEN_IN_PATH = ["..", ".%2e", "%2e.", "%2e%2e", ".%2E", "%2E.", "%2E%2e", "/", "\\", "?", "#"];

export function route(template: TemplateStringsArray, ...parameters: Array<string | number | URLSearchParams | Route>): Route {
  let mode: "path" | "query" = "path";
  let result = "";
  for (let i = 0; i < template.length; i++) {
    const fragment = template[i] ?? "";
    if (ENDS_PATH.some((c) => fragment.includes(c))) mode = "query";
    result += fragment;
    if (i >= parameters.length) break;
    const parameter = parameters[i];
    if (mode === "path") {
      if (parameter instanceof Route) {
        result += parameter.value;
      } else {
        const text = String(parameter);
        if (FORBIDDEN_IN_PATH.some((bad) => text.includes(bad))) throw new Error("Disallowing path manipulation attempt.");
        result += text;
      }
    } else if (parameter instanceof Route) {
      result += encodeURIComponent(parameter.value);
    } else if (parameter instanceof URLSearchParams) {
      result += parameter.toString();
    } else {
      result += encodeURIComponent(String(parameter));
    }
  }
  return new Route(result);
}

export function asUser() {
  return {
    requestJira: async (target: Route, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<FetchResponse> => {
      const s = state();
      const request: JiraRequest = { route: target.value, method: init?.method ?? "GET", body: init?.body };
      s.jiraCalls.push(target.value);
      s.jiraRequests.push(request);
      const reply = s.jira(target.value, request);
      if (reply instanceof Error) throw reply;
      return toResponse(reply);
    },
  };
}

export async function invokeRemote(remoteKey: string, options: { path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<FetchResponse> {
  const s = state();
  const call: DocOpsCall = { remoteKey, path: options.path, method: options.method ?? "GET", headers: options.headers ?? {}, body: options.body };
  s.docopsCalls.push(call);
  const reply = s.docops(call);
  if (reply instanceof Error) throw reply;
  return toResponse(reply);
}

export function getAppContext() {
  return { installationAri: { installationId: state().installationId } };
}

// ---- @forge/kvs -------------------------------------------------------------------------------

export const kvs = {
  get: async <T>(key: string): Promise<T | undefined> => {
    const s = state();
    if (s.kvsDown) throw new Error("kvs unavailable");
    return s.kvs.get(key) as T | undefined;
  },
  set: async (key: string, value: unknown): Promise<void> => {
    const s = state();
    if (s.kvsDown) throw new Error("kvs unavailable");
    s.kvs.set(key, structuredClone(value));
  },
};

// ---- @forge/resolver --------------------------------------------------------------------------

type ResolverFunction = (request: { payload: unknown; context: Record<string, unknown> }) => unknown;

/** Mirrors @forge/resolver: `payload || {}`, a duplicate or unknown function key throws, results are JSON round-tripped. */
export default class Resolver {
  private functions: Record<string, ResolverFunction> = {};

  define(functionKey: string, cb: ResolverFunction): this {
    if (functionKey in this.functions) throw new Error(`Resolver definition '${functionKey}' already exists.`);
    this.functions[functionKey] = cb;
    return this;
  }

  getDefinitions() {
    return async (invocation: { call: { functionKey: string; payload?: unknown }; context: Record<string, unknown> }): Promise<unknown> => {
      const fn = this.functions[invocation.call.functionKey];
      if (fn === undefined) throw new Error(`Resolver has no definition for '${invocation.call.functionKey}'.`);
      const result = await fn({ payload: invocation.call.payload || {}, context: { ...invocation.context } });
      return typeof result === "object" ? (JSON.parse(JSON.stringify(result)) as unknown) : result;
    };
  }
}
