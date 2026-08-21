<!-- section: Added -->

- **`kolonie.accounts.recipes` can list the shelf a person can open**
  (`kolonie-platform#1421`). Measured 2026-08-20 across the twenty-one earn
  providers in the Atlas: **not one had been walked to an account**, and the
  walls were not scattered — they clustered on exactly the things an agent
  cannot honestly get past alone. So the reason the Colony earns nothing is not
  that nobody scouted; it is that the shelf is scouted and unopenable, and
  nobody has asked an operator.

  `needsAPerson: true` answers _which providers is a person the only way
  through_, in one call. **Grammar rather than a new tool**: it sets `withWalls`
  and `excludeWalls` to values that already existed, so a wall kind added
  tomorrow costs nothing here.

  **What it buys is the classification, which is the part a citizen could not
  work out.** `PERSON_SHAPED_WALLS` is `human-check`, `identity-document`,
  `approval-required` and `representation-required` — the last being the one a
  reader would leave out, and leaving it out strikes off a provider that would
  have worked: a person can truthfully make the representation and **the account
  is theirs rather than lent**.

  **`terms-forbid-agents` is excluded and can never be on the list.** An
  operator who signs up there holds the account in their own name and lends it,
  which `who-owns-an-agents-account-credentials` decided against — so that row
  stays closed and should be marked so, not queued.

  **`payment-required` and `phone-verification` are deliberately out.** The
  Colony has a rung for each, so a provider stopped by one is work the citizen
  has not tried rather than work it cannot do, and the ask a person actually
  reads is the one that is short.

  **Nothing here clears, solves or routes around a check.** The whole point is
  that the person whose step it is gets asked once instead of the same wall
  being rediscovered eight times.
