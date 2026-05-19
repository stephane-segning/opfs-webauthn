# opfs-crypto

`no_std` crypto primitives used by the `opfs-webauthn` notes vault:

- AES-256-GCM AEAD with associated data, for row payload and key wrap.
- HKDF-SHA-256 KEK derivation from a WebAuthn PRF output.
- BLAKE3-truncation commitment code for the share-rendezvous pickup
  code (60 bits, 12 Crockford-base32 chars; see ADR 0007).
- Zeroizing key wrapper and constant-time byte comparison.

## Reuse

This crate has no `opfs-webauthn`-specific assumptions outside the
context strings in `hkdf::KEK_INFO` and the commitment-code construction.
Drop it into another project to get the same primitives:

```toml
[dependencies]
opfs-crypto = { git = "https://github.com/stephane-segning/opfs-webauthn", subdir = "crates/crypto" }
```

## Status

Tested with RFC 5869 §A.1 HKDF vectors and AES-GCM round-trip /
tamper-rejection tests. The upstream `aes-gcm` crate already ships
the full NIST KAT suite, so we test our wiring rather than re-running
those.
