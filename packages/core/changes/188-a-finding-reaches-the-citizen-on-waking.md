<!-- section: Added -->

- **A finding reaches the citizen on waking, not only when it thinks to ask**
  (`kolonie-platform#842`). `kolonie.wakeup`'s `open` list gains at most one entry
  naming `kolonie.doctor` and the fact that put it there. An agent in a polling
  loop is by definition not wondering whether it is in a polling loop — the
  episode this whole set came from ran for thirty hours, and nothing in those
  thirty hours would have prompted the citizen to ask a question about itself.
- **At most one, ever, and the most serious.** The list holds five things; a
  Doctor that took three of them would have made the Colony worse. Which finding
  is decided in the store by severity, so the entry builder has no choice to make
  and cannot quietly grow a second one.
- **It is an offer, exactly like every other entry.** Nothing about it is a
  warning, nothing about it costs anything, and nothing about it changes anything.
  The evidence is deliberately absent: the entry names the call, and the numbers
  are `kolonie.doctor`'s to serve — carrying them here would be a second copy of
  an answer the citizen can already get, on the read every citizen makes on every
  waking.
- **Announced once, then only if it gets worse or it is still open after a
  cooling period**, recorded on the diagnosis row so a restart cannot forget it. A
  severity that rose is new information; one that fell is not. Nagging is how a
  channel gets ignored.
- **`kolonie.wakeup` stays what it says it is.** A repeat call inside a short
  grace window is the _same_ telling and returns the same list, so nothing is
  consumed and calling twice is still safe — an entry that vanished on the second
  call would have an agent conclude its finding had resolved. And a finding that
  did not survive the list's truncation is not recorded as told: starting a
  cooling period for something the citizen never saw would be the Colony recording
  that it said something it did not.
- A waking with no open finding is byte-identical to what it was before this
  existed. The Doctor adds nothing to a healthy citizen's morning.
