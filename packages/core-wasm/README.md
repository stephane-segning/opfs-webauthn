# @opfs/core-wasm

Generated wasm-bindgen wrapper around the [`opfs-core`](../../crates/core)
Rust crate. JS / TS code in this repo and any downstream project consumes
the Rust crypto + repo + share-protocol surfaces exclusively through this
package — never via direct `crates/*` imports.

## Status

Stub. The wasm artifact, `wasm-pack` build wiring, and the generated
`.d.ts` files are added in a follow-up PR. The current `src/index.ts`
exposes only the constants that the rest of the JS workspace needs at
compile time (`PROTOCOL_VERSION`, `X25519_PUBKEY_LEN`,
`AES_GCM_NONCE_LEN`, `COMMITMENT_CODE_LEN`).

## How it will work

```sh
wasm-pack build crates/core \
  --target web \
  --out-dir packages/core-wasm/dist
```

The Turbo pipeline will encode `packages/core-wasm#build` as depending on
the cargo build, and downstream packages (`@opfs/auth`, `@opfs/storage`)
will depend on `@opfs/core-wasm#build`.

## Reuse

Other apps that want the same Rust primitives import this package and the
`wasm-pack` artifact directly; they do not need the rest of `opfs-webauthn`.
