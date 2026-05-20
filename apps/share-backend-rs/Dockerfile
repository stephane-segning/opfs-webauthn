# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the opfs-share-backend Rust binary
# (ADR 0012). The runtime image is `distroless/cc-debian12:nonroot`
# so the published artifact has no shell, no package manager,
# ~30 MiB total.
#
# Build context MUST be the repo root — the binary is a workspace
# member and needs `Cargo.toml`, `Cargo.lock`, and the sibling
# `crates/crypto` to compile. The GitHub Actions workflow sets
# `context: .` for that reason.
#
# Layer caching is delegated to the workflow's buildx cache
# (`cache-from: type=gha`); cargo-chef was tempting but its current
# release (0.1.77) requires Rust 1.88+ while our workspace MSRV is
# pinned at 1.85, and the prior version (0.1.69) trips on the
# binary+lib target shape we use for testability. The buildx cache
# gets us most of the same wins for a fraction of the moving parts.

ARG RUST_VERSION=1.85
ARG DEBIAN_VERSION=bookworm

# ─── builder ──────────────────────────────────────────────────
FROM rust:${RUST_VERSION}-${DEBIAN_VERSION} AS builder
WORKDIR /app

# Copy the whole workspace. The buildx GHA cache makes this cheap
# on no-op rebuilds; source changes invalidate only the layers
# below this one.
COPY . .

# Build only the share-backend binary. The wasm crates are
# workspace members but irrelevant to this server.
RUN cargo build --release --bin opfs-share-backend

# Strip debug symbols — the distroless image keeps every byte we
# hand it.
RUN strip target/release/opfs-share-backend

# ─── runtime: distroless ──────────────────────────────────────
# `cc` includes libc + libgcc + libssl/libcrypto so we don't have
# to statically link OpenSSL. The Rust binary itself is a single
# file copied in. `nonroot` runs the process as UID 65532.
FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=builder /app/target/release/opfs-share-backend /app/opfs-share-backend

# Knative reads the container port from this annotation; matches
# the binary default + the `PORT` env declared in the manifest.
EXPOSE 8080

# Sensible defaults — the Knative `Service` overrides
# `ALLOWED_ORIGINS` and `TRUSTED_IP_HEADER` at deploy time.
ENV HOST=0.0.0.0 \
    PORT=8080 \
    RUST_LOG=info,opfs_share_backend=debug

ENTRYPOINT ["/app/opfs-share-backend"]
