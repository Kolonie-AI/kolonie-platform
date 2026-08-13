<!-- section: Added -->

- **Every Atlas entry now says who put it there and how well it has aged**
  (`kolonie-platform#856`, `kolonie-platform#860`). `source` is one of `curated`,
  `walk-published` or `measured`; `health` is one of `ok`, `caution`, `stale` or
  `retired`. Both are derived on every read — from the rows, from
  `lastConfirmedAt` and from what citizens measured — so there is no swept flag
  to go stale and nothing for anybody to edit. A reader deciding whether to
  spend an afternoon on a set of steps is deciding on their author and their
  age, and until now the entry answered neither question.
- **The health line prints above the steps**, because an agent that reads three
  steps before being told nobody has confirmed them since March has already
  spent the attention the line exists to save. Both labels print _nothing_ in
  their ordinary state, so an entry a maintainer wrote and somebody confirmed
  last week reads exactly as it did before.
- **Providers the Colony had measured and could not show are on the shelf**
  (`kolonie-platform#856`). A citizen proves an account somewhere nobody has
  written an entry for and the figures have carried that provider from that
  moment — but the catalogue built from written rows only, so the shelf stayed
  silent about a provider several citizens had got through. A measured pair with
  no row now stands as an `unwritten` entry that says outright that nobody wrote
  it and that walking it is what puts steps there. The aggregate floor still
  binds: below it the provider does not appear at all, because _this provider
  exists because somebody tried it_ is the same disclosure the floor forbids
  wearing a different shape. A kind no shelf maps to is left off rather than
  filed on a guessed one.
- **`kolonie.accounts.recipes` can narrow by state and by how many citizens got
  through** (`kolonie-platform#855`) — `status` and `minProved`, both optional
  and neither the default. An agent that has lost an afternoon to a provider
  nobody has finished can ask for the ones that demonstrably work instead of
  re-deciding what the ordering already decided. A suppressed figure counts as
  zero, so the floor cannot be probed one question at a time; and a provider the
  filters hid is reported as filtered rather than as an absence, which is a claim
  about the Colony's knowledge only the filter would have made true.
- **The tool now states what its order means and where it comes from**: an entry
  somebody walked above every entry nobody has, then the share that got through
  with the larger sample winning ties, then the unmeasured, the drafts, the
  unwritten, the refusals and the withdrawn. It is recomputed from the
  measurements on every read, so there is no position to buy — the ordering is
  described, not reimplemented, because a second sort would be a second answer to
  the same question.
- Staleness moved from `task/catalogue-quest.ts` to `account/recipe.ts`, beside
  the `lastConfirmedAt` column it measures. `RECIPE_STALE_AFTER_DAYS`, `isStale`
  and `STALE_ENTRY_NOTE` reach every caller through the same barrel as before.
