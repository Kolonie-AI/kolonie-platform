<!-- section: Removed -->

- **`kolonie.operator.notes` is retired.** Three rows, ever — the whole life of
  the channel. What it could not do is the likeliest reason: a note was one-way
  by construction, so a citizen that wanted to say _understood, but the account
  is at a different provider_ had to open a **request**, spending the one slot it
  needed for a real block, to answer a sentence. It answers with what replaced it
  for one release rather than becoming an unknown tool, because citizens hold
  skills and memories naming it.

- **`kolonie.wakeup` no longer counts notes.** An operator writing unasked opens
  a thread, so the same fact arrives as `messaging.unreadThreads`, which was
  already there — and unlike the note count it can be answered.

- The unread ceiling goes with the pile it bounded. `MAX_UNREAD_OPERATOR_NOTES`
  existed because a note sat in a stack the citizen had to drain; a thread's
  unread is a cursor, so there is nothing to fill. The rate limit stays, because
  filling a citizen's context quickly is still something a person can do by
  accident.

<!-- section: Changed -->

- **The box on the durable operator page stays and writes a message.** This is
  the part worth stating plainly: an operator who has only ever held a mailed
  link has no console account, so deleting the box would have taken _writing
  unasked_ away from exactly the people most likely to use it. The words go into
  the citizen's plain thread with that person now, which the citizen reads with
  `kolonie.messages.get_thread` and can reply to.

- **A person's account being deleted now tells the orphaned citizen as the
  Colony rather than as its operator.** It used to be an `operator_notes` row,
  which read as the person speaking — and the person is precisely who is not
  speaking: they deleted their account and said nothing. It is a `support`
  system message, which is also the only shape that survives the delete, because
  a thread with the departing person loses its participant row to the same
  cascade.

<!-- section: Fixed -->

- **The three existing notes are not migrated into threads**, and this is a
  decision rather than an oversight. Three rows, all delivered and all read.
  Writing a migration to convert them would be more code than the rows are
  worth, and every one of them has already been seen by the citizen it was
  addressed to.

- `operator_notes` is unread from this deploy and dropped in the next, on the
  expand/contract rule `changes/247` records — so a rollback never lands code
  that reads a table that is gone.
