# ADR 0007 — Deployment & sharing backend

- **Status**: Accepted
- **Date**: 2026-05-19

## Context

We commit to deploying the app on GitHub Pages, which only serves static
files. The product needs a small backend for the cross-device share flow,
which cannot live on Pages. We also use Next.js, which by default expects
a Node runtime. We must reconcile these.

## Decision

### Frontend on GitHub Pages

- `apps/web` is configured for **Next.js static export** (`output:
  'export'`). All dynamic data lives in the client (OPFS, WASM, Zustand).
- A GitHub Actions workflow on push to `main`:
  1. Builds the WASM bundle (`wasm-pack build` via Turbo).
  2. Builds `apps/web` (`next build` with static export).
  3. Publishes the `out/` directory to the `gh-pages` branch.
- Asset paths use the repo's basePath so the same build works whether
  served from a project page or a custom domain later.

### Sharing backend, deployed separately

- `apps/share-backend` is a **Cloudflare Workers** project (TypeScript,
  `wrangler` for local + deploy). Cloudflare's free tier covers the
  expected research traffic, has KV / R2 for the encrypted-blob staging,
  and global edge presence.
- Endpoints (sketch, finalized in a later ADR):
  - `POST /share` — accepts an opaque encrypted blob + recipient
    public-key fingerprint; returns a short pickup code and a TTL.
  - `GET /share/:code` — returns the blob if it exists and has not
    expired; deletes on first successful read.
  - `GET /pubkey/:fingerprint` — published public key for a device, so a
    sender can wrap to it.
- The backend stores **only ciphertext**. It never sees plaintext, the
  DEK, or the PRF output. We document this and add a server-side
  integration test that asserts requests are rejected if they contain
  anything claiming to be plaintext (best-effort, ciphertext is opaque).
- Pickup codes are short (8 chars, base32) with rate-limited brute force
  protection and a default TTL of 15 minutes.

### Why two deployment targets

- Pages gives free static hosting that matches our "the user owns the
  data" stance.
- Workers gives the smallest possible backend and is deployable
  independently of the frontend.
- The two are loosely coupled by a single env var
  (`NEXT_PUBLIC_SHARE_BACKEND_URL`).

## Consequences

- We accept the operational cost of two deploy pipelines. They are both
  trivial (one GH Actions workflow each).
- The frontend gracefully degrades when the backend URL is unreachable:
  every non-share feature continues to work offline.
- Custom domain + HTTPS works on both Pages and Workers without code
  changes.
- The backend is small enough that we could re-port it to e.g. Vercel
  Edge or a Fly Machine without disrupting the frontend contract.

## Alternatives considered

- **Vercel** for the whole stack: would require Vercel hosting instead
  of Pages and adds vendor coupling. Pages is the explicit user choice.
- **GitHub Issues / Gists** as the share transport: clever but adds rate
  limits and breaks the "backend never sees plaintext attempts" story.
- **Server-Sent peer-to-peer (WebRTC)**: real-time but heavy. The MVP
  is one-shot relay; we revisit if continuous sync is added.
