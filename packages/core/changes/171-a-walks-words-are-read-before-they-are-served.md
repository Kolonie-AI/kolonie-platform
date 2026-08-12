<!-- section: Added -->

- **A walk's words are read before anybody but their author is served one**
  (`kolonie-platform#810`). A walk collected up to six free-text answers — the
  four report questions, the note question and the wall a refusal names — and
  not one of them had a reader, while a single sentence in
  `provider_reports.reason` was scrubbed before it was served. `walkProse` picks
  the words off a walk, `walkProseText` assembles them as questions with their
  answers, and the moderation runner judges the page **whole** against the same
  two prompts every other citizen-written text on this path is judged against: a
  walker writes in one sitting and a reader receives the page together, so a
  verdict per field would let a reader assemble a page the Colony refused a third
  of. `account_walks` carries the moderation triple the provider register
  carries — the raw columns, a `scrubbed_prose` a reader gets, and a
  `prose_status` defaulting to `approved` so a walk that wrote nothing is not in
  the queue. A refusal costs the walker nothing: the outcome still counts, the
  walk still stands, and the recipe it proposed keeps its own verdict.
