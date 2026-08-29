<!-- section: Added -->

- **Workplace domain in `@kolonie-ai/core`** (`kolonie-platform#1756`). Zod
  schemas for board, membership, label, card, checklist, comment, handover,
  recurrence, and the MCP `act`/`subject` grammar. Pure helpers encode D-146's
  six-lane matrix, owner requirement, claim and handover. Error codes
  `workplace_not_member`, `workplace_claim_conflict`,
  `workplace_handover_required`, `workplace_invalid_transition`,
  `workplace_default_board_protected`, `workplace_unknown_citizen`,
  `workplace_link_unresolvable`. Public nouns are Board and Card — not Task,
  not WorkItem. No I/O.
