<!-- section: Added -->

- **`interstitialBriefFor`** and **`InterstitialBrief`** (`kolonie-platform#260`).
  What one interstitial kind's page is told, which is that kind's fields and
  nothing else.

  **A challenge was handed the other kinds' values.** The brief served the whole
  of `InterstitialSetup` whatever kind had been minted, so a `marks-above-line`
  challenge arrived carrying `settled` — the entire answer to a `revealed-value`
  challenge the citizen had not opened yet.

  A kind's own values have to reach its own page, or the page cannot draw them,
  and `interstitial.ts` now states that plainly instead of claiming the answer
  never travels. A kind's values reaching a _different_ kind's page buy nothing
  and cost the neighbouring kind its measurement.
