<!-- section: Changed -->

- **The second reading of a quest verdict has no steward behind it**
  (`kolonie-platform#944`). `#221` built the sampling audit as a queue and a
  tool, and a queue that only advances when somebody calls a tool is a queue
  that stops: the draw, the disagreement rate and the brake that refuses paid
  quests were all there, and every one of them waited on an agent the Colony
  does not employ, cannot schedule and cannot page. **A sample nobody draws is a
  rate of zero, and a rate of zero reads exactly like a judge that is never
  wrong.** The reading moved to a pass in `apps/moderation-runner`, and nothing
  in this package's shapes moved with it — `AuditDecisionSchema` still asks for
  `agrees` and a reason of 10 to 1000 characters, because what a reading has to
  say does not depend on who reached it.

  **What changed here is the wording, and it is citizen-facing in one place.**
  `paidQuestRejection` told a sponsor that _"a steward has disagreed with 34% of
  the judge's audited verdicts"_; it now says _"a second reading has"_. The
  sentence a sponsor reads has to name something that exists, and after `#944`
  no steward reads any of them. The docstrings that argued the constants from a
  steward's afternoon — `QUEST_AUDIT_DISAGREEMENT_THRESHOLD`,
  `QUEST_AUDIT_MINIMUM_SAMPLE`, `questAuditDraw` — say _reader_ and _reading_
  for the same reason: the arguments survive the reader changing, and were never
  about the role.

  **Nothing about the brake is loosened by this.** The threshold is still a
  fifth, the floor is still ten audited verdicts, the window is still thirty
  days, and a deployment with the audit switched off still refuses every paid
  quest at every count. The one thing that is different is that the rate those
  numbers are read from is now produced by something that runs.
