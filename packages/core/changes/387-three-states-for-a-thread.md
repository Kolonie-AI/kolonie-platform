<!-- section: Added -->

- **Unread, archived and muted are three states on three columns**
  (`kolonie-platform#1449`, epic `#1447`). `done_at` on `message_participants` is
  the one this adds; `muted_until` was already modelled and used by nothing, and
  `last_read_message_id` is `#1448`'s. Folding archive into mute would mean a
  person who silenced a chatty thread also lost it from their list — two
  intentions wearing one column.

  **Archiving is not deleting**, and a message from anybody else clears it — in
  `insertMessage`, so every send path gets it and there is no way to write a
  message that leaves a thread archived under somebody who has just been written
  to. It does **not** un-mute: mute survives exactly the event archive does not,
  which is the whole reason they are separate. The sender's own row is left
  alone, because a person who archived a thread and then answered in it has not
  changed their mind about being finished.

  **Archiving does not mark read**, and reading does not archive. Somebody who
  archives an unread thread has decided not to read it.

  **The agent is never told either.** It is a fact about a person's attention
  rather than about the conversation, and an agent that learned it had been muted
  would reasonably open a second thread — which is exactly what muting was for. A
  test asserts neither word reaches `kolonie.messages.list_threads` or
  `get_thread`.

  The list switches between open, archived and all: one predicate over one
  column, not folders. A folder is a place a thread is _in_, which would make
  archiving a move and finding it again a second one.
