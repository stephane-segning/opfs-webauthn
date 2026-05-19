# opfs-share-protocol

Typed CBOR envelope for the recipient-first rendezvous share flow
described in [ADR 0007](../../docs/adrs/0007-deployment-and-sharing-backend.md).

Three message types:

- `RendezvousRequest` — the recipient device posts its ephemeral
  X25519 public key.
- `RendezvousResponse` — the backend returns the 12-char Crockford
  base32 pickup code (a BLAKE3 commitment to the public key) and an
  expiry timestamp.
- `ShareBlob` — the encrypted payload uploaded by the sender, carrying
  its own ephemeral public key plus the AES-GCM nonce and ciphertext.

The crate is `no_std` and depends only on `opfs-crypto` and
`serde` + `ciborium` for the wire format. Re-implementations of the
backend (Cloudflare Workers, Fly Machine, etc.) consume the same
envelope by depending on this crate.
