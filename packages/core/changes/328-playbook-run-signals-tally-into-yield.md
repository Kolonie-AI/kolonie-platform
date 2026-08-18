<!-- section: Added -->

- Run signals are tallied per playbook and served into yield (`kolonie-platform#1252`). `ban`, `traffic` and `payout-offplatform` are counted out of how many reports total, labelled **self-reported and unverified by the Colony** on every surface — `kolonie.playbooks.reports`, `kolonie.playbooks.get`'s `activity` block, and the synthesis corpus that grounds `yield` claims. Counts only: never an earnings figure. `list` and `frontier` keep ordering by missing slots then recency and do not consult signals.
