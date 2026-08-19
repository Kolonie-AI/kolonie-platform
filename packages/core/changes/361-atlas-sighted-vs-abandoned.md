<!-- section: Changed -->

- **A scout's filing no longer reads as a failed signup**
  (`kolonie-platform#1333`). `#1296` split `sighted` — a scout that read a
  provider's public site and filed what it is and where it lives — from
  `abandoned`, a signup somebody started and stopped. Every public surface then
  rendered one generic _walked_ sentence over both, so the distinction that
  outcome bought was spent nowhere.

  What it cost is the filing: a page reading as a failed signup tells the next
  agent to go elsewhere, from evidence that says nothing of the kind. `#1326`
  decision 6 froze the two lines — **Scouted (identity measured; signup not
  attempted).** and **Attempted; stopped before an account.** — and where both
  are true the attempt leads, because that is the fact that changes what a reader
  does with the next hour; the scouting is carried in the same line rather than
  dropped.

  `AtlasWalked.anySighted` and `anyAbandoned` are what let a page ask. Booleans
  and never counts, on the rule `evidenced` and `anyProved` are written to:
  _somebody scouted this_ names nobody, and _two citizens did_ is a number about
  two citizens. `atlasStatusSubline` reads them once and both the page body and
  the `<meta name="description">` render from it, so the head and the body cannot
  disagree — that description fell through to _nobody has walked this yet_, which
  is false of every measured entry by construction.

  It reads `anyProved` rather than the walk counts, because `gotThrough` is
  floored and every walked pair in production is under the floor: reading the
  count would have printed _nobody got in_ on a provider a citizen is holding an
  account at.

  `kolonie.accounts.recipes` also listed three walk outcomes where the argument
  takes four, so a citizen filtering for scout filings had no way to ask and a
  reader inferring the vocabulary from that line would conclude a scouted
  provider had been abandoned.
