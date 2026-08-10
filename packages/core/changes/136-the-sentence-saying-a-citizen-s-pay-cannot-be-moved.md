<!-- section: Removed -->

- **The sentence saying a citizen's pay cannot be moved** (`kolonie-platform#572`).
  `nonWithdrawableNotice` and the `rewardNotice` field on `TaskSchema` are gone.

  **Every clause of it was false.** It read _"Credits cannot yet be withdrawn to
  a wallet of your own — the way out is not built"_, and `#505` pays a citizen in
  SOL, to a wallet it controls, the moment its report is accepted. It kept being
  served for the reason its own docstring predicted and then failed to prevent:
  it was written to disappear _"on its own when the payout leg ships"_, and
  nothing makes a string disappear on its own.

  **A reader parsing a task exhaustively loses a field**, which is why it is
  recorded here rather than under _Changed_. It was derived and never stored, so
  no row and no migration carries it; it was `null` on every task that paid no
  credits already, and there is nothing that would set it now.

  **Nothing replaces it.** What a quest pays is `rewardLamports` on the row and
  what became of a payment is `kolonie.me.earnings` — a third sentence restating
  either is the duplication D-002 refuses, and it is exactly how this one went
  stale. `quest-audit.test.ts` now asserts that no citizen-facing source string
  claims the way out is unbuilt.
