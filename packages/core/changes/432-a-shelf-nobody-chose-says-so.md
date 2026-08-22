<!-- section: Fixed -->

- **A shelf nobody chose says so on the shelf** (`kolonie-platform#1407`).
  Measured 2026-08-22 on `/atlas/c/data-apis`: **123 entries**, against 36 on the
  next largest shelf — and **none of the twenty-five rows on the first page said
  which of them landed there by default**. `opentask.ai`, a bounty marketplace,
  and `cobaltsites.com`, a website partner programme, sat between Alpha Vantage
  and Unsplash with nothing to tell them apart.

  **`#1329` fixed this on the provider page and left the row alone.** That was
  the right half to do first — the page is where a reader decides — but the row
  is the surface where it matters most, because the row is where the fallback
  entries sit _together_. Verified the same day: `clawlancer.ai`,
  `execution.market`, `opentask.ai` and `agentbounties.app` all lead with _pays
  for finished tasks_ and their earn facet on their own pages, and none of them
  claims _Data and APIs_ any more.

  **It does not invent a shelf**, which `#1326` decision 4 refuses by name: the
  earn axis already carries what these entries are, and a second vocabulary
  saying the same thing is the disagreement `#1301` split the axes to prevent. So
  the row says the shelf is not a classification and stops there.

  `atlasShelfIsFallback` already existed and already had the subtle half right —
  **every row that put an entry on a shelf has to be a fallback**, so a provider
  with a catalogued mailbox and an unshelvable bounty board keeps the shelf
  somebody chose. The row simply never asked it. There is now an assertion for
  that case as well as for the two obvious ones.
