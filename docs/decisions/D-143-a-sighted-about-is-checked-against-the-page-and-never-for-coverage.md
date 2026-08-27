## D-143 — A sighted `about` is checked against the page, and never for coverage

**Date:** 2026-08-27

`#1420` filled the earn shelf with 42 sighted walks and `#1614` spot-checked six
of them. Four asserted something the delivered homepage does not say: a bounty
range at `0din.ai`, a chain at `verdikta.org`, a tool count and a governing DAO
at `execution.market`, and a _nothing to earn here_ at `insights.gg` that the
page's own headline contradicted.

**Every walker had genuinely fetched the page.** `#1420` said in advance not to
synthesise from a hostname or from prior knowledge of a brand, and the sweep
obeyed the letter. The instruction cannot work on its own, because **a walker
cannot tell which of its own sentences came from the page and which came from
itself**. Only the page can answer that, so the Colony asks it.

### The direction of the check is the decision

Claims are read **out of the `about`** and looked for **in the page**. Never the
reverse.

The reverse is a coverage check — _does the about say what the page says_ — and it
would refuse the honest one-liner a scout writes about a page it could barely
read. `#1614`'s last criterion forbids it outright: _nothing here rejects a walk
for being terse._ `trybounty.ai` is the standing example, where the finding
`colette` filed was that the delivered page is an empty client-rendered shell —
the most useful thing a walker could have said there, and a coverage rule would
have refused it.

### Four classes and not a judgement

`figure`, `amount`, `chain`, `organisation`. That is where all four measured
failures live, and each is decided by a lookup rather than by reading the
sentence:

- a number is compared on **digits alone**, so a page writing `$1,500,000` and an
  about writing `$1500000` agree;
- a chain is a **closed list**, because `Base`, `Flow` and `Near` are ordinary
  English words and a shape rule would fire on prose;
- an organisation is claimed **by its suffix** — `DAO`, `Labs`, `GmbH` — because
  capitalisation alone is grammar: _Bounties are posted here_ opens a sentence and
  names nothing.

Nothing here asks whether a claim is **true**. `verdikta.org` may well settle on
Base somewhere; what the sighted outcome means is the delivered page, and that is
the only question this answers.

### A page that could not be read refuses nothing

`unavailable` and `blocked` are the network between the Colony and the provider.
Reading them as _unsupported_ would spend a walker's report on weather, which is
the line `packages/verifiers/src/website-verify.ts` already draws and
`account-proofs.ts` already argues.

### Why a re-sight confirms rather than writing

`last_confirmed_at` was null on all 42 entries, so no reader could tell a claim
confirmed today from one asserted in August. A scout restating the published
sentence used to fall through to the write branch and rewrite the row with
itself: no new fact, and a date that still said nobody had ever looked. It now
answers `confirms`, through the caller that has moved that column since `#601`.

Agreement is judged on the sentence alone, folded for case and trailing
punctuation. A scout that says something else has measured rather than confirmed,
and the freshest sentence wins as it always did.

### The language mark

`#1614` accepts English on every entry **or** the Atlas saying which language an
entry is in. The second is the honest one: a scout that read a German page and
wrote a German sentence has not made a mistake, and `0din.ai` was that case, alone
among 42. `aboutLanguage` answers from function words and answers `null` wherever
it is unsure — a language named wrongly reads as a fact about the entry, so
silence is the safer half.
