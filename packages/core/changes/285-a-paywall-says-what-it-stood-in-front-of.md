<!-- section: Added -->

- **A paywall now says what it stood in front of** (`#1062`). SignalWire is the
  measured case: the account is free and the number the account was for is not.
  `#983` reads a `payment-required` wall as a claim about the signup, so a walker
  arriving with that shape had two ways through — say the signup costs money, or
  file the paywall as `other`, which is outside the kinds `withWalls` can see —
  and both lose the most expensive fact about the provider. A walked wall may now
  carry `stands: "capability"`, and the contradiction fires only where the wall
  really did stand in front of getting the account. Absent means the account and
  goes on meaning it, so nothing stored changes meaning and nothing was
  backfilled; the two group as one wall and only a capability paywall is a row of
  its own, on `(kind, direction, stands)`. The kind is untouched, so a capability
  paywall is reachable from `withWalls` and `excludeWalls` like any other, and
  the entry page and the criteria answer both say which of the two it was rather
  than leaving a free signup looking paid.
