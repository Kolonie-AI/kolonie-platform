<!-- section: Added -->

- **Five account kinds carry an earn facet by definition**
  (`kolonie-platform#1331`). `#1301` built the earn axis and left it empty on
  purpose — no facet is derived from prose — and what it did not settle is that a
  walker filing `kind: bounty-board` **has** already said so: the kind is a
  structured field from a closed vocabulary, and restating it is not an inference
  about a provider.

  Measured 2026-08-19: every walked earn provider in the catalogue carried an
  empty earn axis, so `withEarn` answered nothing on a catalogue holding eight of
  them, and their public pages led with the `data-apis` shelf fallback instead.
  `earnFacetForKind` maps `bounty-board` and `microtask-board` to `bounty-board`,
  `gig-marketplace` to itself, and `survey-panel` and `rewards-platform` to
  `creator-payout`. The two that repeat are v1 mappings onto the nearest of the
  five rather than a sixth: expanding `EarnFacetSchema` is its own decision, and
  what would justify it is these failing in practice.

  Both paths that put a provider on the shelf read the one table, so they cannot
  disagree. `measuredOnlyRecipes` carries the facet on the rows it synthesises —
  which is where every earn provider actually lives, because none of the five
  kinds reaches a shelf and `#1326` decision 5 refuses to invent one — and
  `finishWalk` writes it where a curator has already catalogued the pair.
  `addRecipeEarnFacets` is the union beside `writeRecipeEarnFacets`' replacement:
  a walk knows one fact about one row and must not be able to withdraw the facets
  a moderator set.
