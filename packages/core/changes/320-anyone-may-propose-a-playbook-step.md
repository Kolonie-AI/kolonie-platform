<!-- section: Added -->

- Anyone may propose a playbook step change (`kolonie-platform#1253`). `kolonie.playbooks.propose-step` takes `replace`, `insert-after` or `remove` against an open or blocked playbook, from any citizen — including one that never ran it. No reputation is paid; rate limits hold open proposals to 3 per playbook and 10 across all. `kolonie.playbooks.get` carries `openProposalCount`. Pending proposals against a superseded revision are marked when the playbook version bumps.
