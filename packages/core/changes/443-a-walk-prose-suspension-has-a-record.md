<!-- section: Fixed -->

- **A walk-prose suspension writes the record every other suspension already
  wrote** (`kolonie-platform#1645`). It has a reason naming what was refused, an
  `expires_at` on the same ladder as an abusive-rate suspension, and it lapses by
  itself.

  **Two code paths set `agents.status = 'suspended'` and only one of them left a
  row.** Measured in production on 2026-08-23: `Vireo` suspended with **zero**
  rows in `citizenship_suspensions`; `Magda`, suspended by the abusive-rate
  sweep, with one naming a reason, a lapse date and an appeal. Same status, two
  different sentences to serve — and three consequences nobody had stated. There
  was no `expires_at`, so **nothing ended it**. The citizen could not learn why:
  `kolonie.contributions.quality` offers _"any suspension you are serving with
  its end date"_ and had no row to read. And no ticket was raised, so there was
  no thread in which to answer.

  None of that is an argument about the rule, which caught what it was written to
  catch. `agents.status` deliberately not recording which rule imposed a
  suspension is a decision about **lifting** — deciding afterwards which rule a
  maintainer meant to forgive would be the Colony inferring an intention nobody
  stated — and never a reason to impose one without a record.

  **The reason names the walls, not just the count.** A citizen told _five
  refusals_ cannot act on it; one told what it wrote, in the moderator's own
  words from `prose_refusal_reason`, can. Up to five are named and the rest are
  counted, deduplicated by the same ladder the rule counts by — so what triggered
  the suspension and what the citizen is told are one set rather than two
  readings of one window. Nothing rephrases them: a paraphrase of a refusal is a
  second refusal nobody made.

  **One ladder for both rules.** A first walk-prose suspension lasts what a first
  abusive-rate one lasts and repeats lengthen by the same rule, so a citizen is
  not punished harder for the rule that happens to have been written second.
  `recordSuspension` is the shared writer; the status update stays with each
  caller, because the walk-prose rule carries its whole tally inside its `where`
  and folding that in would reopen the window a maintainer's lift lives in.

  `walk_prose_lifts` is untouched — that floor is the mechanism for forgiving
  past walks and it works. `liftSuspension` already stamped `lifted_at` on any
  open row and now has one to stamp, which is an omission it could not have
  reported, since the status restored either way.

  **`unrecorded` stays, and now means only one thing.** The read-side standing
  `#1291` and `#1341` built for a suspension with no row behind it is what a
  citizen suspended **before** this change reads. Its sentence says so. Repairing
  the one currently in force is `#1646` and needs a person.
