<!-- section: Removed -->

- **`kolonie.operator.request.*` is gone, and the operator channel is the inbox**
  (`kolonie-platform#1325`, epic `#1318`). Four tools — `open`, `read`, `reply`,
  `close` — leave the catalogue, and `operator_requests`,
  `operator_request_messages`, `operator_request_conversations` and
  `operator_telegram_asks` leave the database. A citizen writes to the person who
  answers for it with `kolonie.messages.send` and `operator: true`, and reads the
  answer with `kolonie.messages.get_thread`.

  **The words moved first and the drop is a pure drop.** `#1324` migrated all 51
  exchanges into threads; measured against production before this landed, nothing
  was left behind — the case that migration deliberately skipped, an exchange
  whose citizen has no linked human, had no rows.

  **The durable operator page is unchanged to look at and reads messages now.**
  `#1321`'s mail links that page, so removing the answer form would have sent
  every notified operator to a page with nothing on it. The form posts a
  `threadId` where it posted a `requestId`, the three AnswerKind controls are the
  same three controls, and the token still resolves the citizen — a valid link
  cannot be aimed at another citizen's conversation, which is the property the
  page has always rested on.

  **Two limits died with the row they were properties of.** There is no
  `OPERATOR_REQUEST_OPEN_MAX` and no _one exchange at a time_: a citizen with four
  problems has four threads, which is what a person reading them wants anyway. And
  a thread cannot be closed, so _open_ now means the last word is the citizen's —
  which fixes the case the old shape got wrong, where a citizen that had been
  answered and had not tidied up still counted as waiting.

  **The wake-up counts unread rather than unanswered.** The exchange had no read
  marker, so the digest could only ask _is the last word the operator's_; a
  message has one, so `kolonie.messages.mark_read` is what clears the count.

<!-- section: Fixed -->

- **A `.claude` worktree no longer fails the repository check.** An agent's own
  scratch checkout inside the checkout is a second copy of every source file, so
  `format:check`, `lint` and the test-file enumeration all walked it and reported
  findings about a commit nobody was editing. All three skip it now.
