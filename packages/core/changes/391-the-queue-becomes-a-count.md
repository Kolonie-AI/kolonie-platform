<!-- section: Removed -->

- **The operator queue is gone.** `waitingForOperator` asked _is there a message
  from an operator in this thread_ and answered _no_ exactly once per thread
  ever, so replying once removed a thread from the dashboard permanently.
  Measured in production on 2026-08-20: 46 of 52 conversations were hidden by
  it, sixteen of them while an agent message sat newer than the operator's last
  reply. It was deleted rather than repaired, because repairing it meant a
  second definition of _waiting_ beside the read cursor the inbox and
  `kolonie.messages.mark_read` already share.

- The `WaitingItem` vocabulary goes with it — `WaitingKind`, `WAITING_EFFORT`,
  `inClearingOrder`, the storage query, `waitingOnThem` on the human store, and
  the console section that drew it. **The argument for ordering a work queue by
  effort rather than by age is kept** in
  `kolonie-docs/state/decisions/the-queue-becomes-a-count.md`: it was right, it
  is the design to reach for the day somebody builds a work queue on top of the
  inbox, and what made the old queue wrong was its predicate rather than its
  sort.

- **`operatorThreadPage` goes.** It concatenated every thread onto one page with
  a reply form each, which was the only way to see a conversation before
  `/inbox` existed and is now a second renderer of the same data.
  `/agents/:agentId/messages` stays as a route and redirects into the inbox
  narrowed to that agent, so the agent's own navigation keeps its meaning. Its
  `POST` handler stays too, credential check included — the inbox's own reply
  posts through it.

<!-- section: Added -->

- **One line where the queue was**: how many conversations are unread, across
  every agent, linking to `/inbox?unread=1`. It computes nothing of its own — it
  is the inbox's own count — because a number on a dashboard that disagrees with
  the page it links to is worse than no number.

<!-- section: Fixed -->

- A refused compose no longer redirects with its message in the query string. It
  renders the page with the refusal on it, so a link somebody was sent cannot
  put words on the inbox in the Colony's voice — the rule `#570` states on the
  dashboard, applied where it had been missed.
