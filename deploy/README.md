# Deploying DocOps

Everything needed to run the DocOps services (the API and the queue workers) outside a developer's laptop: a container image, a Docker Compose stack for evaluation, and a Helm chart for Kubernetes.

```text
deploy/
├── docker/
│   ├── Dockerfile                 # one image, two roles: the API (default CMD) and the worker (command override)
│   ├── Dockerfile.dockerignore    # the ignore file BuildKit applies to this Dockerfile (context = repository root)
│   └── .dockerignore              # identical copy, for tools that look for that name; keep the two in sync
├── docker-compose.yml             # Postgres + pgvector, API, worker; optional S3-compatible storage (profile s3)
├── helm/docops/                   # the chart
│   ├── values.yaml                # every setting, documented inline
│   ├── values-airgapped.yaml      # a minimal example for a cluster with no internet access
│   └── templates/                 # api, workers, service, ingress, configmap, secret, hpa, pdb, networkpolicy, ...
└── README.md
```

The chart and the Compose file configure what the services read today and nothing else. AI gateway settings and OpenTelemetry export are in the design but not in the code yet: see [Planned](#planned).

Architecture background: [docs/02-system-architecture.md](../docs/02-system-architecture.md) (§3.3 deployment topology, §8 tenancy and residency), [ADR-0002](../docs/adr/0002-modular-monolith-first.md), [ADR-0006](../docs/adr/0006-tenancy-isolation.md), [docs/08-security-compliance.md](../docs/08-security-compliance.md).

## Deployment modes

| Mode | What it is | How it uses these artifacts |
|---|---|---|
| **Evaluation / local** | One machine, Postgres included | `docker compose` (below). Not for production: well-known database password, a superuser database role. |
| **SaaS cell** | A full, independent stack per region (`us-1`, `eu-1`, `ap-1`); a tenant is pinned to its home cell | One Helm release per cell, rendered by your GitOps tool with `secrets.existingSecret` fed from a secret manager. Set `cell`, the cell's `publicUrl`, its own database and its own bucket (`objectStorage.type: s3`), which lets the API run any number of replicas. Worker groups split by queue. Pooled tenants rely on row-level security (the application role `docops_app`), see the database section. Infrastructure (clusters, databases, buckets, keys) comes from Terraform, outside this repository. |
| **Single-tenant (dedicated)** | One customer on dedicated compute, database, storage and keys | The same chart in a dedicated cluster or namespace, with the customer's database and bucket (or volume), `cell` set to a name for that stack, and `egress.allowedCidrs` for the customer's own systems. Customer-managed keys are an infrastructure concern: they sit under the database and the bucket or volume, not in this chart. |
| **Self-hosted** | The customer runs it on its own Kubernetes | The chart as is. Bring Postgres 17 with pgvector and, to run more than one API replica, an S3-compatible bucket or a ReadWriteMany volume; everything else is in the chart. |
| **Air-gapped** | Self-hosted with no internet access at all | `values-airgapped.yaml` and mirrored images, with egress closed. Offline licensing and local LLM packs are V2 roadmap items ([docs/09](../docs/09-roadmap.md) §4) and are not in this build. |

## The image

Build from the repository root (the build context is the whole monorepo; the Dockerfile copies only what runs):

```bash
docker build -f deploy/docker/Dockerfile -t docops/server:local .
docker run --rm -p 8787:8787 -e DATABASE_URL=postgres://... docops/server:local          # the API
docker run --rm -e DATABASE_URL=postgres://... docops/server:local node apps/worker/src/main.ts   # a worker
```

- **Base image:** `node:24-slim` (the tag exists on Docker Hub, checked on 2026-10-18). Node 24 runs the TypeScript sources directly, so there is no compile step and the workspace packages are copied as they are. Pass `--build-arg NODE_IMAGE=registry.internal.example/library/node:24-slim` to build from a mirror. Pin by digest in your own pipeline.
- **Stages:** a manifest-only stage keeps the dependency layer cached until a `package.json` changes; `npm ci --omit=dev --ignore-scripts` installs production dependencies for the whole workspace; the final stage copies the result. `--ignore-scripts` is safe today because every runtime dependency is plain JavaScript or WebAssembly; if one that needs a native build is added, build it in the build stage.
- **Runtime:** `NODE_ENV=production`, a fixed numeric user and group `10001` (so Kubernetes can verify `runAsNonRoot`), application files owned by root and not writable, and two writable locations that deployments mount as volumes: `/var/lib/docops/data` and `/var/lib/docops/blobs` (the second only for blobs on the filesystem, not with S3).
- **Ignore file:** the context is the repository root, so Docker would look for `.dockerignore` there. BuildKit applies `deploy/docker/Dockerfile.dockerignore` instead, because a file named after the Dockerfile and placed next to it takes precedence ([Docker docs](https://docs.docker.com/build/concepts/context/)). The plain `.dockerignore` next to it is a copy for other tools.
- **Not done yet:** images are not signed or scanned in this repository, and the image is `node:24-slim` rather than distroless. A distroless Node 24 image exists (`gcr.io/distroless/nodejs24-debian13`, with the `latest`, `nonroot`, `debug` and `debug-nonroot` tags, per the distroless project README); its entrypoint is already `node`, so the commands change to `apps/api/src/main.ts` and `apps/worker/src/main.ts`. That variant was not built or tested.

### Configuration

All configuration is environment variables. These are the ones the services read today.

| Variable | Used by | Default | Notes |
|---|---|---|---|
| `PORT` | API | `8787` | Health check: `GET /healthz` |
| `DATABASE_URL` | API, worker | none | A `postgres://` URL. If unset the API and worker use embedded PGlite under `DOCOPS_DATA_DIR` (single process, development only) |
| `DOCOPS_DATA_DIR` | API, worker | `.docops/data` | `/var/lib/docops/data` in the image |
| `DOCOPS_BLOB_DIR` | API | `${DOCOPS_DATA_DIR}/blobs` | `/var/lib/docops/blobs` in the image. Where blobs go when `DOCOPS_S3_BUCKET` is not set |
| `DOCOPS_S3_BUCKET` | API | none | When set, blobs go to this S3-compatible bucket instead of `DOCOPS_BLOB_DIR`, so any number of API replicas can share them. The bucket must exist. See [Storage](#storage) |
| `DOCOPS_S3_REGION` | API | `us-east-1` | The region in the request signature (SigV4) and in the default endpoint |
| `DOCOPS_S3_ENDPOINT` | API | `https://s3.<region>.amazonaws.com` | The service URL without the bucket, for example `http://minio:9000`. No path, query or credentials |
| `DOCOPS_S3_FORCE_PATH_STYLE` | API | `false` | `true`: `<endpoint>/<bucket>/<key>` instead of `<bucket>.<endpoint>/<key>`, which most self-hosted services need. A bucket name with dots or an IP endpoint always uses paths |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | API | none | The S3 access key, read once at start. The first two are required with `DOCOPS_S3_BUCKET` (the API refuses to start without them); the session token is for temporary credentials |
| `DOCOPS_BOOTSTRAP_TOKEN` | API | none | Creates a tenant and an admin token on first start. Must be `dop_` followed by at least 20 letters or digits, otherwise the API logs an error and skips the bootstrap. Also `DOCOPS_BOOTSTRAP_TENANT` (default `acme`) |
| `DOCOPS_TOKEN_SIGNING_SECRET`, `DOCOPS_PREVIEW_SECRET` | API | random per start | **Every replica must share them**, or tokens and preview links fail on the replica that did not issue them. The chart generates them unless you supply a Secret |
| `DOCOPS_SIGNING_KEY_PEM` | API | an ephemeral key per start (logged as a warning) | The Ed25519 private key (PKCS#8 PEM) that signs builds. A signer verifies only signatures made with its own key, so **every replica must share it**, and a restart needs the same one: with separate or ephemeral keys, a build finalized on one replica cannot be promoted by another or after a restart. The chart generates one; otherwise create it with `openssl genpkey -algorithm ed25519` |
| `GITHUB_WEBHOOK_SECRET`, `JIRA_WEBHOOK_SECRET` | API | none | Webhook HMAC secrets |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | API, worker | none | All three are needed to enable the Jira client |
| `DOCOPS_CELL` | API, worker | `local` | Region cell name, for example `us-1` |
| `DOCOPS_PUBLIC_URL` | API, worker | `http://localhost:8787` | External base URL |
| `WORKER_QUEUES` | worker | every queue | Comma list: `tracker.link`, `tracker.mirror`, `tracker.sync`, `notify.webhooks`, `content.index`. **Never set it to an empty string**: that means "no queues" |
| `WORKER_CONCURRENCY` | worker | `4` | Jobs processed in parallel by one worker process. Must be a positive integer, otherwise the worker exits at start (the chart refuses to render a bad value). `WORKER_POLL_MS` (default `1000`) is also read |
| `DOCOPS_OIDC_AUDIENCE`, `DOCOPS_CI_TRUST_POLICIES` | API | | CI workload identity (JSON policies) |
| `DOCOPS_FORGE_APP_ID` | API | none | The Jira Forge app's ARI (`app.id` in its `manifest.yml`, `ari:cloud:ecosystem::app/<uuid>`): the audience its Forge Invocation Tokens must carry. Unset, the API refuses them. The API fetches Atlassian's signing keys from `forge.cdn.prod.atlassian-dev.net`, so it needs internet egress. Each Jira site must also be routed to its tenant, for now with SQL: `INSERT INTO tenant_routes (kind, external_key, tenant_id) SELECT 'forge_installation', '<installation ID shown on the admin page>', id FROM tenants WHERE slug = '<tenant>'` |

## Docker Compose (evaluation)

```bash
export DOCOPS_BOOTSTRAP_TOKEN="dop_$(openssl rand -hex 20)"    # there is no default admin token
docker compose -f deploy/docker-compose.yml up --build
curl http://localhost:8787/healthz
```

- The token is required by Compose (`${DOCOPS_BOOTSTRAP_TOKEN:?...}`), so every `docker compose` command that reads the file needs it, `down` and `logs` included. Keep it in `deploy/.env` (git-ignored) to avoid exporting it each time: `echo "DOCOPS_BOOTSTRAP_TOKEN=dop_$(openssl rand -hex 20)" > deploy/.env`. Send it as `Authorization: Bearer $DOCOPS_BOOTSTRAP_TOKEN`.
- The signing secrets have no defaults either: the API generates random ones on every start (and says so), so tokens and preview links do not survive a restart. For stable ones add `DOCOPS_TOKEN_SIGNING_SECRET` and `DOCOPS_PREVIEW_SECRET` (for example `openssl rand -hex 32`) to `deploy/.env`.
- **Build-signing key (optional).** Without `DOCOPS_SIGNING_KEY_PEM` the API creates a new Ed25519 key on every start and logs a warning, so a build finalized before a restart cannot be promoted after it. To keep builds promotable, create one and keep it with the token: `export DOCOPS_SIGNING_KEY_PEM="$(openssl genpkey -algorithm ed25519)"`, or put it in `deploy/.env` as a quoted multi-line value: `printf 'DOCOPS_SIGNING_KEY_PEM="%s"\n' "$(openssl genpkey -algorithm ed25519)" >> deploy/.env`.
- Optional settings (`GITHUB_WEBHOOK_SECRET`, `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `WORKER_QUEUES`, `WORKER_CONCURRENCY`, ...) go in `deploy/.env.docops`, one `VAR=value` per line, no quotes and no empty values. Both services read it.
- **S3-compatible storage (optional).** The `s3` profile keeps the blobs in a bucket instead of the `docops-blobs` volume, the way several API replicas would. Put both lines in `deploy/.env`: `COMPOSE_PROFILES=s3` and `DOCOPS_S3_BUCKET=docops-blobs`. The profile runs SeaweedFS (`chrislusf/seaweedfs:4.48`, Apache-2.0) in its single-container `weed mini` mode. It creates the bucket when it starts, and the API waits until its S3 port is healthy.
  - **Why not MinIO:** the upstream images are no longer published. `minio/minio` is gone from Docker Hub (the API answers 404), the [repository](https://github.com/minio/minio) is archived, and its README says the community edition is now distributed as source code only. Among the maintained S3 servers, SeaweedFS creates a bucket from an environment variable (`S3_BUCKET`), checks SigV4 signatures once an access key is set, runs as a non-root user and publishes versioned multi-architecture images. The runner-up, Versity S3 Gateway (`versity/versitygw`), runs as root and needs the bucket created beforehand.
  - **Access key:** `DOCOPS_S3_ACCESS_KEY_ID` and `DOCOPS_S3_SECRET_ACCESS_KEY` on the host (defaults `docops` and `docops-evaluation-secret`, well-known like the database password and acceptable for the same reason). Compose hands them to both services as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; the host names differ so that an AWS key in your shell never reaches the containers.
  - **Safety:** `weed mini` also runs a master, a volume server and a filer whose HTTP APIs have no authentication. They are reachable only inside the Compose network: never publish them. The service runs as uid 1000 with no capabilities and `no-new-privileges`, with WebDAV, the admin UI and SeaweedFS's default anonymous usage statistics turned off. Its root filesystem is not read-only, because that was not tested.
  - **Another service, or AWS:** leave the profile out and set `DOCOPS_S3_BUCKET`, `DOCOPS_S3_ENDPOINT` (for AWS, `https://s3.<region>.amazonaws.com`), `DOCOPS_S3_REGION`, `DOCOPS_S3_FORCE_PATH_STYLE` (`false` for AWS) and the access key. With `DOCOPS_S3_BUCKET` set but neither the profile nor an endpoint, the API points at `http://s3:8333`, which does not exist, and uploads fail.
- The API publishes `127.0.0.1:8787` only. The DocOps services run with a read-only root filesystem, no capabilities and `no-new-privileges`; `/tmp` is a tmpfs and blobs live in a named volume (or in the `s3` service's).
- The Compose database user is a superuser. DocOps still switches to the `docops_app` role inside every tenant transaction, so row-level security applies, but do not use this stack to judge production database privileges.

## Kubernetes with Helm

Requirements: Helm 3, Kubernetes 1.25 or later, and **PostgreSQL 17 or later with pgvector**, which is not part of the chart. To run more than one API replica you also need shared blob storage: an **S3-compatible bucket** or a **ReadWriteMany** PersistentVolumeClaim (see [Storage](#storage)).

### 1. Prepare the database

The first start runs `packages/db/migrations/0001_init.sql` as the user in `DATABASE_URL`. That migration creates the `vector` extension and a `docops_app` role (no login, no `BYPASSRLS`) that every tenant transaction switches to with `SET LOCAL ROLE`. A database administrator should therefore prepare the database once; the migration skips what already exists:

```sql
CREATE DATABASE docops OWNER docops;           -- the login role used in DATABASE_URL owns the database
\c docops
CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE docops_app NOLOGIN;
GRANT docops_app TO docops;                    -- SET ROLE needs membership
```

The owner is needed because, from PostgreSQL 15, only the database owner may create objects in the `public` schema by default. On managed Postgres where the extension needs a privileged role, create it there.

### 2. Create the Secrets

```bash
kubectl create namespace docops
kubectl -n docops create secret generic docops-database \
  --from-literal=DATABASE_URL='postgres://docops:PASSWORD@HOST:5432/docops?sslmode=require'
```

Optionally bring your own Secret for everything else (recommended; it is what GitOps needs) and name it in `secrets.existingSecret`. For example:

```bash
kubectl -n docops create secret generic docops-secrets \
  --from-literal=DOCOPS_TOKEN_SIGNING_SECRET="$(openssl rand -hex 32)" \
  --from-literal=DOCOPS_PREVIEW_SECRET="$(openssl rand -hex 32)" \
  --from-literal=DOCOPS_SIGNING_KEY_PEM="$(openssl genpkey -algorithm ed25519)" \
  --from-literal=DOCOPS_BOOTSTRAP_TOKEN="dop_$(openssl rand -hex 20)"
```

| Key | Purpose |
|---|---|
| `DOCOPS_TOKEN_SIGNING_SECRET`, `DOCOPS_PREVIEW_SECRET` | Shared by all API replicas. Rotating them invalidates issued tokens and preview links |
| `DOCOPS_SIGNING_KEY_PEM` | The Ed25519 private key that signs builds. **Every API replica must share it**: a signer verifies only signatures made with its own key, so a build finalized on one replica could not be promoted by another, or by the same pod after a restart. Create it with `openssl genpkey -algorithm ed25519`. In production a KMS-backed key is planned, see docs/08 T07 |
| `DOCOPS_BOOTSTRAP_TOKEN` | The first admin token (see the table above). Remove it once real tokens exist |
| `GITHUB_WEBHOOK_SECRET`, `JIRA_WEBHOOK_SECRET` | Webhook verification |
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | Jira client |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | The S3 access key, with `objectStorage.type: s3`. It can live in this Secret or in its own (`objectStorage.s3.credentials.existingSecret`, with configurable key names); see [Storage](#storage) |

The chart reads every key as optional, except the S3 access key ID and secret when `objectStorage.type` is `s3`: without them the API pod does not start, and Kubernetes reports the missing key. A key you leave out is not set, and for the two signing secrets and the signing key the API then generates an ephemeral value on each start (and logs a warning), which breaks tokens, preview links and build promotion across replicas and restarts: include all three.

Without `secrets.existingSecret` the chart creates a Secret that generates the two signing secrets and an Ed25519 build-signing key (`genPrivateKey "ed25519"`, which writes a PKCS#8 PEM) once, and keeps them across upgrades by reading the old Secret back with `lookup`. `lookup` finds nothing under `helm template` or an offline GitOps render, where new values would be generated on every render; use `secrets.existingSecret` there. `genPrivateKey "ed25519"` needs Sprig 3.2.0 (December 2020) or later; Helm 3's development branch requires Sprig 3.3.0.

### 3. Install

```bash
helm install docops deploy/helm/docops -n docops --set database.existingSecret=docops-database
# or, air-gapped:
helm install docops deploy/helm/docops -n docops -f deploy/helm/docops/values-airgapped.yaml
```

The install prints what is still missing (`NOTES.txt`). To check a configuration without installing, run `helm lint` and `helm template` with the same values. The defaults are one API replica and two workers.

### What the chart creates

| Object | Notes |
|---|---|
| API `Deployment`, `Service`, optional `Ingress` | One replica by default. Probes on `/healthz`: a generous startup probe (the first start applies migrations), then readiness and liveness. Port name `http`. The update strategy comes from `api.strategy` |
| Worker `Deployment`s, one per entry of `worker.groups` | Same image, `node apps/worker/src/main.ts`. Each group sets `queues`, and may override `replicaCount`, `concurrency` and `resources`. The commented example in `values.yaml` splits the tracker queues from content indexing |
| `HorizontalPodAutoscaler`s | Off by default. API and each worker group, on CPU (and memory if set). API autoscaling needs shared blob storage (see Storage). For scaling workers on queue lag use KEDA instead (docs/02 §3.3) |
| `PodDisruptionBudget`s | Only when more than one replica is possible, since `minAvailable: 1` on a single replica would block node drains |
| `NetworkPolicy`s | Default-deny **egress** for every DocOps pod, and with S3 a second policy that lets the API pods reach the bucket's endpoint; see below |
| `ConfigMap`, `Secret`, `ServiceAccount` | The ConfigMap carries non-secret settings (a checksum annotation rolls the pods when it changes); the ServiceAccount mounts no API token |

Pods run as user 10001 with `runAsNonRoot`, `RuntimeDefault` seccomp, no privilege escalation, all capabilities dropped and a **read-only root filesystem**; the writable paths are `/tmp`, the data directory and, with blobs on the filesystem, the blob directory.

### Network policy and egress

With `networkPolicy.enabled` (the default) the pods may talk only to: cluster DNS, the database (`database.egress`) and `egress.allowedCidrs`. The database takes a list of NetworkPolicy peers (`ipBlock`, `podSelector`, `namespaceSelector`) and ports; an empty list means "pods in this release's namespace", which fits an in-namespace Postgres. `egress.allowInternet: true` additionally opens the public internet while keeping private ranges (`egress.internetExceptCidrs`) and the cloud metadata address blocked. Jira Cloud and GitHub need it, and so does the Jira Forge app, because the API fetches Atlassian's token-signing keys. Ingress is not restricted by the chart.

With `objectStorage.type: s3`, list where the S3 endpoint is in `objectStorage.s3.egress` (peers and ports, as for the database): the chart then adds a policy that lets only the API pods reach it, since the workers use no blob storage. The list starts empty, because no default fits both AWS and an in-cluster service, and an empty list adds no rule (in a NetworkPolicy an empty `to:` would mean every destination). With it empty, the endpoint must be reachable through another rule: `egress.allowInternet` covers AWS's public S3 endpoints, `egress.allowedCidrs` an address range. For AWS without internet egress, use an S3 interface VPC endpoint and list its subnet; the install notes point out an empty list.

If pods cannot resolve names, check `networkPolicy.dns` (OpenShift and NodeLocal DNS differ; see `extraPeers`).

### Storage

The API keeps uploaded builds (content-addressed blobs) and CI snapshots (small JSON documents) in one of two places, chosen by `objectStorage.type`; the workers use no blob storage. Manifests, signatures and everything else live in Postgres.

**`s3`: an S3-compatible bucket** (AWS S3, MinIO, Ceph RGW, ...). Every API replica reads and writes the same bucket, so `api.replicaCount` and autoscaling are free and no volume is mounted.

- Set `objectStorage.s3.bucket` (the render fails without it), and for anything other than AWS the `endpoint`, usually with `forcePathStyle: true`. `region` goes into the request signature (`us-east-1` suits most S3-compatible services). These become `DOCOPS_S3_*` in the ConfigMap.
- **The bucket must exist**; the API does not create it. Keep it private: the API serves every site and preview itself, so nothing needs public or presigned access.
- **Access key.** `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (and optionally `AWS_SESSION_TOKEN`) come from `objectStorage.s3.credentials.existingSecret`, or from the chart's Secret when that is empty. The key needs `s3:GetObject` and `s3:PutObject` on `arn:aws:s3:::<bucket>/*` and **`s3:ListBucket` on the bucket**: without `ListBucket`, S3 answers a missing object with 403 rather than 404, which the API reports as an error instead of "not found".
- **Static keys only.** The API signs requests itself (AWS Signature Version 4 over `fetch`, no SDK) and reads the key once at start. It does not implement IAM roles for service accounts, EKS Pod Identity or instance profiles, and it does not refresh temporary credentials: a pod given an `AWS_SESSION_TOKEN` must be restarted before the token expires. See [Planned](#planned).
- **Layout.** Objects are named like the files under `DOCOPS_BLOB_DIR`: `cas/<tenant>/<first two hex digits>/<sha256>` for blobs and `json/<key>.json` for snapshots. To move an existing install from a volume to a bucket, copy the directory as it is (for example `aws s3 sync /var/lib/docops/blobs s3://<bucket>`) before switching `objectStorage.type`.
- Each upload is sent with its SHA-256 as the signed payload hash (`x-amz-content-sha256`), so S3 refuses a body that was altered on the way. Requests time out after 60 seconds. Network errors, timeouts and answers 429, 500, 502, 503 and 504 are retried twice with backoff; any other error fails the API request (500) and is logged.
- Encryption at rest, versioning, replication and lifecycle rules are bucket settings, outside the chart. Do not expire objects: a deployed site needs every blob its build lists.

**`filesystem`** (the default): `DOCOPS_BLOB_DIR` on a volume. `objectStorage.filesystem.existingClaim` mounts a PersistentVolumeClaim there. With none, the chart uses an `emptyDir`, so **blobs are lost when the pod restarts**: that is for evaluation only.

- **More than one API replica** (`api.replicaCount` above 1, or `api.autoscaling.enabled`) needs the claim, and it must be **ReadWriteMany**, because every replica must see the same blobs. The render fails with an explanation while `existingClaim` is empty (with `objectStorage.type: s3` there is no such check, since the bucket is shared).
- **One replica on a ReadWriteOnce claim:** a rolling update cannot attach the claim to the new pod while the old one still holds it, so set `api.strategy.type=Recreate` and `api.strategy.rollingUpdate=null` (`values-airgapped.yaml` does). The install notes remind you.

### Upgrades and migrations

- **Migrations run when the API or a worker starts** (`migrate()` in `@docops/db` applies the files of `packages/db/migrations` that `schema_migrations` does not list yet). All pending files run in one transaction behind a PostgreSQL advisory lock, so pods that start together queue up behind the first one and then find nothing to do, and a failing file rolls the whole run back. Migrations must not use `CREATE INDEX CONCURRENTLY`, because they run inside that transaction.
- The data model policy is expand, migrate, contract, so the previous version keeps working against a newly migrated schema (docs/03 §6). `helm rollback` rolls the pods back; migrations are not undone.
- The default rolling update keeps `maxUnavailable: 0` (see Storage for the ReadWriteOnce exception). Pods pick up ConfigMap changes through the checksum annotation, and Secret changes on the next restart (`kubectl rollout restart`).
- Use `image.digest` for immutable deployments; `image.tag` defaults to the chart's `appVersion`.

## Air-gapped installs

Nothing in the chart reaches the internet by itself. What you provide:

1. **Mirror the image.** On a connected machine: build or pull `docops/server`, then `docker save`, carry the archive across, `docker load` and push it to your internal registry. Set `global.imageRegistry` (it overrides `image.registry` for every image the chart uses) and `global.imagePullSecrets`; prefer `image.digest` over the tag. Mirror the base image too if you build inside the network (`--build-arg NODE_IMAGE=...`). Build dependencies come from an internal npm registry or a vendored `node_modules` (`npm ci` needs a registry).
2. **Keep egress closed.** `egress.allowInternet: false` stays; list your internal GitHub Enterprise Server or Jira Data Center networks in `egress.allowedCidrs`.
3. **Keep the blobs inside the network:** on a volume in the cluster (`objectStorage.filesystem.existingClaim`; with a ReadWriteOnce claim and one API replica, use the `Recreate` strategy, as the example file does), or in an S3-compatible service you run there (`objectStorage.type: s3` with its `endpoint` and `egress` peers; the example file shows it in a comment), which also allows several API replicas.
4. **The rest is not in this build.** Local LLM packs (an OpenAI-compatible model server and a Text Embeddings Inference server) and offline licensing are V2 roadmap items (docs/09 §4), so there is nothing to configure for them yet: see [Planned](#planned). The CLI already works offline in CI (`docops check --offline`, docs/05).

[`helm/docops/values-airgapped.yaml`](helm/docops/values-airgapped.yaml) is a complete minimal example: internal registry, internal Postgres, blobs on a claim with the `Recreate` strategy, closed egress, and the Secrets it expects.

## Planned

Each item below is in the design, but the services do not read any setting for it yet. That is why the chart and the Compose file have no values or variables for them: they would configure nothing. The scaffold's own list of cuts is [docs/10-mvp-scaffold.md §6](../docs/10-mvp-scaffold.md#6-known-limitations-of-the-scaffold).

- **Workload identity for S3, and a CDN.** The API reads a static S3 access key from the environment. IAM roles for service accounts (a web identity token exchanged with STS), EKS Pod Identity, instance profiles and the refresh of temporary credentials are not implemented; `@aws-sdk/client-s3` and its credential providers would bring them, at the cost of a large dependency tree. Sites and previews are served by the API from the bucket; the design puts a CDN with edge authorization in front (docs/10 §6, Storage row).
- **AI gateway settings.** The providers (Anthropic, an `openai-compatible` adapter for vLLM, TGI or Ollama, a mock, and an embeddings client) exist as a library in `packages/ai`, but neither the API nor the worker imports it: nothing in the services calls a model, and they read no AI configuration from the environment. When it does, this chart gains the provider, the in-network OpenAI-compatible endpoint, a Hugging Face Text Embeddings Inference server for embeddings (BGE-M3 in the design, docs/07 §5.2) and the matching egress rules.
- **OTLP export.** Nothing exports OpenTelemetry data yet, so `OTEL_EXPORTER_OTLP_ENDPOINT` has no effect. The design has OpenTelemetry in every deployable and an OTel Collector config in the Helm chart (docs/02 §11).

## What was verified, and what was not

- `docker compose -f deploy/docker-compose.yml config` validates with a generated `DOCOPS_BOOTSTRAP_TOKEN` and fails with the intended message without it. A multi-line `DOCOPS_SIGNING_KEY_PEM`, from the environment and from `deploy/.env`, reaches the container environment intact. Nothing was started.
- The Dockerfile was **not built** (no containers were built or started). The ignore file was checked with a script that mimics Docker's rules: the files the Dockerfile copies reach the build context and nothing from `docs/`, `examples/`, tests or `node_modules` does.
- **Helm is not installed on the machine where this was written, so `helm lint` and `helm template` were not run.** Instead the chart was rendered with a purpose-built Go-template interpreter limited to the constructs and Sprig functions the chart uses (it fails on anything else). 68 checks passed on the default values, the air-gapped values and a large combined set of values (mirror registry, ingress with TLS, autoscaling with a shared claim, worker groups, extra egress). They cover names, label and selector agreement between Deployments, Services, PDBs, HPAs and the NetworkPolicy, probes, security contexts, environment variables (none empty), secret wiring, the egress rules, the render-time failures (several API replicas or autoscaling without a claim, a worker concurrency that is not a positive integer) and that the generated Secret, signing key included, survives an upgrade (the old Secret was fed back through a stand-in for `lookup`). Renders also passed with missing-key errors enabled, as `helm lint --strict` would. 20 deliberately broken copies of the chart were each caught.
- **The build-signing key.** The API's own `BuildSigner` accepted a PEM from `openssl genpkey -algorithm ed25519` with its trailing newline removed (what `$(...)` leaves): a second instance loaded with the same PEM verified the first one's signatures, and an instance with an ephemeral key did not. Sprig's `genPrivateKey "ed25519"` was not run: per Sprig's [crypto documentation](https://masterminds.github.io/sprig/crypto.html) it accepts `ed25519`, and per its `crypto.go` it writes a PKCS#8 `PRIVATE KEY` block, which is the format `createPrivateKey` takes. The renderer's stand-in produced the same format with Node.
- This is a strong check but not Helm itself: run `helm lint deploy/helm/docops --set database.existingSecret=x`, the same with `-f deploy/helm/docops/values-airgapped.yaml` and with `--set objectStorage.type=s3 --set objectStorage.s3.bucket=x`, and `helm template ... | kubeconform` once before first use.
- **S3 object storage (added 2026-10-19).** The signer reproduces the four worked examples of AWS's [S3 SigV4 documentation](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html) exactly: canonical request, string to sign, signature and `Authorization` header. `put`, `get`, `putJson` and `getJson` round-trip through an in-process fake S3 server that checks every signature with its own implementation, path-style and virtual-hosted, with a session token, retries and S3 error codes. Two API instances that share only the database and the bucket serve each other's builds and snapshots (`apps/api/test/s3.test.ts`). No real S3 service was contacted, neither AWS nor SeaweedFS.
- **The chart's S3 additions** were rendered with a stand-in renderer written for this change, because the interpreter mentioned above was not available. It implements the template syntax and the Sprig functions the chart uses, fails on anything else, and reads numbers from values as float64, as Helm does. 514 checks passed on the default, air-gapped and three S3 value sets, each rendered twice: once as usual and once with missing-key errors enabled. They cover the ConfigMap's `DOCOPS_S3_*` keys, the required access key and optional session token from the right Secret and key names, no blob volume with S3, no credentials in the workers, the API-only egress policy (never with an empty `to:`), the install notes, and the render-time failures: an unknown `objectStorage.type`, a missing bucket, and several filesystem replicas without a claim. 12 deliberately broken copies of the chart were each caught. Helm itself has still not been run.
- **The Compose `s3` profile.** `docker compose ... config` validates with and without the profile, and with `COMPOSE_PROFILES=s3` and `DOCOPS_S3_BUCKET` set. The resolved configuration gives the API the bucket, the endpoint and the key, and the API's dependency on `s3` is ignored without the profile. The SeaweedFS service was **not started** and its image was not pulled. The flags, the `S3_BUCKET` bucket creation, the `AWS_*` admin identity, the signature check and `/healthz` were read in the 4.48 sources (`weed/command/mini.go`, `weed/s3api/auth_credentials.go`, `weed/s3api/s3api_server.go` and `docker/entrypoint.sh`). Running it as `1000:1000` from the start relies on Docker copying the image's `/data` ownership into a new named volume.
- Image tags checked on Docker Hub on 2026-10-18: `node:24-slim` and `pgvector/pgvector:pg17`; on 2026-10-19: `chrislusf/seaweedfs:4.48` (pushed 2026-09-28; amd64, arm64, 386 and arm).
