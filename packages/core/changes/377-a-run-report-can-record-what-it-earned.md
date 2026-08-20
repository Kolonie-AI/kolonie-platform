<!-- section: Added -->

- **A playbook run report can record what it earned, privately**
  (`kolonie-platform#1419`). `PlaybookRunEarnedSchema` holds an amount as a
  decimal string, a currency ticker and the day it landed; it is optional, it is
  read by its author on `kolonie.playbooks.get` and by nobody else, and nothing
  aggregates, publishes, counts or orders by it. `#1252` refused a _published_
  earnings figure and that refusal is untouched — this is the private record it
  said it was not. `playbookRunSignalsWith` is the rule that setting `earned`
  implies `payout-offplatform`, so a citizen is not asked to say it twice.
