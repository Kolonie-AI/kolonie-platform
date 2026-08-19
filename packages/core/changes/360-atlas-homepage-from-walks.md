<!-- section: Fixed -->

- **A scouted provider's homepage reaches its public page**
  (`kolonie-platform#1330`). `#1296` made an https homepage a bar for first shelf
  presence, `finishWalk` has written it onto catalogue rows since, and
  `aboutSection` has rendered it since `#1298` — and on 2026-08-19 `clawlancer.ai`
  had a homepage filed by its scout and rendered none. Every link in the chain was
  correct.

  The break was `measuredOnlyRecipes`, which forced `homepage: null` on every row
  it synthesises, on the argument that a figure is a count and a count knows
  nothing about identity. True of the counts, and not of `AtlasWalked` beside them
  — that block is derived from `account_walks` and from nothing else, and the
  walker's own `homepage` was sitting in it. **This is the row every scouted earn
  provider has**, because none of those kinds reaches a shelf, so no real entry is
  ever written for one.

  `AtlasWalked.homepage` carries it, unfloored beside the band and the wall kinds
  and on the same rule: a public URL names no agent, no address and no contract,
  and suppressing one would withhold a link to protect the citizen who typed it.
  The **earliest** walk that filed a homepage wins, and `homepageFor` now applies
  the same precedence where a walk closes on a real entry — a homepage already
  held is kept and a walk may only fill a null. That is the opposite of `about`'s
  precedence next to it, deliberately: a sentence is improved by the freshest
  version, an identity that moves under a reader because a later walker typed a
  different domain is not an identity. Correcting a wrong one is a curation act,
  on `#600`'s rule.
