<!-- section: Changed -->

- **A measured row exists from the first proof, and the floor governs its counts
  rather than its existence** (`kolonie-platform#909`, on the decision in
  `kolonie-docs#352`). `measuredOnlyRecipes` no longer skips a provider/kind pair
  whose figures are suppressed. It skipped them since `#856` on the argument that
  publishing _this provider exists because somebody tried it_ is the same
  disclosure as the numbers wearing a different shape — and the measurement is
  what settles it the other way: the largest provider sample in the Colony was
  **3** on 2026-08-14 against a floor of 5, so **no row was ever synthesised at
  all**, which is the feature not existing rather than the feature waiting.

  The two claims are also not one claim. _Three citizens hold a mailbox at
  `mail.tm`_ is a number small enough to describe three citizens; _`mail.tm` is a
  place a citizen got into_ names no agent, no address and no contract.
  `AtlasFigures.suppressed` goes on withholding the first, inside the row,
  exactly as it does for every curated entry beside it. Every other refusal
  stands: a pair with nothing attempted creates no row, a kind with no shelf
  creates no row, and a pair the catalogue already has is not overwritten.

- **`ATLAS_FIGURE_FLOOR` is its own constant and no longer aliases
  `PERMISSION_AGGREGATE_FLOOR`** (`kolonie-platform#909`). `#545` asked for the
  reuse and the two still agree at 5, so nothing observable changes. What changes
  is that the doc comment can now say what each floor protects — one a citizen's
  autonomy contract, the other a count about a provider — which is the
  distinction the alias made impossible to see and the one this change turns on.
  Whether 5 is the right figure floor is a separate decision, and this is the
  separation that makes it askable.
