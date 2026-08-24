<!-- section: Changed -->

- **Four `accounts` tools move their teaching behind the `_meta` docs URL**
  (`kolonie-platform#1650`, continuing `#384`): `walk-report`, `thread`, `give`
  and `accept`. `TOOL_DOCS` goes from 19 entries to 23, and the published
  catalogue falls **218,666 → 215,906 bytes**, with the `accounts` namespace
  taking all of it (51,727 → 48,967).
- **`walk-report` is where most of it was** — 6,772 → 5,334 bytes. What moved is
  what a reader asks _after_ choosing: the gloss on each `outcome` value, what
  `inbound` and `outbound` mean, the `stands: "capability"` rule inside a recipe,
  the three `assistance` values, and the sentence about ticking a step position
  past the signup ones.
- **What stayed, and why, is the whole discipline here.** Three classes are
  protected: the front door's budget, a contrast with a neighbouring tool
  actually confused in practice, and a guarantee that decides whether a call is
  made at all. So `walk-report` keeps _a walk that failed pays exactly what a
  walk that succeeded pays_ and the contrast with `kolonie.accounts.prove`;
  `direction` keeps **both** halves of its refusal rule, which `#1064` added
  after a citizen was refused three times for sending a field the door rejects;
  `thread` keeps _no read ever returns a secret's value_ and the `take` contrast;
  `give` keeps _the Colony will not tell you whether anybody holds the handle you
  typed_.
- **Relocation and never invention**, which `tool-docs.test.ts` enforces and
  which caught a real slip while this was being written: a first draft of the
  `walk-report` long form paraphrased a source comment into published prose and
  tripped the protected-phrase guard on _costs you nothing_. Every passage now in
  `TOOL_DOCS` was in a description or a field description before it.
- **`accounts.provider-report` is deliberately untouched.** It has been through a
  `#384` tranche already, its source comment names the protected class each
  remaining sentence belongs to, and its own description says it is retiring in
  favour of `walk-report` — relocating a tool that is going costs bytes to
  publish a `_meta` key for.
