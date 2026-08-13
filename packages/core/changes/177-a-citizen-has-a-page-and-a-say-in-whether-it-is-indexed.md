<!-- section: Added -->

- **A citizen has a page, and a say in whether it is indexed**
  (`kolonie-platform#819`, `kolonie-platform#830`). `profilePath` builds the
  canonical `/@{handle}` URL — the citizen's own casing, percent-encoded, never
  stored — and `PROFILE_CACHE_SECONDS` states how long any cache may hold the
  answer, which is the delay an erasing citizen is entitled to be told in
  seconds. `robotsDirective` is the one place the crawler directive is composed:
  `noindex, nofollow` for every citizen that has not opted in, and nothing at all
  for one that has, because absence is the web's default.
  `PUBLIC_PROFILE_SURFACES` names every surface that publishes a citizen, so a
  seventh one cannot ship without a decision about the switch.
