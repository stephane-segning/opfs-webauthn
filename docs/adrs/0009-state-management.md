# ADR 0009 — State management (Zustand)

- **Status**: Accepted
- **Date**: 2026-05-19

## Context

We need a client state layer that:

- Has small, composable stores (auth, vault, notes list, editor, share).
- Plays well with React 19 + Next.js App Router and supports SSR-safe
  hydration on the static export.
- Lets us drive updates from outside React (the SharedWorker pushing
  `tx-applied` over `BroadcastChannel` needs to refresh slices without a
  React tree).
- Stays small enough to lift into other apps along with the storage and
  UI packages.

## Decision

Use **Zustand** as the only client state library. Stores live in
`packages/state` so they can be reused outside `apps/web`.

Conventions:

- One store per bounded concern: `useAuthStore`, `useVaultStore`,
  `useNotesStore`, `useShareStore`, `useUiStore`.
- Stores expose **commands** (functions that perform an action and
  optimistically update local state) and **selectors** (small functions
  the UI subscribes to). No business logic in components.
- Persistent UI state (theme override, sidebar collapsed) uses Zustand's
  `persist` middleware against `localStorage`. Domain state (notes) is
  never persisted to `localStorage` — it lives in OPFS and is hydrated
  on unlock.
- The storage layer dispatches into Zustand from outside React via
  `useNotesStore.getState().applyTxApplied(ids)`. No React Query.
- Selectors are shallow-equality friendly; we use `useShallow` to avoid
  re-render storms in list views.
- Each store has a tested reducer-like core so we can swap React without
  rewriting domain logic.

Explicitly **not** using:

- React Context for cross-cutting domain state (too coarse).
- Redux / Zustand-with-immer for everything (immer is fine if a slice
  warrants it; not a global default).
- TanStack Query — the data source is OPFS, not HTTP, and the worker
  push model is the source of truth.

## Consequences

- The state package depends on nothing else in the repo except types
  from `packages/storage` and `packages/auth`. It is publishable on its
  own.
- The pattern "worker pushes, store applies, components re-render"
  becomes the only data-flow shape. Easy to reason about.
- We do not get free request deduplication / caching. We add small
  helpers in the storage RPC layer where needed.

## Alternatives considered

- **Jotai**: atom-per-thing is elegant but harder to subscribe to from
  outside React than Zustand's store API.
- **Redux Toolkit**: more ceremony than this project needs.
- **TanStack Query**: built around HTTP semantics that do not match
  OPFS-backed local data.
