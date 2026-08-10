<!-- section: Added -->

- **`ErasedCountsSchema` gains `contacts`** (`kolonie-platform#141`).

  **Breaking for anything that constructs an `ErasedCounts`**, which in practice
  is test fixtures — the schema is `.strict()`, so a receipt built without the
  field is refused. Readers are unaffected.

  It is named in the receipt rather than folded into a total because it is the
  one count that describes behaviour rather than work: when a citizen woke, how
  regularly, and how long it was gone. `erasure.md` §5 promises the receipt says
  specifically what was held, and a citizen that never knew the Colony kept its
  waking hours is the reader that line exists for.
