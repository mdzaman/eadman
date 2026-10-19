import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DocOpsError, unauthorized, uuidv7 } from "@docops/core";
import { resolvePrincipal } from "./auth.ts";
import type { AppDeps, Ctx, Env } from "./context.ts";
import { hookRoutes } from "./hooks.ts";
import { routes, type RouteDef } from "./routes.ts";

/** Every route the service implements (used by the OpenAPI contract test). */
export const ALL_ROUTES: readonly RouteDef[] = [...hookRoutes, ...routes];

function honoPath(path: string): string {
  if (path === "/sites/{tenant}/{space}/{environment}/{path}") return "/sites/:tenant/:space/:environment/*";
  return path.replace(/\{(\w+)\}/g, ":$1");
}

function problem(c: Ctx, error: DocOpsError) {
  return c.json(error.toProblem(c.get("requestId")), error.status as 400, { "content-type": "application/problem+json" });
}

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    const incoming = c.req.header("x-request-id");
    c.set("requestId", incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : uuidv7());
    await next();
    c.header("x-request-id", c.get("requestId"));
  });
  const tooLarge = (c: Ctx) => problem(c, new DocOpsError("too_large", "Request body too large", 413));
  app.use("/v1/blobs/*", bodyLimit({ maxSize: deps.config.maxBlobBytes, onError: tooLarge }));
  app.use("/v1/*", async (c, next) => (c.req.path.startsWith("/v1/blobs/") ? next() : bodyLimit({ maxSize: 10 * 1024 * 1024, onError: tooLarge })(c, next)));
  app.use("/hooks/*", bodyLimit({ maxSize: 25 * 1024 * 1024, onError: tooLarge }));

  for (const route of ALL_ROUTES) {
    app.on(route.method, honoPath(route.path), async (c) => {
      if (route.auth === "token") {
        const principal = await resolvePrincipal(deps, c.req.header("authorization"));
        if (!principal) throw unauthorized();
        c.set("principal", principal);
      }
      return route.handler(c);
    });
  }

  app.onError((error, c) => {
    if (error instanceof DocOpsError) return problem(c, error);
    console.error(JSON.stringify({ level: "error", requestId: c.get("requestId"), message: error.message }));
    return problem(c, new DocOpsError("internal", "Internal server error", 500));
  });
  app.notFound((c) => problem(c, new DocOpsError("not_found", "Not found", 404)));
  return app;
}
