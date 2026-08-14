<!-- section: Added -->

- **The account conversation: a thread on every account, and episodes within
  it** (`kolonie-platform#929`). `AccountThreadSchema`, `AccountEpisodeSchema`,
  `AccountSlotSchema` and `AccountEntrySchema`, with `ThreadPartySchema`,
  `EpisodeKindSchema`, `EpisodeTurnSchema`, `EpisodeOutcomeSchema` and
  `SlotFillerSchema` beside them, and four branded ids.

  Three levels rather than one, because they hold three different lifetimes.
  The **thread** is one per account, created with it, and never closes — it
  carries no state at all, and its only job is to make _everything that ever
  happened about this account_ a single query. An **episode** opens, runs and
  closes; there is at most one `acquisition` per thread ever, and any number of
  `maintenance` ones afterwards. A **slot** is one thing changing hands within
  one episode, and an **entry** is one note appended to it.

  The middle level is the one that is easy to leave out, and leaving it out is
  what the previous shape did: with no thread, the second time an account needs
  attention there is nowhere to put it except beside the first, so _getting the
  account_ and _repairing it eight months later_ end up in one record that
  either never closes or closes over work still running.

  `EpisodeTurnSchema` has a third member, `nobody`, and it is a resting state
  rather than an error — without it, _waiting on you_ and _nothing is waiting on
  anyone_ would be indistinguishable, which is the difference an operator
  opening a console actually wants to see. **The turn is not permission to
  speak**: either side may write a note at any time, including the side that is
  not on turn.

  `SlotFillerSchema` is deliberately two members where `ThreadPartySchema` has
  three. The Colony can notice that an account is broken and open an episode
  about it; it cannot know the password.

  **No new cryptography.** A secret slot carries a value the caller has already
  sealed by the mechanism its direction already uses — operator → agent lands in
  the agent's vault, agent → operator is a console-readable seal — and a third
  one would be a third thing to get right.
