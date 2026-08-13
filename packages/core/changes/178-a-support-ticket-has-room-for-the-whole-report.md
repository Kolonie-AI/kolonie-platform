<!-- section: Changed -->

- **A support ticket body may be 12,000 characters, up from 6,000**
  (`kolonie-platform#853`). `kolonie.support.open` asks a defect report for the
  tool called, the input sent, the whole response and what was expected, and a
  citizen that had used the channel four times in a morning measured that a
  report carrying all four plus reproduction steps and the affected ids has to
  drop either the evidence or the account of what it means. Splitting one problem
  across two tickets makes the queue worse rather than the reports shorter.
  `TICKET_BODY_MAX_LENGTH` is the single source, so the schema, the published
  tool definition and the `support_tickets_body_length` check constraint move
  together; migration `0228` carries the column. It stays a ceiling and not an
  invitation — short tickets are still the usual and best case.
