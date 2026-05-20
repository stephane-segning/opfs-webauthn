# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the opfs-web Next.js static export
# (ADR 0013). The runtime image is `nginxinc/nginx-unprivileged`
# so the published artifact runs as a non-root user out of the
# box and serves on :8080 — matches the Knative `containerPort`
# without root capabilities.
#
# Build context MUST be the repo root — the frontend is part of
# a pnpm + cargo workspace and needs the sibling crates / packages
# to produce the WASM artifact and bundle the Next app. The
# GitHub Actions workflow sets `context: .` for that reason.

ARG RUST_VERSION=1.85
ARG NODE_VERSION=20
ARG NGINX_VERSION=1.27-alpine
ARG PNPM_VERSION=10.33.0
ARG WASM_PACK_VERSION=0.13.1

# ─── stage 1: build the WASM artifact ─────────────────────────
# We pin wasm-pack so the dist bytes ArgoCD signs are
# reproducible across runs.
FROM rust:${RUST_VERSION}-bookworm AS wasm
ARG WASM_PACK_VERSION
WORKDIR /app
RUN cargo install wasm-pack --locked --version ${WASM_PACK_VERSION}
COPY . .
RUN wasm-pack build crates/core \
      --target web \
      --out-dir /app/packages/core-wasm/dist \
      --out-name opfs_core \
      --release

# ─── stage 2: build the Next.js static export ─────────────────
FROM node:${NODE_VERSION}-bookworm AS frontend
ARG PNPM_VERSION
# `CI=true` makes pnpm non-interactive — without it the install
# step aborts with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`
# when it wants to clean a stale `node_modules` directory.
ENV CI=true
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY . .
COPY --from=wasm /app/packages/core-wasm/dist /app/packages/core-wasm/dist
RUN pnpm install --frozen-lockfile
# `NEXT_OUTPUT_EXPORT=1` switches `apps/web/next.config.js` to
# `output: "export"`. The output lands in `apps/web/out/`.
RUN NEXT_OUTPUT_EXPORT=1 pnpm --filter @opfs/web build

# ─── stage 3: nginx runtime ───────────────────────────────────
# `nginx-unprivileged` listens on :8080 by default and runs as
# UID 101 — no root capabilities, no chmod gymnastics needed.
FROM nginxinc/nginx-unprivileged:${NGINX_VERSION} AS runtime
COPY apps/web/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend /app/apps/web/out /usr/share/nginx/html
EXPOSE 8080

# nginx itself is the entrypoint via the base image's CMD; no
# `ENTRYPOINT` override needed.
