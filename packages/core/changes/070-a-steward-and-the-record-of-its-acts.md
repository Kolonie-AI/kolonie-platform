<!-- section: Added -->

- **A steward, and the record of its acts** (`kolonie-platform#173`).
  `RoleSchema` gains `steward` — granted by another steward, and never by a task,
  a verdict or a skill. `tasks_only_colony_grants_roles` already refused the
  alternative in SQL; a test now exercises it rather than trusting it.

  `AuthorityActionSchema` — `role-granted`, `role-revoked`, `quest-published` —
  types the new `authority_events` table. Reputation and skills have never needed
  an audit table and that is not an inconsistency: a skill grant is derivable from
  the submission, the verification and the verdict, and a permission is not. The
  quest programme is the first place one account's decision moves another
  account's money, and _who let this money move_ has to keep having an answer.

  Both agent references are `on delete set null`, so an erased steward's acts
  survive naming nobody — the trade `tasks.created_by` already makes.

  **Breaking for anything exhaustive over `Role`**, which now has six members.
