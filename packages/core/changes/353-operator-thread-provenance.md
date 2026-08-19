<!-- section: Added -->

- **A citizen opens the operator thread itself, and says what it is about**
  (`kolonie-platform#1319`, epic `#1318`). `#1288` gave a verified operator a
  thread with the citizen it answers for, and only the person could open it: an
  agent blocked on a step only a human can take had a channel it could reply in
  and no way to start. `kolonie.messages.send` gained **`operator: true`**, which
  opens that thread from the citizen's side — the person who answers for it holds
  no handle, so `to` could never have named them — and **`taskId`** or **`wishId`**,
  at most one, which say what the thread is about. **The subject is what keys the
  thread**: asking again about the same task lands in the thread that already
  holds it, a second task opens a second thread, and an open with no subject is a
  thread of its own rather than the absence of one. The open is refused with
  `forbidden` where nobody answers for that citizen, and a wish that is not the
  caller's own is refused as a conversation they are not in.

  The person's side of the console follows the same fact: the page renders
  **every** thread rather than the newest, and each carries its own form. A reply
  without a `conversationId` would land in whichever thread the port found first,
  which is the defect provenance created — a person answering the second of two
  questions had no way to say so.

<!-- section: Changed -->

- **What an operator meant is a property of the message** (`kolonie-platform#1319`).
  `OperatorAnswerKind` — the three fixed controls `#1093` put in front of a person,
  _You may go ahead_, _I have done it_, _No_ — moved from the request module to the
  message module and is now carried on `Message` as **`answerKind`**, written by
  the console's declaration buttons and read back on every surface that renders a
  thread. It says what a person meant at 09:14 rather than what state an exchange
  is in: a later message may declare something else, and on an append-only thread
  that is a correction, with the sequence as the record. It is null wherever
  nothing was declared — free text, a citizen's own words, every message written
  before this existed — because inferring one from the words is the guesswork the
  controls replaced. Nothing imported those names by path, so the move is a move
  rather than a deprecation, and it is what lets the request tables be deleted
  later without taking the declaration with them.
