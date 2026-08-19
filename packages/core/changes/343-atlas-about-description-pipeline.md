<!-- section: Fixed -->

- **Atlas measured entries no longer stay identity-empty when walks already carry
  an approved `about`** (`kolonie-platform#1297`, epic `#1295`). Walker about is
  promoted onto entry `about` on prose approval (and again on the description
  synthesis pass), and — when it fits
  `PROVIDER_DESCRIPTION_MAX_LENGTH` — onto entry `description` as well.
  `describeProvider` falls back to that about when the model writes nothing
  usable; `atlasEntries` read-time falls back from description to about. Over-
  length candidates are dropped for description, never truncated. Gap-fill only:
  an existing curator about or synthesised description is left alone.
