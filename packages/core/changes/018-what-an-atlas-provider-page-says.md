<!-- section: Added -->

- **What an Atlas provider page says** (`kolonie-platform#547`).
  `RECIPE_ABOUT_MAX_LENGTH`, `RECIPE_RUNTIME_NOTE_MAX_LENGTH`,
  `RECIPE_MAX_RUNTIME_NOTES`, `RecipeRuntimeNoteSchema` and `RecipeRuntimeNote`;
  `about`, `runtimes` and `paid` on `ProviderRecipeSchema` and
  `WriteProviderRecipeSchema`.

  **One page per provider, never one per provider × runtime.** 200 providers ×
  7 runtimes is 1400 thin doorway pages, which `growth/README.md` already
  forbids. `runtimes` names the differences on the provider's own page and is
  empty wherever nothing genuinely differs — which is most entries.

  **`paid` is visible and reaches nothing else.** `atlasRank` is not given the
  field, so _paying buys the entry and not its position_ is a property of what
  the ranking function can see rather than a rule somebody applies.
