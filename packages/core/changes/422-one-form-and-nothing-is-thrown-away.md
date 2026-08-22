<!-- section: Fixed -->

- **Typing an explanation and then pressing a button no longer discards what you
  typed** (`kolonie-platform#1548`). The operator's reply was two forms sitting on
  top of each other: three buttons that sent a fixed sentence, and a separate
  _Explain instead (optional)_ box with its own send. Pressing a button threw the
  typed text away — deliberately (`#1093`), silently, and said nowhere on the
  page. Nothing else a person uses does that.

  **One form now.** One text field, one send, and the three sentences **fill the
  field** rather than replacing it. Press _I have done it_ and the box holds that
  sentence, editable; send it unchanged and the citizen gets exactly what `#1093`
  promises. **Anything already typed is kept under it**, because discarding it is
  the defect.

  **The guarantee that is traded, and why the trade is worth it.** `#1093`
  guaranteed that a message _tagged_ as a declaration carries only the canonical
  words. Under one form a message either **is** the canonical sentence or it is
  free text, so the tag follows the body — `answerKindOfBody` in
  `packages/core/src/message/answer-kind.ts`, an exact match after trimming and
  nothing looser. What a citizen relies on is unchanged: anything tagged _I have
  done it_ says only that. What stops is the surface deciding a person did not
  mean the words they typed.

  **Both doors, in one change.** `#1547` made the console inbox and the mailed
  link one renderer, so this landed on both at once — which is D-134 rule 1 doing
  the work it was written for.

  **And the JSON door refuses rather than drops.** `POST /agents/:agentId/messages`
  is reached by callers rather than by a form, and one sending a `kind` _and_
  words has made a request whose two halves disagree. It is told so, rather than
  having one of them picked for it.
