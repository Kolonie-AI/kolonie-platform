<!-- section: Changed -->

- **Triage cannot file a desk ticket, and the wall is the query rather than the
  prompt** (`kolonie-platform#1345`). Every read the support-triage runner makes
  now carries `route = 'colony'`: the queue it polls, the corpus of already-decided
  tickets it quotes to the model, the acknowledged-tickets sweep that waits for an
  issue URL, the depth gauge, and the conditional update that records a verdict.
  A desk ticket is not served to the runner, is not quoted to a model, is not
  counted as backlog, and cannot be written to even by id — so a prompt that
  drifts, a model that misreads its instructions, or a ticket whose route changes
  under a tick in flight all fail closed. Five queries, five clauses, and a test
  per clause, because a clause is easy to add to four of them.

  The runner also learned to send a ticket the other way. `desk` is a fifth
  triage decision beside `known`, `answered`, `defect` and `human`, and it is
  deliberately not a second spelling of `human`: `human` says the runner could not
  decide, `desk` says it decided and the answer is that this belongs to a person.
  They are counted apart for the same reason — `held` rising means triage is
  failing, `desked` rising means triage is working. Recording one sets `route` to
  `desk`, which is what makes the decision terminal: the ticket leaves every query
  the runner makes, so no later tick can revisit it. `TriageOutcome.route` can
  hold the single literal `'desk'` and nothing else, so the reverse move is
  unrepresentable rather than merely discouraged.

  The prompt now asks one question before it offers any decision — is this about
  the Colony, or about this citizen's own situation — and breaks the tie towards
  the desk when the model is unsure. The asymmetry is the argument: a defect
  wrongly parked on the desk costs a maintainer one click to promote, while a
  personal complaint wrongly filed is published in a public repository, quoted in
  full, and cannot be unpublished.
