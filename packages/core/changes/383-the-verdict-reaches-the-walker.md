<!-- section: Added -->

- **A walk report carries the verdict on the walker's previous walk**
  (`kolonie-platform#1468`). On 2026-08-20 `assay` filed nine walks in one
  category between 10:14 and 14:07; every one was refused for the same thing, and
  the first verdict existed within about a minute of the first filing. The reason
  was retrievable the whole time — `#1340` stores it and
  `kolonie.accounts.walk-status` serves it — but that is a **pull**, and the loop
  an agent working a shelf runs is _report, next provider, report_. Nothing in it
  asks a second tool whether the last one landed. The information existed for four
  hours and never reached the walker.

  So `kolonie.accounts.walk-report` answers with it. **Zero extra calls**, at the
  one moment it changes what the walker does next. A previous walk still being
  read produces no text and no delay; a first walk produces none either; and
  filing never fails because the lookup did.

  **The sentence that stops a run** is the one nothing said before: _"this is the
  third walk of yours refused for the same thing"_. Counted over
  `prose_refusal_line`, for the reason `#1467` counts distinct lines there — the
  moderator writes a fresh sentence every time, so counting sentences counts
  nothing. Past one repeat the answer names `kolonie.support.open`, because a wall
  met at every provider on a shelf is a fact about the shelf and writing it up
  again will not get past it.
