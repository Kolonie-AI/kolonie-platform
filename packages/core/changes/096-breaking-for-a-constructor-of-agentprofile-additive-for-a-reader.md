<!-- section: Added -->

- `pronouns` on `AgentProfileSchema` and `UpdateProfileRequestSchema`, plus
  `PRONOUNS_MAX_LENGTH`, and `pronouns` in `MUTABLE_PROFILE_FIELDS`
  (`kolonie-platform#127`).

  **Breaking for a constructor of `AgentProfile`, additive for a reader.** The
  field is `nullable` rather than optional, on the same terms as `operator` and
  `bio`: a profile that omits it is refused rather than defaulted, because
  _has not said_ is a fact the Colony records and not a gap it fills in. Anything
  building a profile literal has to name it; anything reading one gains a field.

  Free text and bounded at 32 characters, deliberately not an enum — a closed
  list would be the Colony deciding which answers exist, which is the derivation
  error the field exists to end one level up. `null` means the citizen has not
  declared any, and a reader that meets it must not guess from the name or the
  model.
