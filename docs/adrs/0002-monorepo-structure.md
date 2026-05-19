# ADR 0002 — Monorepo structure

- **Status**: Accepted
- **Date**: 2026-05-19

## Context

The project is intentionally split into reusable pieces (a Rust crypto
crate, a Rust storage/repository crate compiled to WASM, a UI design-tokens
package, a UI components package, a Next.js app, and a small sharing
backend). The components need to share types and build artifacts, but each
should also be liftable into another project without dragging the whole
repo along.

We have both Rust and TypeScript code, and we want a single CI pipeline.

## Decision

A single repository that contains both a **pnpm workspaces** root for JS/TS
packages and a **Cargo workspace** for Rust crates.

```
.
├── apps/
│   ├── web/                 Next.js app, static-exported, deployed to gh-pages
│   └── share-backend/       small server for the cross-device share endpoint
├── packages/
│   ├── ui/                  React components (headless + styled)
│   ├── design-tokens/       CSS variables, Tailwind preset
│   ├── core-wasm/           generated wasm-bindgen JS wrapper (built artifact + types)
│   ├── auth/                JS-side WebAuthn helpers (PRF orchestration)
│   ├── storage/             JS-side OPFS / SQLite-wasm orchestration
│   └── state/               shared Zustand stores
├── crates/
│   ├── core/                top-level Rust crate compiled to WASM
│   ├── crypto/              AES-GCM, HKDF, key wrapping
│   ├── repo/                SQL repository layer, schema, migrations
│   └── share-protocol/      typed protocol for the share flow
└── docs/
    ├── prd/
    └── adrs/
```

Tooling choices:

- **pnpm** as the JS package manager (already in use).
- **Turborepo** for JS task orchestration and caching.
- **Cargo workspace** at the repo root for Rust.
- **wasm-pack** + a custom Turbo task to build `crates/core` into
  `packages/core-wasm/dist`.
- **Biome** for JS/TS lint+format (already in use).
- **rustfmt** + **clippy** with `-D warnings` in CI.

## Consequences

- Every `packages/*` and `crates/*` can be published independently. Their
  README must include "this package is part of opfs-webauthn but is usable
  standalone" instructions.
- Cross-language type sharing happens through generated TypeScript types
  emitted by `wasm-bindgen` plus a small handwritten layer in
  `packages/auth` and `packages/storage`. We do not adopt a heavyweight
  IDL.
- Apps consume the WASM bundle through `packages/core-wasm`, never
  directly from `crates/`. That gives us one place to evolve the JS API
  surface.
- Turbo pipeline must understand that `apps/web` depends on
  `packages/core-wasm`, which depends on a wasm-pack build. We will
  encode this explicitly in `turbo.json`.

## Alternatives considered

- **Nx** instead of Turborepo: heavier, more generators, more
  opinionated. Turbo is enough for our scale.
- **Separate repos** per package: would slow research; we trade publish
  ergonomics for development velocity.
- **One big crate** instead of a Cargo workspace: would couple crypto to
  the SQL layer and make the crypto crate harder to extract later.
