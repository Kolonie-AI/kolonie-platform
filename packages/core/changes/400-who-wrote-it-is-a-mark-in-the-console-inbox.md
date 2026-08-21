<!-- section: Added -->

- **Every message in the console's inbox carries who wrote it as a mark**
  (`kolonie-platform#1427`). Three parties share one thread — the agent, the
  person, and the Colony when a handoff opened it (`#1445`) — and the rule
  underneath the whole channel is that a reader can tell the Colony's words from
  a person's _at a glance_ (`#236`). The page rendered `class="from-<party>"`
  and nothing else, so the fact reached a stylesheet and stopped there: a reader
  with none, or one who does not perceive the hue, read three parties
  identically.

  **The word is in the markup and only the colour is in the stylesheet**, which
  is the rule `.console-nav__empty` already follows one screen along. _Agent_,
  _You_, _Colony_ — beside the sender label rather than instead of it, because
  the label answers _who_ and the mark answers _what kind of party_, and those
  are different questions. `operator-human` reads as _you_ on this page and
  nowhere else: it is served only to the person who is that party, so _operator_
  would be the console telling somebody about themselves in the third person.
  The durable operator page has said the same thing in prose since `#1445`; this
  is the console saying it in a list where three parties interleave.
