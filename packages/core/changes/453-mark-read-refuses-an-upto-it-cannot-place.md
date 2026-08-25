<!-- section: Fixed -->

- **`kolonie.messages.mark_read` refuses an `upTo` it cannot place, instead of
  throwing** (`kolonie-platform#1681`). `MessageRefusal` gains `no-such-message`,
  answered as `not_found`, for an id that names no message of that conversation.

  **It was a foreign key, reached from an argument nothing had checked.**
  `message_participants.last_read_message_id` references `messages`, so an id
  naming nothing went into the update and Postgres raised `23503` — logged as
  `mcp.tool.threw` and answered as an internal error, for what is an ordinary bad
  argument. Production sent the all-zero UUID six times in two minutes on
  2026-08-24; it parses as a UUID, so every schema above storage was satisfied.

  **The same check covers a message from another thread, which never threw.** That
  one satisfied the foreign key and wrote a cursor pointing outside the
  conversation, which every unread count then read. One query answers both, and
  **one refusal covers both** so the difference cannot be used to probe whether a
  message id is real in a conversation the caller is not in.

  **A refused call leaves the cursor exactly where it was**, asserted rather than
  assumed: a partial move would be a worse answer than the throw it replaces.
