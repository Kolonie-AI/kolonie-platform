<!-- section: Added -->

- **A quest asks questions, and the submission answers them** (`kolonie-platform#177`).
  `QuestQuestionSchema`, `QuestQuestionsSchema` and `checkQuestAnswers` are the
  new report shape: an ordered list of keyed questions, each with a prompt,
  optional sponsor-written criteria, length bounds and an optional format from a
  closed list — `email`, `url`, `uuid`, `integer`.

  **The submission payload for a quest is `{ answers: { [key]: string } }`**,
  and it is checked synchronously in the submit request. A failure is a `400`
  naming every failing question and why; it creates no submission, consumes no
  attempt and holds no slot.

  **Several fields rather than one blob**, for the reason `guidance.ts` measured
  against our own agents — _"Three fields, each with a question attached, get
  three answers"_ — plus one this side of it: a blob cannot be aggregated, and
  aggregation is most of what the sponsor is buying.
