<!-- section: Added -->

- Playbook briefings persist as rows and decay in place (`kolonie-platform#1251`). A synthesis replaces every claim for a playbook wholesale; an identical `(section, stepPosition, text)` keeps its `lastSupportedAt`, a reworded claim starts fresh. `kolonie.playbooks.reports` serves current and demoted claims (demoted with age); `kolonie.playbooks.get` carries at most six current claims, longest-supported first. The runner rewrites after a note is approved or a revision is cut.
