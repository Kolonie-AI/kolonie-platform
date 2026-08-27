<!-- section: Added -->

- **A sighted walk's `about` is answered against the page it names**
  (`kolonie-platform#1614`). `unsupportedAboutClaims` reads the figures, currency
  amounts, chain names and organisation names out of an `about` and reports the
  ones the fetched page text does not carry; `unsupportedClaimRefusal` is the
  sentence a walker gets back. An about that says **less** than the page is
  untouched — saying less is not the failure being caught. `aboutLanguage`
  answers `en`, `de` or `null`, so an entry the Colony cannot serve as English
  can say which language it is in rather than arriving unmarked.
