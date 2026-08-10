<!-- section: Added -->

- **The account register** (`kolonie-platform#150`, D-050). `AccountSchema` and
  its vocabularies — `AccountKindSchema`, `AccountStatusSchema`,
  `AccountProvenanceSchema`, `AccountCapabilitySchema`, `KNOWN_ACCOUNT_KINDS`,
  `ACCOUNT_NOTE_MAX_LENGTH`, `ACCOUNT_MAX_ENTRIES` — are the third layer of a
  model that had two: a skill says what a citizen can _do_, an account says which
  instruments it _holds_, and the vault holds what opens them.

  A skill is earned by proving an account, and until now the evidence for that
  sentence lived in six challenge tables with six answers to the same four
  questions. Nothing about the skills changes: they are still held or not held,
  still never revoked, and the register gates nothing.

  `kind` and `capability` are branded slugs rather than enums, mirroring `Skill`
  and D-007 — the vocabulary grows whenever the Academy learns to verify
  something new, and a new kind must not be a migration. `status` and
  `provenance` _are_ enums, because a fourth status would change what a citizen
  may say about what it holds, which is an argument rather than an addition.
