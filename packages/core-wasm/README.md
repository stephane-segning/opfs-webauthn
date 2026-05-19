# @opfs/core-wasm

The wasm-bindgen wrapper around the [`opfs-core`](../../crates/core)
Rust crate. JS / TS code in this repo and any downstream project
consumes the Rust crypto + repo + share-protocol surfaces exclusively
through this package — never via direct `crates/*` imports.

## Public surface

```ts
import init, {
	codeForPubkey,
	verifyCode,
	protocolVersion,
	x25519PubkeyLen,
	commitmentCodeLen,
} from "@opfs/core-wasm";

await init(); // loads the .wasm binary
const code = codeForPubkey(epkBytes);
verifyCode(code, epkBytes); // true
```

Only the share-rendezvous commitment helpers are exposed today. The
crypto vault surface (DEK lifecycle, row encrypt/decrypt) and the SQL
schema entry point land alongside the WebAuthn PRF + storage PRs.

## Build

`dist/` is gitignored. The Turbo task graph runs
`pnpm --filter @opfs/core-wasm build` (which shells out to `wasm-pack
build crates/core --target web --release`) before any downstream
typecheck or build that depends on this package.

Manually:

```sh
pnpm --filter @opfs/core-wasm build
```

## Reuse

The crate is the only bridge to Rust. Other apps that want the same
primitives import this package; the `dist/` artifact + the
[`opfs-core`](../../crates/core) crate ride along.
