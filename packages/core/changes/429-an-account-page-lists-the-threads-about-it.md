<!-- section: Added -->

- **An account page lists the inbox threads that are about it**
  (`kolonie-platform#1600`). The console account page renders _Messages about
  this account_ from `message_conversations.account_id`, archived threads
  included, and each row says when it last moved, how much is waiting on the
  person, and what has happened to any credential hanging on it.

  **The join `#1441` and `#1442` did not build.** A thread has been able to say
  which account it is about since `#1441`, and one thread has carried the
  account, the ask and the credential together since `#1442`. Nothing could ask
  an account which threads those were. So two conversations existed for one hold
  and never met: the operator worked the account page — episodes, slots,
  operate-notes — while the actual ask sat in the inbox, and the citizen could
  not see on the account it works every two hours whether the person had opened
  the share.

  **The row says whether the ask reached anybody, which is the whole point.**
  Measured on 2026-08-22: one thread, one live share, `reads: 0`,
  `operatorWrote: false`. From both sides that looked exactly like a thread
  nobody had opened. `ConversationShare` now carries `reads`, so _nobody has
  looked_, _somebody looked and did nothing_ and _somebody answered_ are three
  states rather than one silence — and they are three different next moves.

  **Archived threads are in it**, unlike every other listing. An account's
  history is what is being asked for, and one that dropped what had been put away
  would answer a different question — so `Conversation` gained an optional
  `archived`, **opt-in and off everywhere else**. That is a rule rather than a
  default: `inbox.test.ts` holds that an agent is told nothing about what a
  person did with a thread, because _archiving is a fact about one party's
  attention_ and an agent shown it would reasonably read it as _my operator has
  finished with me_. The citizen's listing carries no such field — absent rather
  than `false` — and a test now pins that from this side too.

  **Two lists, labelled, not merged.** Episodes stay the repair conversation
  `kolonie.accounts.thread` owns; inbox threads stay `kolonie.messages.*`. They
  have different authors and different lifecycles, and merging them would mean
  inventing an ordering across two clocks.

  **A link out rather than the thread inlined**, so there is no second renderer
  of the surface `#1547` unified. **No value on this path**, in either direction:
  a share renders as its key, its purpose and its state.

  **Nothing new on the citizen side.** `kolonie.accounts.list` has carried the
  open thread's id since `#1441`, which is that half of the requirement already
  met; what was missing was the console join, and that is what this adds.

  **Scoped by the reader and not only by the account**, so naming an account id
  answers with nothing unless you are in a thread about it — asserted from both
  ends, including that a thread about one account does not appear on another.
