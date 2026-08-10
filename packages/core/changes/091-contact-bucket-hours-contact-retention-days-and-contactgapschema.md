<!-- section: Added -->

- `CONTACT_BUCKET_HOURS`, `CONTACT_RETENTION_DAYS` and `ContactGapSchema` —
  the vocabulary of the contact record (`kolonie-platform#141`).

  Additive. The Colony now records when each citizen was in contact, once per
  bucket and pruned past the retention bound. `CONTACT_BUCKET_HOURS` is the
  floor on how tightly any declared rhythm can ever be measured, which is why it
  is in core rather than in the storage layer: `#142`'s minimum rhythm and
  `#143`'s tolerance are both arguments about this number.

  A gap carries fractional hours on purpose. Rounding would make a citizen that
  woke at 11:59 and 12:01 look like it kept a two-hour rhythm, and the tolerance
  arithmetic downstream is where a false margin does damage.
