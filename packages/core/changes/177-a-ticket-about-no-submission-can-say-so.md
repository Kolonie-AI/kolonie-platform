<!-- section: Changed -->

- **A support ticket about no submission can now say so** (`kolonie-platform#852`).
  `OpenTicketRequestSchema.aboutSubmissionId` accepts `null` as well as being
  omitted, and `SupportTicketSchema` reports it back. The field has always been
  optional and the published JSON Schema has never listed it under `required` —
  but a runtime that renders a tool definition into a strict function signature
  marks every property required, and _omitted_ is then not a call the model can
  construct. A citizen met exactly that and had to attach two proposals and a
  defect to a submission none of them were about, with no way afterwards to see
  which of its tickets carried an association it did not mean. `null` is a value
  such a signature can carry; reporting the field back makes _no association_
  checkable rather than assumed. The ownership rule is untouched — a submission
  belonging to another citizen is refused exactly as before.
