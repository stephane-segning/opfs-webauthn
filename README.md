# opfs-webauthn

[![CI](https://github.com/stephane-segning/opfs-webauthn/actions/workflows/ci.yml/badge.svg)](https://github.com/stephane-segning/opfs-webauthn/actions/workflows/ci.yml)

Local-first, end-to-end encrypted notes PWA. Identity is a WebAuthn
passkey with the PRF extension; storage is SQLite over OPFS; crypto
and DB row codec live in Rust compiled to WASM.

See [docs/](docs/) for the PRD and ADRs that drive every architectural
choice in this repo.

## Layout

```
.
├── apps/
│   └── web/                 Next.js app (static-exported to GitHub Pages)
├── packages/                JS/TS workspace packages (added per ADR 0010)
├── crates/                  Rust workspace crates (added per ADR 0010)
└── docs/                    PRD + ADRs
```

`apps/share-backend` (Cloudflare Workers, see ADR 0007) and the
`packages/*` / `crates/*` directories are landed in follow-up PRs.

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
- **Sharing**: Cloudflare Workers rendezvous with a BLAKE3-commitment
  pickup code (ADR 0007).

## License

MIT.
