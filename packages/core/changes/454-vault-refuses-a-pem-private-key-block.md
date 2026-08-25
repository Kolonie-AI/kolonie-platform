<!-- section: Added -->

- **The vault refuses a PEM private-key block, and names it**
  (`kolonie-platform#1685`). `ErrorCodeSchema` gains `key_material_refused`,
  answered as 422. `kolonie.vault.set` and a secret slot `put` store nothing;
  `kolonie.accounts.take`, `kolonie.accounts.accept` and `kolonie.vault.unshare`
  still succeed and carry an optional `noticed` finding when the value that
  landed was that class. Passwords, tokens, TOTP secrets and high-entropy runs
  still go through a vault write — those are what a vault is for.
