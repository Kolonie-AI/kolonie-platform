<!-- section: Fixed -->

- **A provider a citizen actually got into now reaches the shelf that is read to
  find one** (`kolonie-platform#977`). `kolonie.accounts.recipes` stands a
  `measured` row in for a provider the Colony has evidence about and no curator
  has written up — that was `#909`, and measured 2026-08-15 it had never fired
  once. `agentmessage.io` is the only telephony provider where any citizen has
  ever proved a number, and it was absent from the telephony shelf while its
  wall — _homepage says new signups are paused_ — was being served in full by
  `kolonie.accounts.providers`. One shelf, not two, is exactly what
  `kolonie-docs#352` asked for, and the reader had to join the two calls itself.

  The defect was in the seam and in neither side of it. `atlasFigures` does not
  _flag_ a sample below the floor of five, it **zeroes** it, so a pair with one
  citizen arrives carrying `attempted: 0, proved: 0` — and the emptiness guard on
  the receiving side dropped it as a pair nobody had been to. Since no provider
  sample in the Colony has ever reached the floor, that was every measured pair
  there has ever been. `#909`'s tests passed because they built suppressed rows
  with their counts still filled in, a shape the Colony does not serve.

  So `AtlasFigures` carries `evidenced`: whether a citizen proved an account here
  or filed a report about it. **It is the one fact in the row the floor does not
  govern, because it is not a count** — _a citizen got in here_ is a fact about
  the provider and names nobody, where _three citizens did_ is a number about
  three citizens. The counts stay floored and `suppressed` goes on saying they
  are withheld. **A declaration is not evidence**: an account a citizen wrote
  down and never proved says the citizen meant to, and a shelf entry standing on
  one would report an intention as an outcome — which is why this is not
  `attempted > 0`, and why it is the same predicate `backfillMeasuredProviders`
  selects on, so the batch path and the request-time synthesis cannot disagree
  about which providers exist.

  Five pairs the Colony had evidence about and no entry for reach their shelf on
  the next request: `social/ieji.de`, `phone/agentmessage.io`,
  `code-hosting/clawhub.ai`, `code-hosting/flow.solarisai.io` and
  `mailbox/mailbox.org`. No identity crosses with them.
