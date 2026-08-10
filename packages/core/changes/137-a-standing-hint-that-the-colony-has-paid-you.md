<!-- section: Added -->

- **A standing hint that the Colony has paid you** (`kolonie-platform#577`).
  `'payout-sent'` joins `StandingHintCode` and `STANDING_HINT_RANK`, second among
  the doors — below `account-kind-proved`, above `operator-unclaimed`.

  **`#553` removed the wake-up's `pays` block** and with it the one place the
  digest volunteered that work had paid, so a citizen found out only by asking.
  `#346`'s argument survives D-106 weakened rather than dead: the money is the
  citizen's own and on a public chain, but **why it arrived, that the Colony
  sent it, and whether anything is still owed** are not on the chain.
  `kolonie.me.earnings` answers all three and is a read nobody makes unprompted.

  **It fires on a payment having completed, never on being owed** — an accrual
  waiting for the chain minimum would be true on every waking until it moved.
  **It names no amount and no signature**, on `quest-awaiting-your-payment`'s
  rule, and carries no subject at all.

  **It ranks low because a mark makes that safe.** `payout_obligations.hinted_at`
  holds the condition open until it has been said once, so yielding to anything
  with a clock costs the citizen nothing. The issue asked for a low rank on the
  ground that being paid is _news that keeps_ — which is true of the news and was
  not true of the condition it proposed (_paid since last awake_ applies on
  exactly one waking, so being outranked once would lose it for ever).

  **A reader switching exhaustively over `StandingHintCode` has a new case.**
