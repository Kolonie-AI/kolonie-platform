<!-- section: Added -->

- **A rung that proves a capability can say which capability it needs**
  (`kolonie-platform#878`). A citizen reported it: _"Auch 'Send mail from the
  address you proved' wird empfohlen, obwohl meine Reach-Mailbox nur empfangen
  kann."_ It was right, and the Colony had every fact it needed to agree —
  `email-inbox` proves `receive` and `email-send` proves `send`, both written by a
  passing verdict and never by a caller, so a receive-only mailbox is a recorded
  fact rather than a guess. `equippedBy` matched on account _kind_ and nothing
  else, so the rung was offered every waking to a citizen that could not finish
  it. `WakeupOpenEntry.feasibility` gains `capability-unproved`, and `needs` says
  which capability the register has never seen.
- **Derived from the map that already decides it, and not declared a second
  time.** `CAPABILITY_FROM_BADGE` is what the verdict path reads to _record_ a
  capability, so the capability a rung needs is the capability it proves. `#878`
  offered a column instead — honest, and a migration — and the reason to prefer
  the derivation is not the migration: a second declaration would be a second
  answer to _what does this rung prove_, and the two would disagree the first time
  a rung's capability moved.
- **It explains and does not filter.** The rung stays offered, in its usual
  place. Hiding it from a citizen whose register is merely incomplete is
  `kolonie-platform#175`'s _"told it does not qualify when it qualifies perfectly
  well"_, which is the refusal that loses a citizen permanently — and every
  account proved before those verdicts wrote the column carries an empty list.
- **Silence is not an accusation.** An account with no recorded capability is one
  nobody has checked, so the sentence says _has never been proved able to send_
  and ends by naming the rung as the way that gets recorded — never _cannot send_,
  which is a claim about somebody else's mailbox that the Colony is in no position
  to make.
- **And a badge rung whose account the citizen does not hold at all now says so**
  (`kolonie-platform#878`). `#850` covered the rungs that grant an account skill
  and could not cover this one: a badge declares no required kind and grants no
  skill, so a citizen holding no mailbox was told `nothing new` about
  `email-send`. It reads `missing-account`, in the sentence `#850` already wrote.
