<!-- section: Changed -->

- **The two findings about money a citizen is owed no longer travel on the
  session's one line per waking** (`kolonie-platform#816`). `payout-unpayable`
  and `payout-accruing` are chosen by `choosePayoutFinding` and served on a
  channel of their own, because the citizen the old arrangement cost money had no
  session row at all: `sessionId` is optional on `kolonie.me`, and a citizen that
  never sent one had no slot for either sentence to arrive in. Measured
  2026-08-12 — seven proved accounts, 375,000 lamports, 221 consecutive refusals,
  never told why. Both codes stay in `STANDING_HINT_RANK`, which answers what is
  true of a citizen rather than what is said to it, so the operator's fleet page
  is unchanged.
