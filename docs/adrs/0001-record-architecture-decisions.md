# ADR 0001 — Record architecture decisions

- **Status**: Accepted
- **Date**: 2026-05-19

## Context

This is a research project with several entangled, non-trivial architecture
choices (WebAuthn PRF as KDF, OPFS-backed SQLite, Rust → WASM boundaries,
multi-tab concurrency, static deployment with a thin sharing backend).
Future contributors — including future-us — will not remember why each
choice was made unless we write it down at the moment of decision.

## Decision

We use lightweight ADRs (Architecture Decision Records) for every
architectural choice that would be expensive to reverse or that constrains
later choices.

- ADRs live in `docs/adrs/NNNN-kebab-title.md`.
- Numbers are monotonically increasing; never reused.
- Status moves through: `Proposed` → `Accepted` → optionally
  `Superseded by NNNN` or `Deprecated`.
- Superseded ADRs stay in the repo; do not delete them.
- Each ADR has the sections: Context, Decision, Consequences, and
  (optional) Alternatives considered.
- An ADR is not a design doc — it captures the one decision and its
  trade-offs, not the implementation.

## Consequences

- Cost: one short markdown file per decision.
- Benefit: every "why did we…" question has a single linkable answer.
- We can drop the format later; the files remain readable on their own.
