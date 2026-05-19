# ADR 0010 — Modular packages & crates

- **Status**: Accepted
- **Date**: 2026-05-19

## Context

This is a research project. The point is not only "ship a notes app",
but to **leave reusable artifacts** behind that we can lift into other
projects:

- A Rust crypto crate that does WebAuthn-PRF-backed AES-GCM encryption.
- A Rust repo/migrations crate for OPFS-stored SQLite content.
- A JS package that orchestrates WebAuthn PRF enrollment / unlock.
- A JS package that handles the OPFS sqlite-wasm worker + leader
  election.
- A React UI package with the auth screen, notes shell, and design
  tokens.

If we let the app monolith grow tendrils into these, we will never
extract them later.

## Decision

Each package and crate is treated as if it would be published tomorrow.

### Rules of thumb

1. **Public API is the contract.** Anything not exported from a package's
   `index.ts` (or `lib.rs`) is private. Apps must not deep-import.
2. **No app-specific assumptions in packages.** A package that knows
   what the notes-app URL is, or that calls a Next.js helper, is wrong.
3. **Each package owns its README.** It explains "what this is, what it
   isn't, how to install in another project". A reviewer should be able
   to read the README and understand the package without the rest of
   the repo.
4. **No cycles.** Dependency graph stays a DAG. We enforce with Turbo's
   graph check.
5. **One responsibility per package.** If a package is doing two
   things, split it before it grows.
6. **Versioning.** Independent semver per package. `changesets` to manage
   release notes when we begin publishing.

### Package boundaries

| Package / crate           | Owns                                       | Depends on               |
|---------------------------|--------------------------------------------|--------------------------|
| `crates/crypto`           | AES-GCM, HKDF, zeroize                     | `rand_core`, `aes-gcm`   |
| `crates/repo`             | SQL schema, migrations, row codec API      | `crates/crypto`          |
| `crates/share-protocol`   | typed envelope for the share flow          | `crates/crypto`          |
| `crates/core`             | wasm-bindgen surface that re-exports above | the three above          |
| `packages/core-wasm`      | built JS+types from `crates/core`          | nothing JS-side          |
| `packages/auth`           | WebAuthn PRF orchestration                 | `packages/core-wasm`     |
| `packages/storage`        | sqlite-wasm worker + RPC + leader election | `packages/core-wasm`     |
| `packages/state`          | Zustand stores                             | `packages/storage`, `auth` |
| `packages/design-tokens`  | CSS variables + Tailwind preset            | nothing                  |
| `packages/ui`             | React components                           | `design-tokens`, `state` |
| `apps/web`                | Next.js app composition                    | all `packages/*`         |
| `apps/share-backend`      | Cloudflare Worker                          | `crates/share-protocol` (types only) |

### Cross-language type sync

Several boundaries cross Rust ↔ TypeScript: the share-protocol envelope
(consumed by `apps/share-backend` in TS), the row codec input/output
types, and the auth helper return shapes. To keep these from drifting
we generate the TypeScript definitions from the Rust source with
**`ts-rs`**:

- Rust structs in `crates/share-protocol`, `crates/repo` (public
  surface only), and `crates/crypto` (public surface only) are
  annotated with `#[derive(TS)]`.
- A `cargo test --package <crate> --features ts-export` step in CI
  emits `.ts` files into the consuming JS package's `src/generated/`
  directory.
- The generated files are committed (not generated at install time)
  so consumers of the published packages do not need a Rust toolchain.
- A CI check fails the build if the generated files would change but
  have not been re-committed.

We chose `ts-rs` over `specta` because we do not need `specta`'s
runtime introspection — we want plain compile-time `.d.ts` output.
Either tool would work; we pick one and keep the boundary narrow.

### Test discipline

- Every crate ships unit tests. `crates/crypto` ships known-answer tests
  pulled from RFC vectors.
- Every package ships at least one test that imports through its public
  surface only (catches accidental private dependencies).
- The app uses these packages; the packages do not use the app.

## Consequences

- The repo enforces a discipline that pays off only on the next project
  using these pieces. We accept that cost.
- Some refactors are slightly slower because they cross package
  boundaries. We treat that friction as a signal that the boundary is
  doing its job.
- Eventually publishing to npm + crates.io is a near-zero-effort step.

## Alternatives considered

- **Monolith now, extract later.** Always promised, rarely happens.
  Boundaries are cheapest at the start.
- **Workspace-only, no public-API discipline.** Drifts into a tangle.
