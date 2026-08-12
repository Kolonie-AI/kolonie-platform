<!-- section: Added -->

- `atlasIsWalked`, the one predicate behind *has anybody looked at this provider at all* — read by the Atlas sitemap, which no longer submits an entry nobody has walked, and by the entry page, which asks a crawler for `noindex, follow` on one. A refusal or a withdrawal counts as walked and stays in both: those are findings, and only the placeholders come out. (#790)

<!-- section: Changed -->

- `atlasByOutcome` sorts every entry nobody has walked below every entry somebody has, ahead of the ranking rather than inside it: an entry with no outcome cannot be ordered by outcome. It is the one place `atlasRank`'s ladder is overruled, where `unwritten` sits above `refused` — that answers which road is the better bet, and a list answers which entry is worth a reader's first look. (#790)
