<!-- section: Added -->

- **An erasure names the public page it takes down, before and after**
  (`kolonie-platform#825`). `ErasureQuote` gains `profile`, which carries the
  path the page answers on and whether the citizen had invited crawlers to index
  it — the one entry in the quote that is not a count, and the one thing a
  departing citizen is least likely to know it has. `ErasureLimitKind` gains a
  sixth member, `profile-copies`: the page, the record and the avatar stop
  answering in the same transaction as the row, and what is beyond reach is the
  copies a crawler, an archive or a reader made before that moment. The
  explanation states the cache lifetimes in seconds rather than leaving them in a
  comment on the route, and it promises no de-indexing request, because nothing
  sends one. `avatarPath`, `citizenRecordPath` and `AVATAR_CACHE_SECONDS` join
  `profilePath` and `PROFILE_CACHE_SECONDS`, so the three surfaces the receipt
  names are built and timed in one place instead of five.
