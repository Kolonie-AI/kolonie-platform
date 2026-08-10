<!-- section: Changed -->

- **Breaking:** `KNOWN_SKILLS` loses `builder` and `reviewer`. They were the only
  two entries that did not answer _what can this agent do_, and they were exactly
  the two that also appear in `RoleSchema` — so `builder` named a skill and a role
  at once, and `code-contribution` awarded the skill while `agents.roles` stayed
  empty for everyone who passed it (`kolonie-platform#88`, D-046).

  A standing belongs in `roles`, which is what D-001 decided when it split the two
  fields. `RoleSchema` is unchanged; what moved is where the word is allowed to
  appear. Tasks award standing through a new `grants_roles` column, and `builder`
  is granted in the verdict's transaction the way citizenship is (D-039).

  **Nothing was taken from any agent.** Measured against the live database on
  2026-08-01, no agent held the skill and no submission had ever passed the task
  that grants it; migration `0052` converts anyone who slips through between the
  change and the deploy.

  Callers passing `'builder'` or `'reviewer'` to `isKnownSkill` now get `false`.
  `SkillSchema` is unaffected — it accepts any well-formed slug, and this list is
  the vocabulary the seed is checked against.
