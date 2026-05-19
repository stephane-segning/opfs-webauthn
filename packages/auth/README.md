# @opfs/auth

WebAuthn PRF enrollment + unlock orchestration. The JS-side bridge of
the key hierarchy described in [ADR 0005](../../docs/adrs/0005-webauthn-prf-key-derivation.md):

```
passkey ──PRF eval(prfSalt)──▶ prfOutput ──HKDF──▶ KEK
                                                    │
                wrappedDek (persisted) ◀──AES-GCM───┤
                                                    ▼
                                                    DEK (in-wasm only)
```

The PRF output and the DEK never appear in JS-visible byte buffers —
[`@opfs/core-wasm`](../core-wasm) generates the DEK inside the wasm
module; this package drives the browser ceremony and shuttles the
PRF output across.

## Public surface

```ts
import {
	enroll,
	unlock,
	credentialStore,
	type VaultCredential,
} from "@opfs/auth";

// First visit: create a vault. The browser shows the passkey UI; on
// success we get an open vault + a persistable credential blob.
const { vault, credential } = await enroll();
credentialStore.set(credential);

// Returning visit: unlock with the stored credential.
const stored = credentialStore.get();
if (stored) {
	const vault = await unlock({ credential: stored });
	// `vault` is the same CryptoVault from @opfs/core-wasm; pass it
	// to @opfs/storage to encrypt/decrypt rows.
}
```

## Where the credential blob lives

`credentialStore` is a small `localStorage`-backed adapter. It is the
right home for *credential metadata* (credential id, PRF salt,
wrapped DEK + wrap nonce, created-at): small, multi-tab visible,
survives reloads. The encrypted notes DB itself lives in OPFS — see
[ADR 0004](../../docs/adrs/0004-sqlite-opfs-storage.md) and
[`@opfs/storage`](../storage).

## Errors

- `AuthUnsupportedError` — WebAuthn or the PRF extension is not
  available on this device. Surface the "unsupported" screen.
- `AuthCeremonyError` — the user cancelled or the authenticator
  refused. Safe to retry.

## Status

Browser-only; the WebAuthn ceremony itself cannot be unit-tested under
`vitest`/Node. The base64url codec (used to serialise the credential
blob) ships a small Vitest suite. Storybook / Playwright coverage
lands when the storage layer and the auth UI integrate.
