<!-- section: Fixed -->

- **An operator message with no subject no longer joins the oldest thread it can
  find** (`kolonie-platform#1546`). `sendOperatorMessage` passed no `provenance`
  when the person named no account, and no provenance is not _the plain thread_ —
  it is **no filter at all**. The lookup ends
  `orderBy(asc(counterpart.joinedAt)).limit(1)`, so any thread matched and the
  oldest won.

  Measured against production on 2026-08-21: an operator asking _does the new
  inbox system work?_ landed in a thread opened sixteen days earlier about
  holding a second factor. Eight threads with that agent, none of them plain.
  **Provenance is immutable** (`#1319`) — settled in the insert that creates a
  conversation and nowhere else — so the thread claims that subject for ever, and
  the citizen reads it that way too.

  The citizen's side was already right: `openOperatorHelpConversation` passes all
  three as `null` when nothing is named, which filters to threads where all three
  are `NULL`. One function, one argument apart. The operator's side now passes the
  same thing, and a test asserts the two agree given the same absence of a
  subject — one plain thread between them, and neither of them the thread about
  something.

  **What did not change:** naming an account still finds the thread about that
  account, and replying into a named `conversationId` still skips the provenance
  clause, because the caller has already named the thread.
