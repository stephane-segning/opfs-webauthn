# PRD 00 — Product overview

## One-liner

A local-first, end-to-end encrypted notes app that uses a passkey (WebAuthn
PRF) as the only credential. Notes are stored in SQLite running over OPFS in
the browser. The same app installs as a PWA on mobile, works offline, and can
share encrypted notes between devices through a thin backend that never sees
plaintext.

## Why this exists

This repo is a research vehicle. We want to learn — and produce reusable
crates and packages around — three intersecting technologies:

1. **WebAuthn PRF** as a primary key-derivation mechanism (no password).
2. **OPFS-backed SQLite** as a real, queryable, durable local store.
3. **Rust → WASM** as the layer that owns crypto and storage primitives,
   exposed to a TypeScript / React UI.

The notes app is the smallest product surface that exercises all three
honestly: it has identity (enrollment), state (notes), persistence (OPFS
DB), encryption (PRF-derived key), sync (multi-tab + cross-device).

## Audience

Two audiences, in order of priority:

1. **Us, as researchers.** We need clean module boundaries so the crypto
   crate, the storage crate, and the UI package can be lifted into other
   projects without dragging the whole app along.
2. **Privacy-curious end users** who want a small, fast, offline-first notes
   app where the server can never see their content.

## Primary stories

- **Enrollment.** First visit shows a single button: "Create encrypted
  vault". One click generates a passkey with the PRF extension, derives a
  data-encryption key, initializes the local SQLite DB in OPFS, and lands
  the user in an empty notes app. No email, no password, no recovery codes
  shown up-front.
- **Unlock.** Returning visit shows the same screen with the button now
  labelled "Unlock". The passkey PRF call re-derives the key and opens the
  DB.
- **Note CRUD.** Create, edit, search, archive, delete a note. Everything
  is offline-first; writes hit local OPFS immediately.
- **Multi-tab.** Two tabs open in the same browser stay consistent without
  conflict or DB corruption.
- **Cross-device share.** The recipient device first taps "Receive on
  this device", authenticates with its passkey, and is shown a short
  pickup code. The user enters that code on the sender device, picks a
  note, and sends it. The sender encrypts to a fresh ephemeral
  recipient pubkey (HPKE-style) so the backend only relays opaque
  ciphertext; the recipient pulls and decrypts locally.
- **Install as PWA.** Works installed, on mobile, offline, after first
  network load.

## Success criteria

- A first-time visitor can go from `https://…` to "my first note saved" in
  under 15 seconds with one biometric prompt.
- Killing the network after first load does not break any read or write.
- Closing all tabs and reopening returns the user to the same vault with
  no resync from a server.
- The encryption code, the storage code, and the UI primitives each ship
  as independently versioned packages with a public API surface a third
  party could plug into a different app.
