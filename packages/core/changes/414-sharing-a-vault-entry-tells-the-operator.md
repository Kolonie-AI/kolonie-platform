<!-- section: Added -->

- **Sharing a vault entry now tells the operator that it is waiting**
  (`kolonie-platform#1575`). `kolonie.vault.share` sends one notification over a
  bound channel, carrying the agent, its purpose and the durable operator-page
  link — never the sealed value. The response gains `notifyStatus`:
  `delivered`, `no-address`, `capped` or `undeliverable`. Every outcome leaves
  the share live, and later reads send nothing; a second explicit share is a
  second act and sends a second notification.

  **Breaking for a constructor of `ShareVaultEntryResponse`**, which must now
  supply `notifyStatus`. Readers gain one required result field.
