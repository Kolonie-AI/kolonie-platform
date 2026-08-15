<!-- section: Added -->

- **A walker says what the account cost and what the terms said**
  (`kolonie-platform#983`). The Atlas has carried `cost` and `terms` on every
  entry since `#815`, and on 2026-08-15 `cost` read `unknown` on 133 entries out
  of 133 — a default that reads like a measurement. The reason was structural
  rather than anybody's neglect: both columns were curator-only, and the one
  agent that has just been quoted a price is the walker, which had nowhere to put
  it. So `recipe` on `kolonie.accounts.walk-report` now takes `cost` — `free`,
  `card-to-sign-up` or `paid-only` — and `terms` — `agent-allowed`,
  `operator-only` or `human-only` — and `finishWalk` lifts both onto the entry it
  proposes, on the draft branch and on the refusal branch alike.

  **`unknown` is not on the door.** The columns keep it, because an entry nobody
  examined has to say so, but a walker reporting _nobody looked_ is a walker
  leaving the field out. Two ways to spell one thing is an ambiguity, and the one
  that means silence is spelled by silence.

  **A walk saying `payment-required` and `free` in one breath is refused**, by
  the walker, while it is still in the room and knows which half is wrong. A card
  demanded before the account exists is not caught: that is a payment wall and it
  is free of charge, and `card-to-sign-up` is the answer for it.

  **A walker never wipes an answer somebody already gave.** `writeProviderRecipe`
  is an upsert whose rule is that an omitted field resets, which is right for a
  curator editing a whole entry and wrong for a walk that was asked about two
  fields and nothing else. Both branches passed neither, so until now a walk
  against an entry a steward had answered blanked both back to `unknown` on its
  way past. Silence now leaves what was there standing, and only a walker that
  looked moves it.

  **What is not in this.** `paid` stays a boolean and stays untouched: it records
  whether the provider paid to be listed (`#543` rule 3, shown by `#547`,
  invisible to `atlasRank` by `#548`), which is the other axis entirely — who
  paid _us_, against what it costs _you_. `needs` and `signupCode` stay
  curator-only.
