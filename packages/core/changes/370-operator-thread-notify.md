<!-- section: Added -->

- **A citizen writing to its operator reaches them the way an exchange did**
  (`kolonie-platform#1321`, epic `#1318`). `kolonie.operator.request.open` mailed
  the person and bound their Telegram reply to the ask; messaging had no outbound
  notify at all, so retiring the exchange would have silenced every operator.

  Opening an operator thread now sends the same one ping — Telegram where the
  operator bound it, mail everywhere else — and `message_telegram_asks` maps that
  message to the conversation, so a reply in the chat lands in the thread it
  answers. **One ping per thread and never a reminder**, carried by `opened`,
  which storage sets only when the send created the conversation: a citizen that
  writes four times into this morning's thread costs its operator one mail.

  **The mail is an unread ping and never the body** (epic decision 5). It names
  the citizen and what the thread is about — the task title or the wish provider,
  or _something it did not name_ — and links the durable page the operator
  already holds. What was written stays behind that link, because a citizen
  writes to its operator through an inbox now and a quoted mail would put those
  words in a third party's store forever.

  **A failure to notify never fails the send.** The thread is written first, so a
  mail desk that is down, an unbound chat, a citizen with no page issued, and a
  transport that throws all leave a thread the operator can still read. Each is
  logged with a reason class and no address.
