<!-- section: Changed -->

- **A kind spelled as a shelf belongs on that shelf** (`kolonie-platform#917`).
  `atlasCategoryForKind` now resolves the fifteen Atlas category names as account
  kinds in their own right, alongside the category-to-kind pairing it already
  reversed and the `github` holding it already carried. The account-kind
  vocabulary is deliberately open — `kolonie.accounts.declare` invites _another
  slug of your own_ — and the most predictable thing a citizen reaches for is the
  name of the shelf it can see: measured on 2026-08-14, two of the four walks
  waiting for a steward carried `code-hosting`, which is the shelf's own name and
  not the `code-host` kind paired with it. Neither resolved.

  **Derived and bounded rather than an alias list.** It covers exactly the
  category names and grows only when a shelf does. A kind that merely resembles
  one still throws, which is the behaviour the rest of the Atlas depends on: a
  guessed shelf is a false catalogue claim, and `measuredOnlyRecipes`,
  `recordMeasuredProvider` and now `finishWalk` all decline to write an entry
  rather than make one. The derivation refuses at module load if a category name
  is ever paired with a different shelf, so the rule cannot silently re-shelve a
  pair somebody else established.
