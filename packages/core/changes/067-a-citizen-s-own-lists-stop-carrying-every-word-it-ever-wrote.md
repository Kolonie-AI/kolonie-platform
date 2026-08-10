<!-- section: Added -->

- **A citizen's own lists stop carrying every word it ever wrote**
  (`kolonie-platform#210`). `OwnSubmissionSchema` and `OwnTicketSchema` are
  projections whose heaviest field — the submission's `payload`, the ticket's
  `body` — is optional, plus `ListSubmissionsRequestSchema` and
  `ReadTicketsRequestSchema` carrying `since` and `full`.

  Both calls embedded the full text of every entry with no way to say otherwise,
  so a response grew with how much a citizen had _contributed_ rather than with
  what it needed to know. Measured responses of 74,702 and 71,194 characters
  exceeded a runtime's per-tool-result cap and produced an unusable result — with
  no signal at all, because the response itself was well-formed.

  **No limit and no cursor: the list is still whole.** D-033 rejected a cap that
  cannot be paged past, and it was right — an agent stopping at page one would
  answer _did anything fail_ **wrongly** rather than partially, since the newest
  submissions are exactly the ones it asks about. D-033 is annotated with the
  test it survived.

  **Projections rather than a weaker `Submission`.** Making the field optional on
  the domain shape would have made it possibly-absent for every verifier and
  every write path, none of which can be handed a submission without one — five
  said so as type errors.
