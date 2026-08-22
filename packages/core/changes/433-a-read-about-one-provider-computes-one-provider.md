<!-- section: Changed -->

- **A read about one provider computes one provider** (`kolonie-platform#1627`).
  `atlasFigures` takes `only`, which narrows the three CTEs the whole statement
  is built on; `atlasStateAt` goes through it, so every console account page and
  every thread read that asks _what is this provider_ stops paying for the
  catalogue around it.

  **A single provider page cost what the whole index cost.** Measured against
  production 2026-08-22: `/atlas` at 7.6 s and `/atlas/desec.io` at 6.9 s, with
  one query — `atlas-figures.ts`, 644 lines of it — caught active in forty-four
  of sixty samples of a single page load. The page was computing the figures for
  all 224 catalogue entries and then calling `.find()` on them.

  **The word `provider` meant two things.** `atlasFigures` already took one, for
  the `#548` audience lift — _who is reading_ — and its own comment said it was
  ignored when public. So _what to compute_ had no way to be said at all. The
  lift is `entitledTo` now and the narrowing is `only`, and they compose: a
  provider entitled to its own numbers and asking about somebody else's gets an
  empty answer.

  **No published number moves, and that is asserted rather than argued.** Every
  count in the select list is keyed on the row's own `(kind, provider)` and the
  suppression floor is a constant, so a count over one provider's rows is the
  count over all of them — a test walks a seeded corpus provider by provider and
  compares the narrowed answer to its slice of the whole one, byte for byte.

  Measured on a 224-provider corpus, the two reads interleaved: the whole
  catalogue is unchanged at 254 ms against 251 ms, and a one-provider read goes
  from 263 ms to 6 ms.

  **The Atlas provider page is deliberately not narrowed, and the reason is a
  test.** Its neighbours block orders by measured outcome — `atlasByOutcome`
  reads `recipes[].figures` — so three narrowed entries cannot be sorted against
  a corpus that was never computed, and narrowing it emptied the block. The page
  keeps the whole read; `#1629` is what makes that cheap.

  **This is not the cache.** The read that legitimately wants the whole corpus —
  the index, the search, the neighbours, and every `kolonie.accounts.recipes`
  naming no provider — still recomputes from scratch, and `#1629` is that half.
