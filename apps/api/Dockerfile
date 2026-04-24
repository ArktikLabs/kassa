# syntax=docker/dockerfile:1.9

# Multi-stage image for @kassa/api.
#
# Build context: contents of the `api-dist` CI artifact (see .github/workflows/ci.yml),
# unpacked at the repo-root layout:
#
#   pnpm-lock.yaml
#   pnpm-workspace.yaml
#   package.json                 (workspace root; Biome devDep only)
#   apps/api/{package.json,dist/,Dockerfile,fly.toml}
#   packages/payments/{package.json,dist/}
#   packages/schemas/{package.json,dist/}
#
# fly.toml selects the process (web | worker) by overriding CMD.

ARG NODE_VERSION=22.11.0
ARG PNPM_VERSION=9.12.0

# ─── deps ───────────────────────────────────────────────────────────────────
# Build stage: installs production dependencies inside the target image so the
# native `argon2` addon is compiled against the runtime libc/glibc/Node ABI.
FROM node:${NODE_VERSION}-bookworm-slim AS deps
ARG PNPM_VERSION

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /build

# Manifests first so pnpm install is cacheable when only dist/ changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/payments/package.json ./packages/payments/package.json
COPY packages/schemas/package.json ./packages/schemas/package.json

# --prod skips devDependencies; --frozen-lockfile fails on drift.
# Install scripts run by default, which lets argon2's node-gyp rebuild fire.
RUN pnpm install --prod --frozen-lockfile

# Drop compiled JS into the workspace. node_modules already points into these.
COPY apps/api/dist ./apps/api/dist
COPY packages/payments/dist ./packages/payments/dist
COPY packages/schemas/dist ./packages/schemas/dist

# ─── runtime ────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    NODE_OPTIONS=--enable-source-maps

# Non-root runtime.
RUN groupadd --system --gid 1001 kassa \
    && useradd --system --uid 1001 --gid kassa --home /app --shell /usr/sbin/nologin kassa

WORKDIR /app
COPY --from=deps --chown=kassa:kassa /build /app

USER kassa
EXPOSE 8080

# Default to the web process; fly.toml overrides with the worker command for
# the `worker` process group.
CMD ["node", "apps/api/dist/index.js"]
