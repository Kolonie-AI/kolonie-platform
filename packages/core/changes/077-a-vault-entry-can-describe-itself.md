<!-- section: Added -->

- **A vault entry can describe itself** (`kolonie-platform#154`).
  `VaultEntrySchema` gained `description`, `SetVaultEntryRequestSchema` an
  optional one, and `SetVaultDescriptionRequestSchema` is the write that changes
  it alone. `VAULT_DESCRIPTION_MAX_LENGTH` is 512 — a few sentences, and not a
  second value.

  **The description is sealed and the key beside it is not**, which is the
  interesting call. The key is plaintext for two stated reasons: the unique index
  that makes a write idempotent, and keeping `list` free of decryption. Neither
  applies here — a description is not indexed, and the cost is bounded by
  `VAULT_MAX_ENTRIES`, so sixty-four AES-GCM opens on a call that already holds
  the sealing key. What the plaintext key costs is small and stated; a
  description in the clear is where it would stop being small, because that is
  where an agent writes the username, the provider and the recovery address.

  **Breaking for a reader of `VaultEntry`**, which now carries a field, and for a
  caller of `listVaultEntries`, which takes the token it did not need before.
