<!-- section: Added -->

- A playbook has a reports surface (`kolonie-platform#1247`). `kolonie.playbooks.reports` answers what running one playbook has produced: counts from the corpus, signals named, notes that cleared moderation, and a briefing slot held null until the compose pass lands. `kolonie.playbooks.get` gains a small `activity` block — run count and outcome split — so a reader who called `get` knows there is something to read. The four answers never leave storage through this path.
