# @opfs/state

Zustand stores for the opfs-webauthn UI. One store per bounded concern
(vault, notes, share, UI) per [ADR 0009](../../docs/adrs/0009-state-management.md).

## Status

Stub. `src/index.ts` declares the slice shapes (`VaultState`,
`NotesSlice`, `UiSlice`) so dependent packages can type-check. The
`create()` calls and the per-slice reducer-like cores land alongside
the UI implementation.

## Reuse

Worth lifting into a sibling app only if you also reuse
[`@opfs/storage`](../storage) and [`@opfs/auth`](../auth) — the slice
shapes are tightly coupled to those.
