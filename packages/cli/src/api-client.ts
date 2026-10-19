import type { CliContext } from "./context.ts";

export class PlatformError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ApiOptions {
  apiUrl: string;
  token?: string | undefined;
  tenant?: string | undefined;
}

/**
 * Resolve credentials (docs/05-cli-and-ci.md §2): explicit token, then CI workload identity
 * (GitHub Actions, GitLab id_tokens) exchanged for a 15-minute DocOps token.
 */
export async function resolveToken(ctx: CliContext, options: ApiOptions): Promise<string | null> {
  if (options.token) return options.token;
  if (ctx.env.DOCOPS_TOKEN) return ctx.env.DOCOPS_TOKEN;
  let subject: string | null = null;
  if (ctx.env.ACTIONS_ID_TOKEN_REQUEST_URL && ctx.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    const res = await ctx.fetch(`${ctx.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(ctx.env.DOCOPS_OIDC_AUDIENCE ?? "https://api.docops.example")}`, {
      headers: { authorization: `Bearer ${ctx.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    });
    if (res.ok) subject = ((await res.json()) as { value?: string }).value ?? null;
  } else if (ctx.env.DOCOPS_ID_TOKEN) {
    subject = ctx.env.DOCOPS_ID_TOKEN;
  }
  if (!subject) return null;
  const tenant = options.tenant ?? ctx.env.DOCOPS_TENANT ?? "";
  const res = await ctx.fetch(`${options.apiUrl}/v1/auth/oidc-exchange?tenant=${encodeURIComponent(tenant)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: subject,
    }).toString(),
  });
  if (!res.ok) throw new PlatformError(res.status, `OIDC token exchange failed: HTTP ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export class DocOpsApi {
  private readonly ctx: CliContext;
  readonly apiUrl: string;
  private readonly token: string;

  constructor(ctx: CliContext, apiUrl: string, token: string) {
    this.ctx = ctx;
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.token = token;
  }

  async request<T>(method: string, path: string, body?: unknown, raw?: { data: Uint8Array; contentType: string }): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: "application/json", "user-agent": "docops-cli/0.1" };
    let payload: RequestInit["body"];
    if (raw) {
      headers["content-type"] = raw.contentType;
      payload = raw.data as unknown as RequestInit["body"];
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.ctx.fetch(`${this.apiUrl}${path}`, { method, headers, body: payload });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      throw new PlatformError(0, `cannot reach ${this.apiUrl} (${cause ?? (error as Error).message})`);
    }
    if (!res.ok) {
      const text = await res.text();
      let detail = text.slice(0, 300);
      try {
        detail = (JSON.parse(text) as { title?: string }).title ?? detail;
      } catch {
        // not JSON
      }
      throw new PlatformError(res.status, `${method} ${path} failed (HTTP ${res.status}): ${detail}`);
    }
    if (res.status === 204 || res.headers.get("content-length") === "0") return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
