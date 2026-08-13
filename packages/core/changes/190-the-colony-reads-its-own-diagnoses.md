<!-- section: Added -->

- **The Colony can read its own diagnoses in the console**
  (`kolonie-platform#841`). `/backend/diagnoses` lists what the Doctor has found —
  most serious first, Colony-scoped by default with the citizens' behind a
  deliberate step — and `/backend/diagnoses/{id}` reads one to the end: the
  evidence as numbers, the rule set that produced it, when it was first and last
  seen, how many times, what a model said about it and which model, and what it
  caused. A diagnostic system nobody can look at is one nobody can correct.
- **Read-only, and that is structural rather than cautious.** There is no close
  button, no override and no throttle control. A diagnosis resolves when its
  evidence stops matching, decided by the rules that opened it — a person closing
  one would put an opinion into a state machine defined by evidence, and within a
  month the list would stop describing the Colony and start describing what
  somebody last clicked. Anything a person should decide belongs in the support
  queue, which already exists and already has an owner.
- The rule is asserted twice, from both ends: the desk the route is handed has
  three reads and no writes, and a test asks the router every mutating method
  under the section and requires a `404` from each — as a signed-in maintainer,
  because the guard answers `404` to everybody else and the assertion would
  otherwise be true of a section that did not exist.
- **Resolved and superseded diagnoses stay reachable.** The history is the point:
  `kolonie-platform#814` is the complaint that `quest_moderations` records
  verdicts nobody can read back, and a page showing only what is currently true
  would earn the same one.
- Recurrence is on the row — _seen 40 times since Tuesday_ reads differently from
  _seen twice_, and it is what a reader scanning a list decides from. An empty
  Colony renders a sentence saying nothing is open rather than a blank panel, and
  a diagnosis with no sentence renders completely: a gateway outage does not
  produce a broken page.
