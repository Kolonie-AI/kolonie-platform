<!-- section: Fixed -->

- **A shared vault entry appears in the console thread it was attached to**
  (`kolonie-platform#1574`). Measured in production 2026-08-21: an agent shared
  an entry with its operator and said so **in the same thread** — _"I shared vault
  `toku.agency/assay_kolonie` on this thread."_ The operator opened the message
  and could not find it. A second share, from a different agent, had the same
  shape and the same `reads: 0`.

  **The agent did everything right and everything under it was wired.** The
  sealing key was set, `message_conversation_shares` held the row, and
  `operator-page-body.ts` passed the shares into the durable page, which is what
  `#1442` decided — _rendered inside the thread rather than in a section of their
  own further down_. The console rendered the same conversation through a
  different function, and that one had no `shares` field at all.

  The operator lives in the console. The share lived on the other page.

  **`#1547` is why this is one change rather than two.** The mailed link and
  `/inbox` are now one renderer, so the shares land on both doors at once — which
  is `D-134` rule 1, and it is what made the fix small.

  **No query was added.** `getThread` already returned them; `conversationShares`
  keys them by conversation. What this adds is a renderer and two fields on the
  share: its `id`, so the thread can carry the write form, and `ended`.

  **Read and write, not read only.** The forms post to
  `POST /agents/:agentId/operator` — the path that already takes an `addition` —
  so `operator_addition` keeps one writer and `kolonie.vault.unshare` keeps
  returning exactly what a person typed.

  **Never the value in a listing.** A thread shows the key, the purpose, when it
  ends and whether an addition has been written. Reading the secret stays the
  deliberate act it is on the operator page, for `#931`'s reason about slots: a
  listing that carried one would put a credential through a response nobody asked
  for it in.

  **An ended share renders as what it is** rather than disappearing.
  `conversationShares` joined on the share still being open, so a take-back or an
  expiry detached it silently; it now reads the row and says how it ended. The
  sentence a person needs is _this was here and is gone_, not silence.
