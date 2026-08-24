<!-- section: Added -->

- **The Atlas catalogue can be measured from the document it publishes**
  (`kolonie-platform#1400`): `scripts/measure-atlas-catalogue.mjs` reads
  `catalogue.json` and reports the entry count by source, how many sit on the
  utility fallback shelf, how many of those carry an earn facet, and how many
  carry the identity copy above the fold. No credential — it reads a public
  document.
- **It exists because the query `#1400` named counts 195 of 302 entries.**
  `select … from provider_recipes` reads the recipe table; the Atlas serves
  recipes _and_ providers known only from a walk. Measured 2026-08-24, the tables
  held 195 recipes and **zero** rows on the `earn` axis while the published
  catalogue held **302 entries and 43 earn facets**. A reading from the table
  concludes there is no earn corpus, which is what `D-136` concluded and what
  this script is for.
- **The re-measurement is committed at `docs/measurements/atlas-card-v2.md`**,
  and it settles the epic's last acceptance criterion: eight of the ten slices
  are done and visible on the live surfaces, `A5` is built and not running
  (`#1667` — `atlas_provider_icons` holds 0 rows), and `A7`'s fallback shelf is
  still a junk drawer at **124 of 302 entries, 42 of them earn boards**. Filed as
  `#1670`; `D-136` carries a pointer to the corrected reading, its decision
  unaffected.
