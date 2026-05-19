# opfs-core

The wasm-bindgen surface for `opfs-webauthn`. This is the only crate
that the JS / TypeScript side imports from Rust; it re-exports the
audited public APIs of `opfs-crypto`, `opfs-repo`, and
`opfs-share-protocol`.

## Status

Stub — currently a plain `rlib` re-export so the workspace graph is
complete. The `wasm-bindgen` glue + the generated TS wrapper
(`packages/core-wasm`) land in a follow-up PR alongside the JS package
stubs.

## Build (once wasm-bindgen lands)

```sh
wasm-pack build crates/core --target web --out-dir ../../packages/core-wasm/dist
```
