# opfs-webauthn

[![CI](https://github.com/stephane-segning/opfs-webauthn/actions/workflows/ci.yml/badge.svg)](https://github.com/stephane-segning/opfs-webauthn/actions/workflows/ci.yml)

Live: **<https://ocs.vaam.store>**

> [!IMPORTANT]
> The app used to live at `stephane-segning.github.io/opfs-webauthn`.
> WebAuthn passkeys are bound to the hostname they were enrolled
> on (the "rpId" is baked into each credential), so any vault
> created under the old domain **cannot be unlocked from the new
> one**. Re-enroll on `ocs.vaam.store` to create a fresh vault.

Local-first, end-to-end encrypted notes PWA. Identity is a WebAuthn
passkey with the PRF extension; storage is SQLite over OPFS; crypto
and DB row codec live in Rust compiled to WASM.

See [docs/](docs/) for the PRD and ADRs that drive every architectural
choice in this repo.

## Layout

```
.
├── apps/
│   ├── web/                 Next.js app (static-exported to GitHub Pages)
│   └── share-backend/       Rust + Knative rendezvous service (ADR 0012)
├── packages/                JS/TS workspace packages (ADR 0010)
│   ├── auth/                WebAuthn PRF ceremonies
│   ├── core-wasm/           wasm-bindgen surface over the Rust crates
│   ├── design-tokens/       Shared CSS variables
│   ├── share-client/        Page-side share orchestration
│   ├── state/               Zustand stores (notes, …)
│   └── storage/             sqlite-wasm/OPFS writer + typed RPC
├── crates/                  Rust workspace (ADR 0010)
│   ├── core/                wasm-bindgen entry point
│   ├── crypto/              AES-GCM, HKDF, BLAKE3 commitment, X25519 share
│   ├── repo/                Pure-Rust row model
│   └── share-protocol/      CBOR envelope types
└── docs/                    PRD + ADRs
```

## Development

```sh
pnpm install
pnpm dev          # turbo orchestrates per-app dev servers
pnpm build        # production build
pnpm typecheck
pnpm check        # biome lint + format
```

Single app dev:

```sh
pnpm --filter @opfs/web dev
```

## Stack

- **Frontend**: Next.js 15 (static export), React 19, Tailwind v4, Zustand.
- **Local store**: `sqlite-wasm` on OPFS, driven by a SharedWorker
  (ADR 0006).
- **Crypto + repo**: Rust → WASM, AES-256-GCM rows, HKDF-derived KEK
  from WebAuthn PRF (ADR 0005).
- **Sharing**: Rust + Knative rendezvous service (ADR 0012) with a BLAKE3-commitment
  pickup code (ADR 0007).

## License

MIT.
