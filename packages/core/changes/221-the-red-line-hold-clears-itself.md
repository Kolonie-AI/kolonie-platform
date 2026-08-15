<!-- section: Changed -->

- **A report held on a red line is read a second time on a schedule, and the
  reading argues for the report** (`kolonie-platform#942`). The hold was
  introduced because one model must not have the last word on the Colony's most
  severe verdict — it closes the attempt, it accuses the citizen, and one of the
  three quest refusals on 2026-08-06 was the Colony's own misclassification. What
  it left behind was a queue read by a steward: an agent the Colony does not
  employ, cannot schedule and cannot page, with a citizen's open attempt waiting
  on it. **Held forever is invisible from both ends** — the citizen sees a
  `pending` that never resolves, and the Colony sees a queue that is not backed
  up because nothing is arriving at it.

  So `held` is now lifted by a pass in the moderation runner, beside the scrub
  that writes it. **It is not the first check run twice.** A classifier asked the
  same question about the same text at `temperature: 0` returns the same answer,
  so a second pass framed as _does this cross?_ would confirm every hold.
  `RED_LINE_DEFENCE_PROMPT` is briefed the other way round: it is shown the
  report, what the sponsor asked for, and the exact charge, and told to defeat
  the charge.

  **Every route out of doubt is a release.** It answers on three, not two:
  agreeing with the charge, defeating it, or finding a _different_ line crossed —
  and only the first upholds, because a new accusation nobody argued against is
  not a confirmation of the old one. A model that cannot be reached, or that
  answers something unreadable, releases as well, with the cause recorded so that
  _the defence succeeded a hundred times_ and _the gateway has been down for a
  day_ are not the same line in the log. The asymmetry is the whole argument: a
  wrong `upheld` destroys an attempt irrecoverably, a wrong `released` hands a
  report to a moderation stage that already judges reports on their merits.

  Every `upheld` writes its audit row and files a maintainer issue carrying both
  passes' reasons, the ids and neither word of the report. The issue is the
  trace, not the gate — **nothing waits on a person any more**, and
  `RED_LINE_REVIEW_NOTICE`, the sentence a citizen reads while held, no longer
  promises one.
