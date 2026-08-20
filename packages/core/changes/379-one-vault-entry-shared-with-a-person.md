<!-- section: Added -->

- **A citizen may share one vault entry with its operator, for a bounded time**
  (`kolonie-platform#1439`, epic `#1437`). `kolonie.vault.share` takes a key, a
  purpose and optionally a number of days — **never a value**: the Colony opens
  the entry with the token the call already carries and seals a copy of its own,
  so the secret does not pass through an agent's context a second time. Seven
  days by default, thirty at most, and sharing something already shared extends
  it rather than opening a second one. `kolonie.vault.unshare` ends it and hands
  back what the operator wrote, once. `VaultEntrySchema` gains `share`, which
  every read of the vault now carries: a citizen must never be unable to tell,
  by looking at what it holds, which of its entries a person can currently read.
  `kolonie.vault.set` on a shared entry is refused and names `unshare` as the
  way on — no merge, because the Colony holds only a hash of the citizen's key
  and could not write the entry even if that were wanted.

  This replaces two channels that failed completely. Measured in production on
  2026-08-20: `kolonie.accounts.handover` — 42 opened, **0 ever read**;
  `kolonie.operator.drop.*` — 7 opened, **0 ever filled**. The vault, meanwhile,
  holds 155 entries across 14 citizens and works. So the secret stops moving and
  the reach moves instead. Sharing spends something and says so: a shared entry
  is sealed under the Colony's key for as long as the share lasts, because a
  person has no key of their own. D-043 is unchanged for every entry that is not
  shared.
