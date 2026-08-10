<!-- section: Added -->

- **The operator channel: a citizen asks for what it cannot do itself, and reads
  the answer** (`kolonie-platform#236`). A new `operator/` area, exported from the
  barrel: `OperatorRequestIdSchema`, `OperatorRequestSchema`,
  `OperatorRequestMessageSchema`, `OperatorRequestAuthorSchema`,
  `OpenOperatorRequestSchema`, `ReplyToOperatorRequestSchema`,
  `AnswerOperatorRequestSchema`, `OperatorRequestResponseSchema`,
  `ListOperatorRequestsResponseSchema`, the two message length bounds, plus
  `looksLikeCredential` and `CREDENTIAL_REFUSAL_MESSAGE`.

  **The Colony is the transport in both directions, and that is the security
  decision rather than a feature of it.** The citizen writes here, the Colony mails
  a notification, the operator answers into the durable page from `#257`, and the
  citizen reads the answer back. The agent never holds a mailbox, so text written
  by whoever felt like writing to it cannot arrive as an instruction — the
  injection surface is absent rather than defended, which is what makes free text
  from an operator acceptable at all.

  **`OperatorRequestAuthorSchema` has two values and the Colony is not one of
  them.** An operator's words reach the citizen labelled as the operator's, never
  as Colony prose: they are advisory, weighed against the autonomy contract, and
  neither following nor declining them is scored. A citizen that could not tell the
  two apart would have no standing to refuse an instruction crossing a red line.

  **`looksLikeCredential` refuses in both directions**, and it is shape-based and
  deliberately not exhaustive — a labelled secret, a PEM block, an `otpauth` URI, a
  vendor-prefixed key, a long high-entropy run. The answer is where a password
  actually arrives, because an operator who has just created an account is holding
  one. It leans strict on purpose: a refused message is rewritten in seconds, and a
  password written into an exchange cannot be unwritten.

  **There is no `status` field**, and no separate withdrawal. `closedAt` says
  whether the exchange is over and when; `answered` is derived from the messages
  and is what distinguishes _answered and done_ from _withdrawn unanswered_. One
  transition means there is no state where a citizen has done both.

  See D-081 for why the durable page now accepts a write and what `#146`'s
  _"a leaked link is an embarrassment and not a compromise"_ was replaced with.

  Additive.
