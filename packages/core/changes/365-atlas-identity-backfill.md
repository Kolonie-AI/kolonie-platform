<!-- section: Added -->

- **The rows that predate the identity writers are filled from what the database
  already holds** (`kolonie-platform#1335`). `#1296` made an https homepage a bar
  for first shelf presence, `#1330` carried it through synthesis and `#1331`
  reads an earn facet off the kind a walker filed — and all three write
  _forward_. Measured 2026-08-19: eight walked earn providers with a homepage in
  the walk that created them, `null` on the recipe row, and an empty earn axis on
  every one.

  `backfillAtlasIdentity` copies and never invents. The homepage comes from the
  **earliest** walk that filed one — `#1330` decision 2's rule, so a backfilled
  row and a walked row end up with the same value and the pass is deterministic
  across two runs — and from nowhere else: no fetch, no guess from a provider
  name, no `https://` prefixed onto a domain. A row no walk can fill is left null
  and counted, which is what the page already renders correctly by omitting the
  block. The facet comes from `#1331`'s one mapping, so this pass and the
  walk-close path cannot disagree about what a `gig-marketplace` is.

  **It never withdraws.** A homepage already held is left alone, and the facet
  write is the union — a provider a moderator marked `affiliate-referral` keeps
  it and gains the one its kind carries, where a replacement would have dropped
  the referral on every row it touched.

  **`dryRun` reports exactly what a wet run would and writes nothing**, which is
  worth having on a pass that touches the public catalogue. It runs from the seed
  rather than from `drizzle/`, on `atlas-backfill.ts`' argument: the kind-to-facet
  map is TypeScript and a copy of it in a migration is a second mapping that
  drifts, and a seed pass is idempotent by construction — it only fills a null and
  only adds a facet the row does not hold — where a migration runs once and leaves
  no way to run it again on a restored database.
