# EADMan server image: one image, two roles.
#
#   docker build -f deploy/docker/Dockerfile -t docops/server:local .     (build context = repository root)
#   docker run -p 8787:8787 docops/server:local                           the API (default CMD)
#   docker run docops/server:local node apps/worker/src/main.ts           the worker (command override)
#
# Node 24 runs the TypeScript sources directly (type stripping), so there is no compile step and
# the workspace packages (packages/*, exported as src/index.ts) are copied as they are. Migrations
# live in packages/db/migrations and are applied by the API and the worker when they start.
#
# Air-gapped or mirrored registries: build with --build-arg NODE_IMAGE=registry.internal/library/node:24-slim
# (the same value is used for every stage). Pin the base image by digest in your own pipeline.
ARG NODE_IMAGE=node:24-slim


# ---- 1. manifests: package.json files only, so the dependency layer is rebuilt only when one changes ----
FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
RUN find packages apps -type f ! -name package.json -delete \
 && find packages apps -type d -empty -delete


# ---- 2. build: production dependencies for the whole workspace, then the sources on top ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --from=manifests /src/ ./
# --ignore-scripts: no dependency runs code at install time. Today every runtime dependency is
# plain JavaScript or WebAssembly (pg, @electric-sql/pglite, hono, ...). If one that needs a
# native build is added, build it in this stage instead of dropping the flag.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
# Sources merge into the tree above, so nested workspace node_modules (if npm created any) are kept.
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY api ./api


# ---- 3. runtime ----
FROM ${NODE_IMAGE} AS runtime
ARG VERSION=0.1.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="EADMan server" \
      org.opencontainers.image.description="EADMan API and worker (docs-as-code platform)" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

# NODE_OPTIONS hides Node's one-line "type stripping is experimental" warning from the logs.
# DOCOPS_DATA_DIR / DOCOPS_BLOB_DIR point at the only writable locations, which a deployment
# mounts as volumes; everything else can stay read-only.
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    PORT=8787 \
    HOME=/tmp \
    DOCOPS_DATA_DIR=/var/lib/docops/data \
    DOCOPS_BLOB_DIR=/var/lib/docops/blobs

# A fixed numeric uid/gid so Kubernetes can verify runAsNonRoot and volumes can be chowned to it.
RUN groupadd --system --gid 10001 docops \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin docops \
 && mkdir -p /var/lib/docops/data /var/lib/docops/blobs \
 && chown -R 10001:10001 /var/lib/docops

WORKDIR /app
# Application files stay owned by root and are not writable by the service user.
COPY --from=build /app/ ./

USER 10001:10001
EXPOSE 8787
CMD ["node", "apps/api/src/main.ts"]
