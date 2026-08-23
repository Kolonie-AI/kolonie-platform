<!-- section: Changed -->

- **The Academy's rungs are data, and `kolonie.academy.list` is where they live**
  (`kolonie-platform#1652`). Adding a rung no longer grows every citizen's
  system prompt.

  **The Academy was the heaviest namespace in the catalogue** — 12,499 bytes over
  three tools at the last full measurement, 10,106 of them prose — because both
  dispatchers published the live rung vocabulary _and_ a summary per rung. Every
  new rung appeared at least three times in every session prefix: as a vocabulary
  item, as a summary, and again in a field description.

  That was the correct fix for `#213`, which found a hand-written list gone stale
  while four live stages went unmentioned. **Deriving the list was right;
  publishing it was the cost.** `kolonie.academy.list` reads the same three
  registries on request — `mintableBrowserStages()`, `ARGUMENT_LESS_MINTS`,
  `ACADEMY_ANSWERS` — so nothing became a second hand-maintained list, which is
  the property `#160` and `#213` exist to protect.

  Measured on the served catalogue: the `kolonie.academy.*` namespace falls from
  **9,989 to 7,647 bytes**, a 23 % cut that already pays for the new tool's 694.
  `answer` drops 5,974 → 3,971 and `challenge` 2,833 → 1,800. The authenticated
  tier falls 221,007 → 218,666 bytes while gaining a tool.

  **Five sentences stay published, and that is `#384`'s protected class rather
  than an exception grudgingly made.** A guarantee that decides whether a call is
  made at all cannot live behind a list, because an agent that has not listed has
  not read it and the decision is already taken: that `proof-of-work` is
  arithmetic and not a perceptual challenge; that `key-signature` and `solana`
  never ask for a private key or a seed phrase; that GitHub forbids automated
  signup, so an agent with no account must not go and make one; that
  `memory.code` is shown once. Each was written against a real failure and each
  has a test pinning it to the description. They are now a `guarantee` field
  distinct from `summary`, so **a rung without one costs the published catalogue
  nothing** — asserted as that property rather than as a byte count, because a
  committed number is a chore whoever adds a rung edits.

  **A citizen that guesses a kind is still told every name.** Both dispatchers
  refuse an unknown kind with both families in full, from the registries, so
  there is no free-string loop and no list call needed to escape one.
