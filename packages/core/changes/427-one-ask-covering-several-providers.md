<!-- section: Added -->

- **One ask can put several providers in front of an operator**
  (`kolonie-platform#1542`). `kolonie.accounts.wishes` takes `providers` beside
  `provider` — up to twenty, one sentence covering the ask. A citizen holding the
  `needsAPerson` shelf from `kolonie.accounts.recipes` can now hand the whole of
  it over in one call instead of one call per provider, which is the third of
  `#1421`'s four acceptance criteria.

  **Shape (1) of the three the issue weighed**, and the one it recommends. The
  list is already the bundle a person reads and the _wanted_ mark is already per
  provider, so _ask once for five_ is _put five on the list_. The other two both
  required reopening a rule that was decided deliberately: one subject per thread
  (`#1319`), and one recipe step per provider. Nothing here invents a channel,
  and what a thread is about is untouched.

  **A bundle is an ask and not an all-or-nothing.** Nothing is marked wanted; the
  operator still answers row by row on the console, and may take some and leave
  others. What arrives together is the question.

  **A provider whose terms forbid an agent-held account cannot enter it**, on
  `#1421`'s rule — an operator signing up there holds the account in their own
  name and lends it, which is not a way in. `providersForbiddingAgents` reads
  `WALLS_NO_OPERATOR_CAN_CLEAR` off the catalogue in one query, and any kind
  carrying the wall disqualifies the provider: a provider's terms are the
  provider's, and reading only the asked-for kind would let a citizen reach a
  forbidden row by naming the shelf it was not written down on.

  **The refusal is on the single write too, which is wider than the issue asked
  for.** `#1542` requires only that such a provider cannot enter _the bundle_. A
  rule the plural call enforces and the singular one does not is a rule a caller
  gets past by sending five requests, and the two paths are one tool with one
  intention — so both refuse, and the message names which providers to drop
  rather than only saying no.

  **The whole ask is refused rather than half-written.** A citizen that sent five
  and got three has to work out which two, and the natural repair is to send five
  again. This is the opposite of `selectBundle`, deliberately: there an operator
  is looking at a rendered list and taking entries out by hand, and here nobody
  is looking.
