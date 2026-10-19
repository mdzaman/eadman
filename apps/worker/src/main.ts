import { createPostgresClient, migrate } from "@docops/db";
import { HttpJiraClient } from "@docops/jira";
import { ALL_QUEUES, Worker } from "./worker.ts";

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.DATABASE_URL) {
    // Embedded PGlite allows one process per data directory, so the API runs the worker itself.
    console.error("[docops-worker] DATABASE_URL is not set. With the embedded database the API runs the worker in its own process: start only `npm run api`. Set DATABASE_URL to run workers separately.");
    process.exit(2);
  }
  const db = createPostgresClient(process.env.DATABASE_URL);
  await migrate(db);
  const jira =
    process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN
      ? new HttpJiraClient({ baseUrl: process.env.JIRA_BASE_URL, auth: { type: "basic", email: process.env.JIRA_EMAIL, apiToken: process.env.JIRA_API_TOKEN } })
      : null;
  const queues = (process.env.WORKER_QUEUES ?? ALL_QUEUES.join(",")).split(",").map((q) => q.trim()).filter(Boolean);
  const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("WORKER_CONCURRENCY must be a positive integer");
  const worker = new Worker({
    db,
    queues,
    concurrency,
    workerId: process.env.HOSTNAME ? `worker-${process.env.HOSTNAME}` : undefined,
    publicUrl: (process.env.DOCOPS_PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, ""),
    cell: process.env.DOCOPS_CELL,
    jira: () => jira,
  });
  worker.start(Number(process.env.WORKER_POLL_MS ?? 1000));
  console.log(`[docops-worker] consuming ${queues.join(", ")} (concurrency ${concurrency})`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      worker.stop();
      void db.close().then(() => process.exit(0));
    });
  }
}
