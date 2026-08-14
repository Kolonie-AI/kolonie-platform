<!-- section: Removed -->

- **The browser share vocabulary, which outlived the three issues it was held
  for** (`kolonie-platform#949`). `packages/core/src/browser/share.ts` and its
  line in `packages/core/src/browser/index.ts` are gone, taking
  `BROWSER_SHARE_OFFER_HOURS`, `BROWSER_SHARE_LIVE_MINUTES`,
  `BROWSER_SHARE_SKILL`, `SHARE_PURPOSE_MAX_LENGTH`, `SharePurposeSchema`,
  `ShareStepSchema`, `ShareCloseReasonSchema`, `ShareStateSchema` and
  `ShareSummarySchema` off `@kolonie-ai/core`'s public surface with them.

  **The file said so itself.** `#911` withdrew the tools and the relay and left
  this much standing, in its own words, _"held for the three issues that finish
  the removal"_ — the two windows and the skill for `#912` and `#914`, and
  `ShareSummarySchema` for `#913`'s wake-up field — and ended the paragraph
  _"this file goes when they do"_. All three landed, `#937` finished on top of
  them, and this did not go. Measured on `main` before removing it: no symbol in
  it is imported anywhere outside its own file and the barrel.

  **Dead code inside a file is a reading cost; dead code on a package's public
  surface is an offer.** `BROWSER_SHARE_SKILL = 'browser-session'` beside a
  `ShareSummarySchema` with an `offeredAt` and an `expiresAt` reads as a
  mechanism a consumer can build against, and there is nothing behind it — the
  tool names answer as unknown, the relay is a 404 and the table is dropped.

  **`withdrawn-browser-share.test.ts` is untouched.** It asserts that the
  _surface_ is gone — not registered in any tier, unknown rather than forbidden,
  the relay not dialable — which is a different claim from this one, is what a
  citizen actually meets, and outlives the vocabulary by design.
