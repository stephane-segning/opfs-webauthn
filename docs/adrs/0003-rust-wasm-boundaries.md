# ADR 0003 — Rust × WASM boundaries

- **Status**: Accepted
- **Date**: 2026-05-19

## Context

We want Rust to own the security-sensitive parts of the app (crypto,
encrypted-row handling) and to push the SQL repository layer down to a
typed, audited surface. But we are also using `sqlite-wasm` (the official
SQLite WASM build) for the actual database engine because writing our own
OPFS VFS from Rust is out of scope for the MVP.

We need a clear answer to: "what runs in Rust, what runs in JS, and where
is the trust boundary?"

## Decision

The Rust → WASM module is responsible for:

1. **Crypto primitives.** AES-256-GCM, HKDF, random bytes, constant-time
   comparison. No JS-side crypto for confidentiality.
2. **DEK lifecycle.** Wrapping / unwrapping the data-encryption key with
   the PRF output. The unwrapped DEK lives only inside the WASM linear
   memory; JS never holds the raw DEK.
3. **Row codec.** Given a logical note `{id, title, body, …}`, produce the
   ciphertext + nonce + AAD that the SQL layer stores; and the reverse.
4. **Protocol types.** Share-flow envelopes (the encrypted blob format,
   versioning, header parsing).
5. **Schema + migrations.** SQL strings and migration ordering live in
   `crates/repo`. JS calls a Rust function `current_schema_sql()` /
   `migrate_to(version)` and feeds the resulting SQL into sqlite-wasm.

The JS side is responsible for:

1. **WebAuthn ceremony.** `navigator.credentials.create/get` with the PRF
   extension; we cannot run this from inside WASM.
2. **OPFS access.** The official `sqlite-wasm` bundle owns the OPFS VFS.
   JS holds the SQLite handle and runs the prepared statements that Rust
   produced.
3. **Worker orchestration.** The dedicated worker that hosts sqlite-wasm
   and serializes writes lives in JS (see ADR 0006).
4. **UI.** Everything React.

The bridge is small and explicit. `packages/core-wasm` exposes a typed
TypeScript surface that maps 1:1 to the Rust crate's public functions.
Nothing else in `apps/web` or `packages/ui` may import directly from
`crates/`.

## Consequences

- We do not need a Rust SQLite driver compiled to WASM. We avoid an
  entire class of OPFS-VFS bugs by reusing the official build.
- The cost is one extra hop per query: Rust returns "the SQL + parameters
  to run", JS executes against sqlite-wasm, JS hands rows back to Rust for
  decryption. To keep this from becoming a hot-path bottleneck we commit
  to three rules from day one:
  - **Batch crossings.** The crypto API is row-set oriented
    (`decrypt_rows(blobs[]) -> rows[]`), not row-at-a-time. We never
    call into WASM in a per-row loop from JS.
  - **Zero-copy where possible.** Ciphertext and plaintext travel as
    `Uint8Array` views into the WASM linear memory; we copy out only at
    the React state boundary.
  - **Hot reads stay in the worker.** The dedicated worker that owns
    sqlite-wasm (see ADR 0006) is also where the WASM crypto module is
    instantiated. Page <-> worker has one `postMessage`; WASM <-> JS
    inside the worker is a function call. The "double crossing" cited
    in early review happens inside a single worker process and is
    cheap.
  We profile the initial vault-load decryption (the worst case, all
  notes at once) as the first perf checkpoint and revisit if it exceeds
  a budget defined in the perf ADR.
- The DEK never crosses the WASM/JS boundary as plaintext. JS can request
  encrypt/decrypt operations but cannot exfiltrate the key.
- The `wasm-bindgen` bridge becomes the public, audited API surface of
  the crypto + repo crates. It is the only thing other projects need to
  consume the security stack.

## Alternatives considered

- **All-Rust including SQLite.** `rusqlite` + a hand-rolled OPFS VFS or
  `sqlite-wasm-rs` would unify the stack. Rejected for MVP: too much
  surface area to audit at the same time as PRF + OPFS.
- **All-JS crypto** with WebCrypto. Possible, but loses the goal of
  producing reusable Rust crates and would put the raw DEK in JS-land.
- **Service worker as the security boundary** instead of WASM. Service
  workers are evictable and not actually isolated from page JS, so they
  do not add a real boundary.
