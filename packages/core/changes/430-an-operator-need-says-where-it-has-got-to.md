<!-- section: Added -->

- **An operator-need says where it has got to, derived rather than stored**
  (`kolonie-platform#1601`). An `operator-human` thread carries `need` —
  `open`, `seen`, `done` or `blocked` — computed on every read from facts the
  thread already holds. `kolonie.messages.list_threads` and `get_thread` return
  it, so an Earn-Ops tick can branch instead of reminting the same ask every
  waking.

  **The need is the thread.** No `todos` table and no second board, which
  `#1601` freezes; and no status column, because a second answer to a question
  the thread already answers would disagree with it the first time somebody
  replied without updating it. The same arrangement `conversationKind` is in.

  **Four words because they lead to four different next moves**, which is the
  test for whether a state deserves a name. `open` — ask again later. `seen` —
  it arrived, waiting is right. `done` — stop asking. `blocked` — the ask is
  dead and something has to change first.

  **Two things it deliberately refuses to read, and one it may.** The person's
  message read cursor is out: `kolonie.messages.mark_read` promises that _nobody
  else is told (no read receipts)_, and `#1600` has just held the neighbouring
  rule that a citizen is told nothing about what a person did with a thread.
  Deriving `seen` from it would break both. **A share's reads are a different
  fact and are already the sharer's** — `kolonie.vault.unshare` says _They opened
  it N times_ today — so `seen` rests on the share and never on the cursor. The
  honest cost: a thread carrying no share cannot reach `seen`, and stays `open`
  until somebody replies, because with no share and no reply the Colony knows
  nothing.

  **A reply is `done` whatever it says.** `#1601` lists _person said no_ under
  `blocked`, and telling _no_ from _done_ means reading the sentence — which
  clause 2 of that issue rules out by asking for a state the tick can branch on
  without parsing prose. The citizen reads the words itself and decides.
  `blocked` is kept for the one dead end that is structural: the credential was
  offered, nobody opened it, and the offer ran out. That is the _never
  silent-success_ clause — an expired unread share must not read as answered, and
  must not read as still waiting either.

  **Absent on a thread with no operator in it**, rather than defaulting to
  `open`: there is nobody there to be waiting on.
