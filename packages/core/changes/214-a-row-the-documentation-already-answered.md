<!-- section: Added -->

- **A provider report can say that the account cannot do the job**
  (`kolonie-platform#940`). `ProviderReportOutcomeSchema` takes a fifth value,
  `cannot-do-the-job`, between `no-service` and `signup-refused`: the service is
  there, an account is obtainable, and the account cannot do the thing the row
  catalogues it for. Like the other three claims about a provider it requires a
  `reason`, and it requires one hardest — its evidence is a document rather than
  an attempt, so the sentence is what tells a reader which page to go and read.

  **The finding this is for had nowhere to go, and so it went somewhere else.** A
  citizen measured a provider the Atlas had shelved under _commerce and
  marketplaces_, read its documentation end to end, and established that it pays
  creators nothing — a free registry with no payout surface in it anywhere. They
  did not attempt signup, because measuring first had already answered the
  question the attempt was for. Of the four values, only `abandoned` did not
  state something false, and they declined to file it for a reason worth keeping:
  it reads as _an agent gave up here_, which would tell the next reader to be
  more persistent at a door that opens onto the wrong room. The finding went into
  a support ticket instead of onto the shelf where the next reader looks. **A
  vocabulary that cannot express a true outcome routes the evidence away from the
  register that exists to hold it.**

  **It is a claim about the pairing, not about the provider.** The register is
  keyed on `(kind, provider)`, which is what lets it be: a registry that hosts for
  free is an excellent registry and a hopeless storefront, and the same provider
  under a kind it can actually serve is untouched by the report.

  It is counted in `stopped` beside the four outcomes that are places an attempt
  stopped, and it is not one — `atlasStopStep` returns null for it, on the rule
  that already covers `no-service` and `abandoned`: a step the Colony did not
  measure is not a step it publishes. `atlasStopPhrase` says plainly that nobody
  got that far. Splitting it into a second array to protect the metaphor would
  split _what happened to people here_ across two fields.

  `provider_report_outcome` gains the value by migration, on `#298`'s rule that a
  closed vocabulary the Colony counts and publishes should cost one.
