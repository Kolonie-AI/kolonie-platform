<!-- section: Added -->

- **A walked recipe gets its own verdict before anybody is sent down it**
  (`kolonie-platform#813`). `RecipeModerationStagesSchema` records what decided
  one — the dedup digest, the one red line about a provider's terms, whether a
  step names a credential, whether the entry can be published at all, whether
  the steps are sound, and the shelf. `RecipeVerdictSchema` has three outcomes,
  not two: `published` and `refused` move the entry, and **`held` moves
  nothing**, because a refused entry keeps no steps and most of what stops a
  draft is fixable. `whyNotPublishable` is the table's own constraints read
  forwards, so a draft is told what is missing instead of failing an `UPDATE`,
  and `stepNamingACredential` re-applies `looksLikeCredential` to the last gate
  before an agent follows the path.
