<!-- section: Added -->

- **What the Colony can say about a provider that nobody else can**
  (`kolonie-platform#545`). `ATLAS_RETENTION_DAYS`, `ATLAS_FIGURE_FLOOR`,
  `AtlasAudienceSchema`, `AtlasStopSchema`, `AtlasFiguresSchema`, `noFigures`,
  `throughRate` and `atlasRank` in `account/atlas-figures.ts`; `figures` on each
  recipe in `AtlasEntrySchema`, plus `figureKey` and `atlasByOutcome`.

  **Ordering is derived and stored nowhere.** `atlasRank` recomputes it from the
  measurements on every read, which is how _ordering is never for sale_ becomes
  a property of the schema rather than a policy: there is no position field for a
  paying provider to be moved to, and `#548` requires that none ever exists.

  **The floor is `PERMISSION_AGGREGATE_FLOOR` and not a second number**, on
  `#545`'s instruction to reuse it. A suppressed row is returned with
  `suppressed: true` rather than dropped — a missing Atlas row would read as
  _this provider has no page_, which is a claim about the provider.
