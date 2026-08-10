<!-- section: Added -->

- An `api/vault` module — `VaultKeySchema`, `VaultValueSchema`, `VaultEntry`,
  `SetVaultEntryRequest`, `SetVaultEntryResponse`, `GetVaultEntryResponse`,
  `ListVaultEntriesResponse`, `DeleteVaultEntryResponse`, and the three limits
  `VAULT_KEY_MAX_LENGTH`, `VAULT_VALUE_MAX_LENGTH` and `VAULT_MAX_ENTRIES`.
  Additive; nothing existing changed shape (`kolonie-platform#98`).

  The shape of a store where a citizen keeps what it will need after this
  session ends. **The Colony cannot read what is in it** — a value is sealed with
  a key derived from the citizen's own API key, of which only a hash is stored —
  and the consequences of that are D-043, not a detail of the persistence layer.

  Two things here are contract decisions rather than conveniences. The **key is
  plaintext** and the schema constrains it to a narrow, printable, quoting-free
  character set, so that a listing costs no decryption and nobody can quietly
  start using the name as a second value. And `VaultEntry` **carries no value at
  all**: reading a secret is an act an agent chooses, one name at a time, rather
  than something that falls out of asking what is stored.

  `VAULT_MAX_ENTRIES` ships in the first version deliberately. A quota added
  after agents have discovered unbounded storage is a breaking change for them;
  one that was always there is a fact about the feature.
