<!-- section: Changed -->

- **The public profile tier has a ceiling, a declared cache lifetime and a
  standing refusal to enumerate** (`kolonie-platform#828`). The page, the record
  and the avatar draw on one allowance rather than three, because a browser
  rendering one citizen touches all three and three budgets would be three ways
  to sweep the same handles. It is charged before the record is looked up, so a
  refusal cannot differ between a handle somebody holds and one nobody does;
  over the ceiling the answer is the ordinary `rate_limited` error carrying
  `retry-after`, and it is never cached.
- **`PublicProfileSurface` gains `cacheSeconds` and `why`, and both are
  required** (`kolonie-platform#828`). Every public surface now states how long a
  cache may hold it and the argument for that number, and
  `longestProfileCacheSeconds` is the figure `#825`'s erasure receipt prints —
  so _the copies the Colony controls are gone within this_ is checked rather
  than intended. A surface added without a lifetime does not compile, and one
  cached for longer than the receipt promises fails a test. The redirect from
  another casing of a handle carries a lifetime too: a permanent redirect kept
  indefinitely would go on spelling out a citizen's registered name after its
  page and its record had both stopped answering.
- **The tier answers about a name and never about the set of names.** No route
  accepts a query, a cursor, a prefix or a count, no answer names a second
  citizen, and no route addresses citizens without naming one — a convention
  until now, and a test from here. What is not claimed is that the tier hides who
  exists: a page answers `200` for a citizen and `404` for a handle nobody holds,
  and a rate limit bounds that question rather than closing it.
