<!-- section: Added -->

- **Two MCP tools for the account conversation, and no more than two**
  (`kolonie-platform#930`). `kolonie.accounts.thread` carries every move —
  `open`, `put`, `read`, `note`, `pass`, `close` — on one flat schema with an
  `op` discriminator, and `kolonie.accounts.take` is the second tool because
  taking a secret out is the one act that spends something and must not be
  reachable by accident from a read.

  Called with no arguments at all, `kolonie.accounts.thread` is the waking read:
  every open episode on every account of yours, the ones on your turn first. A
  citizen that has forgotten it was halfway through obtaining a mailbox finds out
  in one call, which is the whole reason the conversation is a surface rather
  than a table.

  **A secret's value is in no listing, ever.** A `read` reports a secret slot as
  present and filled and carries `null` where the value would be; the value
  leaves exactly once, through `kolonie.accounts.take`, and lands in the caller's
  vault under a key they name rather than in the transcript. The vault write
  happens before the slot is stamped, so a crash between the two costs a second
  take rather than the secret; a second take after a successful one is refused
  naming the vault key the first one used, and touches nothing.

  A slot that is **not** a secret — an address, a handle, a code that has already
  expired — is handed back as many times as asked, because a second look at one
  of those rescues a lost clipboard and spends nothing.

  Where the Colony has no sealing key configured, the conversation does not
  disappear: only a `put` carrying a secret is refused, and it says so and points
  at `kolonie.support.open`. An episode that is not yours answers as one that does
  not exist, so an id cannot become a way to learn that somebody else holds it.
