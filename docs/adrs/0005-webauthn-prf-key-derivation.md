# ADR 0005 — WebAuthn PRF key derivation

- **Status**: Accepted
- **Date**: 2026-05-19

## Context

We want a single, hardware-backed credential as the only way to unlock
the vault. We do not want to store, transmit, or recover a password.
WebAuthn passkeys with the **PRF extension** (`prf` — RP-controlled
pseudo-random function evaluated inside the authenticator) give us a
stable, high-entropy secret bound to a specific credential without ever
leaving the authenticator.

## Decision

### Enrollment

1. The user clicks "Create encrypted vault".
2. JS calls `navigator.credentials.create({ ... publicKey: { extensions:
   { prf: { eval: { first: <random salt A> } } } } })`.
3. We persist:
   - `credentialId` (plaintext, in OPFS metadata file).
   - `prfSalt` (the random salt A, plaintext).
   - We do **not** persist the PRF output.
4. **Inspect the `create` response for PRF output first.** Modern
   authenticators (and the spec) return the PRF result inline as
   `getClientExtensionResults().prf.results.first` on `create`. If we
   find it there, we proceed straight to step 5 — **no second biometric
   prompt**. Only when the result is missing (older authenticator
   firmware, or a UA that strips the result on `create`) do we fall
   back to a follow-up `navigator.credentials.get(...)` with the same
   salt. The UI signals when the fallback is happening so the user
   understands the extra prompt.
5. We generate a random 256-bit **DEK** (data encryption key) in Rust.
6. We derive a **KEK** (key encryption key) from the PRF output via
   HKDF-SHA-256 with a context string `"opfs-webauthn/v1/kek"`.
7. We wrap the DEK with the KEK using AES-256-GCM and a fresh random
   nonce. We persist `{wrappedDek, nonce}` in OPFS metadata.
8. The unwrapped DEK lives only in WASM linear memory and is zeroed on
   a **shared idle policy** owned by the writer worker (see ADR 0006).
   The worker tracks the last-activity timestamp across every connected
   tab (each tab sends a heartbeat while focused). Once no tab has been
   active for the configured idle window (default 5 minutes) the worker
   zeroizes the DEK and broadcasts `vault-locked` so every tab routes
   to the unlock screen at the same moment. A single tab going
   background does not, by itself, lock the vault.

### Unlock

1. The user clicks "Unlock".
2. JS calls `navigator.credentials.get({ ... allowCredentials: [stored
   credentialId], extensions: { prf: { eval: { first: prfSalt } } } })`.
3. We HKDF the PRF output into the KEK with the same context string.
4. We AES-GCM-unwrap the DEK using the stored nonce.
5. From here on, every encrypt/decrypt operation goes through the WASM
   crypto module using the in-memory DEK.

### Worker eviction and mobile background suspension

Both `SharedWorker` and dedicated workers can be killed by the browser
under memory pressure. On mobile, background tabs can be paused for
long stretches, so heartbeats from a backgrounded tab will look like
idleness even if the user comes back two seconds later. We therefore
treat **DEK loss as an expected event, not a failure**:

- Any RPC call from a page to the worker that comes back with a
  `vault-locked` (or fails because the worker exited) puts the UI into
  the "unlock" state with no data loss. The page does **not** discard
  in-progress edits; it keeps them in component state until the next
  successful write.
- Unsaved draft text is also mirrored to a small `drafts` table in
  OPFS (encrypted at flush, or stored under a per-tab session key for
  the immediate "I was typing" window). On unlock, the editor restores
  the draft transparently. No "lost my note" surprise.
- The UI distinguishes locked-because-idle (silent return to unlock
  screen, friendly copy) from locked-because-worker-died (toast
  explaining that we re-locked the vault and the user's draft is
  safe). Both paths take exactly one biometric prompt to resume.
- We assume mobile background timers are unreliable and rely on
  *foreground* activity to feed the idle clock: a tab that has not
  been visible at all for the idle window is treated as idle, even
  if it stopped sending heartbeats earlier than expected.

### Rotation

- A future ADR will cover DEK rotation (re-encrypt all rows under a new
  DEK, then rewrap with the same KEK). Not in MVP.
- KEK rotation requires the user to re-enroll, since the KEK is bound to
  the PRF output of a specific credential. We document this clearly.

### Algorithm choices

- **AES-256-GCM** for both DEK wrapping and per-row encryption.
- **HKDF-SHA-256** for key derivation, with per-purpose context strings.
- **Random nonces** for every encryption operation. We do not reuse
  nonces under the same key. A future ADR may revisit this for
  deterministic indexing of certain columns.

## Consequences

- The user has zero passwords and zero recovery codes. Losing every
  device with the enrolled passkey loses the vault. The onboarding screen
  makes this explicit.
- No password-based brute force surface. The authenticator rate-limits.
- We require a browser + authenticator that supports PRF. We feature-detect
  and present a clear unsupported screen if not.
- The DEK never appears in JS-land, including in service workers, the
  React state tree, or Zustand. JS asks the WASM module to encrypt or
  decrypt; the key stays inside.

## Alternatives considered

- **Password-derived key (PBKDF2/Argon2)**: simpler to recover from but
  reintroduces a credential the user must remember and the server (or
  device) must rate-limit. Defeats the research goal.
- **WebAuthn `largeBlob` extension**: stores a key on the authenticator
  directly. Less browser support than PRF in 2026; we prefer PRF for the
  research target.
- **Storing the unwrapped DEK in IndexedDB encrypted by a session
  key**: pointless — the session key would have to live somewhere.
