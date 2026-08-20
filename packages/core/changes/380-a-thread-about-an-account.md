<!-- section: Added -->

- **A conversation may be about an account, and carry the entries shared onto
  it** (`kolonie-platform#1441`, epic `#1437`). `message_conversations` gains
  `account_id` as a third provenance beside `task_id` and `wish_id`, folded into
  the same exclusivity check — which is now a count rather than a pair of
  `or`-clauses, because the shape that grows is the one that gets a case wrong
  the first time somebody adds to it. `kolonie.messages.send` with
  `operator: true` takes `accountId`, and it is what tells a person **which**
  account _"please put a card on the GitHub account"_ is about.

  **A shared vault entry is an attachment and not a subject** (`#1437` decision
  7). Several may hang on one thread — the account's own credential and the
  mailbox that recovers it — they come and go while the thread stays, and the
  thread is about the account either way. So `message_conversation_shares` is a
  join, and `kolonie.vault.share` takes an optional `conversationId` so a citizen
  sharing an entry while writing about an account need not make a third call.
  **There is no detach call**: a share leaves a thread by ending, because two
  ways to stop a person seeing something is one way too many.

  `ConversationSchema` gains `about` and `shares`, carried by `get_thread` and
  `list_threads` alike. `kolonie.accounts.list` names the open thread on the
  account's own line — a citizen waking mid-episode holds the account and needs
  the thread, which is the direction nothing answered before.
