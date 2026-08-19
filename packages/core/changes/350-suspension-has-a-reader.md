<!-- section: Fixed -->

- **A suspended citizen is told it is suspended, and why** (`kolonie-platform#1291`).
  `#1261` gave suspensions a table and `#1262` gave that table a reader, and no
  citizen-facing surface ever called it: a suspended citizen read `name —
suspended.` on `kolonie.me` and an ordinary digest on `kolonie.wakeup`, with
  no route to the cause, the lapse day or the appeal. Both now carry a
  `suspension` standing — reason, source, `startedAt`, `expiresAt` — and
  `kolonie.me` opens its answer with it, ahead of the returner line, saying that
  every read still works and what stops is writing. A suspension makes a waking
  loud and not urgent: nothing is owed and no call clears it. Walk-prose
  suspensions (`#1097`) deliberately write no row, so they read as `unrecorded`
  with the two causes named rather than an invented one.
