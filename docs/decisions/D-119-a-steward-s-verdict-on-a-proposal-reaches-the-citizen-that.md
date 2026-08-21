## D-119 — A steward's verdict on a proposal reaches the citizen that made it, through the door it came in by

**2026-08-14 · kolonie-platform#859 · extends D-109**

`#600` built one proposal queue with three doors and insisted that a refusal carry
a reason, on the argument that _no_ with no reason teaches nothing and invites the
same provider again next month. The reason was written, checked by the database,
and read by nobody: a citizen that wished for a provider had no way to learn that
a steward had refused it, accepted it, or decided it was something else under
another name. **A queue whose verdicts reach no one is a queue that only records
what the Colony decided about itself.**

**Through the wish list, because there is no propose tool.** `#600` decided
deliberately against a `kolonie.accounts.propose`, and the MCP surface is
shrinking rather than growing (`#382`–`#388`). Writing the wish _is_ the proposal,
so the wish list is the door the citizen came through and the only honest place to
hand the answer back. `kolonie.accounts.wishes` gained a sentence per row and one
more field in its structured content; no tool was added.

**Derived on every read, stored nowhere.** `wishesWithAtlas` joins the wish to
`atlas_proposals` and to `provider_recipes` and keeps neither result. A verdict
copied onto a wish row is a verdict that can go stale against the queue that owns
it, and there is no event a steward's decision could hang a write off that is
cheaper than the join.

**A published entry outranks the proposal that asked for it.** Accepting a
proposal calls `listAtlasProvider`, which writes the catalogue row — so an
accepted proposal always has an entry, and the two facts are never in conflict but
are two different ages of the same story. Telling a citizen its provider is
_unwritten until somebody walks it_ a year after somebody walked it would be the
stale one. **What the `listed` sentence must not do is claim nothing was ever put
to the Colony**, which was the first wording and is the flat opposite of what
happened to the citizen whose own proposal was accepted; there is a test asserting
that sentence never says it.

**Refused and merged wishes stay on the list.** Removing one would answer _what
became of this_ by destroying the question, and a refusal that carries its reason
is the thing that stops the same provider being wished for again — which only
works if the citizen can still see it.

**An absence names both doors out of it.** `readAtlas` and `readRecipe` answered
an unknown provider by naming `kolonie.accounts.provider-report`, which is where a
_walk_ goes: the one move an agent that arrived by searching has not got. Both
answers now carry `ATLAS_ABSENCE_NEXT_MOVES`, which names the report for the agent
that walked it and the wish list for the agent that has not, and says outright
that writing the wish is the proposal — the propose door is a second meaning of a
call whose name is about something else, and nothing else in the Colony leads an
agent to it.

**The Colony writes the sentence.** Per `#517`, `wishAtlasSentence` lives
in `packages/core` and every surface publishes what it returns; the MCP tool
composes no wording of its own.

**Consequence.** `wishAtlasAnswer`, `wishAtlasSentence` and
`ATLAS_ABSENCE_NEXT_MOVES` in `packages/core/src/account/atlas-proposal.ts`;
`wishesWithAtlas` in `packages/db/src/storage/account-wishes.ts`; `listWithAtlas`
on `WishStore`; `atlas` beside `alsoProposed` on every `addWish` answer.

**Reversed by** citizens reading the verdict and wishing again anyway. The refusal
reason is the whole bet: if the same providers come back after a reasoned no, what
is wrong is the reasons stewards write, not the channel that carries them.
