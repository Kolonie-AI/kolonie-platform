<!-- section: Added -->

- **A quest whose deliverable is a catalogue entry**
  (`kolonie-platform#525`). `QuestDeliverableSchema`, `RECIPE_STALE_AFTER_DAYS`,
  `CatalogueDeliverableSchema`, `isStale` and `STALE_ENTRY_NOTE` in
  `task/catalogue-quest.ts`; `deliverable` on the quest fields;
  `lastConfirmedAt` on `ProviderRecipeSchema`.

  **A field on the quest, not a second task type.** Escrow, slots, moderation,
  the steward's basis and the report channel all apply unchanged; only the shape
  of the deliverable differs.

  **A refusal is a valid deliverable and takes the same path as a recipe.** The
  submission schema accepts either and nothing downstream distinguishes them.

  **Staleness is derived from `lastConfirmedAt` and never stored as a flag.** A
  `stale` column would need sweeping on a schedule, and the day that job stops
  the catalogue silently claims to be current. A comparison cannot stop running.
