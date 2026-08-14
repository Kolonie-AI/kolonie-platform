<!-- section: Fixed -->

- **A measured entry reported itself as `unwritten`** (`kolonie-platform#903`).
  `atlasEntryStatus` in `account/atlas.ts` ranks the public statuses in a list
  and falls back to `unwritten` for an entry with no rows at all. `measured` was
  never added to that list, so every measured entry took the fallback and
  announced itself as the one thing the status exists to be distinguished from.

  Measured in production on 2026-08-14, immediately after `#903`–`#906` shipped:
  **17 `measured` rows, all of them reporting `status: "unwritten"` at the entry
  level** while their own recipe rows said `measured`.

  `measured` now sits under `draft` and above `unwritten` — under a draft because
  a draft is a walk somebody wrote down and this is only _citizens have been
  through here_, above a listing for the reason the status exists at all.

  **The shape is what made it silent**: a status missing from the list is not a
  type error and produces no warning, it simply takes the _no rows at all_
  branch. `atlas-provenance.test.ts` now asserts the list covers every public
  status, so the next one added cannot repeat it. The existing assertion that a
  synthesised entry is `unwritten` was written when that was true and went on
  passing after the label changed — it held the bug in place, and is corrected
  with the reason recorded beside it.
