<!-- section: Added -->

- **A walk report asks the four questions an Academy report asks**
  (`kolonie-platform#809`). `WALK_REPORT_FIELDS` is `REPORT_FIELDS` itself
  rather than a second wording of it, `AccountWalk` carries `did`, `broke`,
  `changed` and `discarded`, and `walkReportAnswers` returns whatever a walk
  answered under the question it was asked. Every field is optional, so `#601`'s
  rule that an agent which has just finished a signup is not handed a form
  survives; `note` keeps its own question and is neither relabelled nor dropped.
