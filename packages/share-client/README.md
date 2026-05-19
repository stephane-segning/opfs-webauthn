# @opfs/share-client

Page-side client for the recipient-first share rendezvous (ADR 0007).
Wraps the HTTP transport and the WASM seal/open bindings into a small
three-verb surface so the UI doesn't have to know how the protocol
fits together.

## Surface

```ts
import {
  RendezvousClient,
  prepareReceive,
  pollAndDecrypt,
  sendShare,
} from "@opfs/share-client";

const client = new RendezvousClient({
  baseUrl: process.env.NEXT_PUBLIC_SHARE_BACKEND_URL!,
});

// Recipient — mints the rendezvous, gets the human-readable code.
const session = await prepareReceive(client);
console.log("Read this aloud:", session.code);

const plaintext = await pollAndDecrypt(client, session, {
  intervalMs: 1500,
  timeoutMs: 300_000,
});

// Sender — verifies the commitment locally, encrypts, uploads.
await sendShare(client, codeFromRecipient, noteBytes);
```

## Threat model

The backend is treated as untrusted. The recipient publishes only an
ephemeral X25519 public key; the sender locally re-derives the
BLAKE3-truncated commitment code from the pubkey it fetches and
refuses to encrypt if the codes do not match. The encrypted blob
binds the sender's ephemeral pubkey and a domain-separator label
into the AES-GCM tag, so a hostile relay cannot substitute either
side without invalidating the tag.

## Wire format

The blob staged on the backend is a fixed binary framing:

```
[version: u8 = 1][senderPubkey: 32 bytes][nonce: 12 bytes][ciphertext: N bytes]
```

The Rust crate `opfs-share-protocol` carries the same fields as a
CBOR envelope; a Rust↔JS interop helper can be added when a Rust-side
sender or receiver lands.

## Tests

```sh
pnpm --filter @opfs/share-client test
```

22 cases cover the codec round-trip, malformed-blob rejection, and
the HTTP transport's error mapping (network failure, 403 origin,
404 missing, 409 already-uploaded, 410 expired, 429 rate-limited).
