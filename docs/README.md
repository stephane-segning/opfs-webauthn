# Project planning

This folder holds the planning artifacts for the project. They are the source
of truth for "what we are building" and "why we made each architectural
choice". Code may move faster than these docs — when a docs/code mismatch is
found, raise a PR to fix the docs in the same change.

## Contents

### Product Requirements

- [00 — Overview](./prd/00-overview.md) — what the product is and the audience
- [01 — MVP scope](./prd/01-mvp-scope.md) — the first usable cut
- [02 — Non-goals](./prd/02-non-goals.md) — explicit boundaries

### Architecture Decision Records

- [0001 — Record architecture decisions](./adrs/0001-record-architecture-decisions.md)
- [0002 — Monorepo structure](./adrs/0002-monorepo-structure.md)
- [0003 — Rust × WASM boundaries](./adrs/0003-rust-wasm-boundaries.md)
- [0004 — SQLite + OPFS storage](./adrs/0004-sqlite-opfs-storage.md)
- [0005 — WebAuthn PRF key derivation](./adrs/0005-webauthn-prf-key-derivation.md)
- [0006 — Multi-tab sync](./adrs/0006-multi-tab-sync.md)
- [0007 — Deployment & sharing backend](./adrs/0007-deployment-and-sharing-backend.md)
- [0008 — Design language](./adrs/0008-design-language.md)
- [0009 — State management (Zustand)](./adrs/0009-state-management.md)
- [0010 — Modular packages & crates](./adrs/0010-modular-packages-and-crates.md)
- [0011 — Engineering principles (SOLID, DRY, elegance)](./adrs/0011-engineering-principles.md)
- [0012 — Self-hosted Rust share backend on Knative](./adrs/0012-self-hosted-rust-share-backend.md)

## Working agreement

- Each material decision lands as a new ADR (status: Proposed → Accepted).
- Superseded ADRs stay in the repo; we add a `Superseded-by` link.
- PRs are scoped small. After opening, we wait ~10–15 minutes for review
  comments; if quiet, we ping `@codex please review`; if still quiet, we
  merge and move to the next topic.
