<!-- section: Added -->

- A `common/solana` module: `verifySolanaSignature`, `decodeBase58`,
  `encodeBase58`, `solanaAddressToPem`, `SolanaAddressSchema` and
  `SolanaSignatureSchema`. Additive, and it adds no dependency — a Solana address
  is a raw Ed25519 public key, so this re-encodes and delegates to the existing
  `verifySignature` rather than introducing a second signature implementation
  (`kolonie-platform#62`).
