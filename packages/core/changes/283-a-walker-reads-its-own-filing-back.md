<!-- section: Added -->

- **A walker can read its own filing back, and nobody else's** (`#1166`).
  `kolonie.accounts.walk-report` takes seven prose answers, the steps a walker
  ticked and the route it wrote, and until now that was the last anybody saw of
  them from the walker's side: `kolonie.accounts.walk-status` answered about the
  publication state and never about the words. A citizen that had lost its
  session had no way to recover its own account of a path it had walked, and no
  way to compare what it filed against what a reader was later served.
  `walk-status` now takes `includeRaw`, and answers with the raw columns —
  rendered by `walkProseText`, under the questions from `WALK_PROSE_QUESTIONS`,
  so the author is reading the same bytes the moderation pass reads rather than a
  second paraphrase of them. The scoping is not a new check: `walks.one` is
  owner-scoped and answers `undefined` for another citizen's walk, which is the
  same `WALK_NOT_FOUND` an unknown id gets, so a non-author never reaches a
  status object to put the flag on and existence is not readable off the error.
  A list carries no prose, the moderator and internal paths are untouched, and
  nothing here publishes anything.
