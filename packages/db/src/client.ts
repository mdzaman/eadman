import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import pg from "pg";

/** Minimal SQL surface shared by PGlite (embedded/tests) and node-postgres (production). */
export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** A transaction handle; `exec` runs a multi-statement script (migrations). */
export interface Transaction extends Queryable {
  exec(sql: string): Promise<void>;
}

export interface SqlClient extends Queryable {
  /** Run `fn` in a transaction on a single connection. */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  readonly kind: "pglite" | "postgres";
}

export async function createPgliteClient(dataDir?: string): Promise<SqlClient> {
  const db = await PGlite.create({ dataDir, extensions: { vector } });
  const wrap = (q: { query: PGlite["query"]; exec: PGlite["exec"] }): Transaction => ({
    async query<T>(text: string, params: unknown[] = []) {
      const result = await q.query<T>(text, params);
      return { rows: result.rows };
    },
    async exec(sql: string) {
      await q.exec(sql);
    },
  });
  return {
    kind: "pglite",
    ...wrap(db),
    transaction: (fn) => db.transaction((tx) => fn(wrap(tx))),
    exec: async (sql) => {
      await db.exec(sql);
    },
    close: () => db.close(),
  };
}

export function createPostgresClient(connectionString: string, options: { max?: number } = {}): SqlClient {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  return {
    kind: "postgres",
    async query<T>(text: string, params: unknown[] = []) {
      const result = await pool.query(text, params);
      return { rows: result.rows as T[] };
    },
    async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
      const conn = await pool.connect();
      try {
        await conn.query("BEGIN");
        const result = await fn({
          async query<R>(text: string, params: unknown[] = []) {
            const r = await conn.query(text, params);
            return { rows: r.rows as R[] };
          },
          async exec(sql: string) {
            // No parameters: the simple query protocol, which accepts several statements.
            await conn.query(sql);
          },
        });
        await conn.query("COMMIT");
        return result;
      } catch (error) {
        await conn.query("ROLLBACK");
        throw error;
      } finally {
        conn.release();
      }
    },
    exec: async (sql) => {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}

/** Advisory lock key that serializes migrators across API and worker replicas ("docops" in ASCII; a safe integer). */
export const MIGRATION_LOCK_KEY = 0x646f636f7073;

/**
 * Apply pending migrations in name order; idempotent and safe to call from many processes at once.
 *
 * Everything runs in one transaction that first takes a transaction-scoped advisory lock, so
 * concurrent starts queue behind the first migrator and then find nothing to do. A failing file
 * rolls back every file of the run together with its bookkeeping row. Migrations therefore must
 * not contain statements that cannot run in a transaction (CREATE INDEX CONCURRENTLY).
 */
export async function migrate(client: SqlClient, dir: URL = new URL("../migrations/", import.meta.url)): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  return client.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await tx.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const applied = new Set((await tx.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      await tx.exec(await readFile(new URL(file, dir), "utf8"));
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      ran.push(file);
    }
    return ran;
  });
}

export interface DbOptions {
  /** Role every tenant transaction assumes (no BYPASSRLS). Null when the login role already is it. */
  appRole?: string | null;
}

/**
 * Run `fn` with tenant context: `SET LOCAL ROLE docops_app` + `app.tenant_id`, so row-level
 * security applies even if a query forgets its WHERE clause (docs/03-data-model.md §5).
 */
export async function withTenant<T>(client: SqlClient, tenantId: string, fn: (tx: Queryable) => Promise<T>, options: DbOptions = {}): Promise<T> {
  const role = options.appRole === undefined ? "docops_app" : options.appRole;
  return client.transaction(async (tx) => {
    if (role) await tx.query(`SET LOCAL ROLE ${role}`);
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return fn(tx);
  });
}

/** Platform context (no tenant): only platform tables and SECURITY DEFINER lookups are visible. */
export async function asPlatform<T>(client: SqlClient, fn: (tx: Queryable) => Promise<T>, options: DbOptions = {}): Promise<T> {
  const role = options.appRole === undefined ? "docops_app" : options.appRole;
  return client.transaction(async (tx) => {
    if (role) await tx.query(`SET LOCAL ROLE ${role}`);
    return fn(tx);
  });
}
