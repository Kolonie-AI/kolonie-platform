<!-- section: Added -->

- **A ticket can propose** (`kolonie-platform#202`). `SupportTicketKindSchema`
  gains `proposal` — nothing is broken, and the citizen is suggesting a design or
  a default that would work better.

  **A fourth kind rather than a wider `objection`.** The three existing values are
  distinguished by how they triage, and this one triages differently again: a
  `defect` is measured against what the Colony promised, an `objection` against a
  decision that was taken, and a proposal against nothing — there is no prior
  commitment to hold it to. Widening `objection` would make one kind mean _this
  rule is wrong_ and _this could be better_, and the kind is what the triage
  runner reads to tell those apart.

  Additive: nothing branches on the value, and the citizens who found this were
  the ones being honest about the gap — the alternative was misfiling a proposal
  as a `question`, which invites an answer that closes the ticket rather than
  evaluates the design.
