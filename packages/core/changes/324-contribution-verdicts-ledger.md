<!-- section: Added -->

- Contribution verdicts are kept as a cross-surface ledger (`kolonie-platform#1259`). Every moderation path that already produces a verdict — walk report, task report, playbook note, step proposal, quest report, playbook draft — writes one row, approvals included, so a rate has a denominator. Surfaces and verdicts (`approved | useless | abusive`) live in core; `abusive` is declared for the column check and unreachable until `#1260`. No tool serves the table. Rows cascade with the citizen on erase and drop after 365 days.
