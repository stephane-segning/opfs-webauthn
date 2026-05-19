# @opfs/auth

WebAuthn PRF enrollment + unlock orchestration. The JS side of the key
hierarchy described in [ADR 0005](../../docs/adrs/0005-webauthn-prf-key-derivation.md):

- `navigator.credentials.create({ extensions: { prf: { eval } } })` for
  enrollment, with `getClientExtensionResults().prf.results.first` read
  from the create response when available (avoiding a second biometric
  tap).
- `navigator.credentials.get(...)` for unlock with the stored
  credential id and `prfSalt`.
- Hands the PRF output to [`@opfs/core-wasm`](../core-wasm) which runs
  HKDF and AES-GCM. Raw key material never returns to JS.

## Status

Stub. Exports `VaultCredential` shape, `AuthFeatureSupport`, and a
`detectSupport()` helper. The actual ceremony lands in PR #6.

## Reuse

Drop into another browser app that wants a single-button passkey vault:

```ts
import { detectSupport } from "@opfs/auth";
const s = detectSupport();
if (!s.webauthn) showUnsupportedScreen();
```
