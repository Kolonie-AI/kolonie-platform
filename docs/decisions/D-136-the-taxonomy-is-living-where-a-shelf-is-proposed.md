## D-136 — The taxonomy is living where a shelf is proposed, and the fallback is a queue rather than a category

**Date:** 2026-08-23

**Problem.** `#1407` asks for a _living_ taxonomy: moderation or a proposal
pipeline should be able to suggest sub-shelves and tag bundles so that the
utility fallback `data-apis` "stops being a 50+ item junk drawer". Its
decision 4 requires that entries with `categoryIsFallback` surface a proposal
route or the word _uncategorised_, and never pretend to be _Data and APIs_ as an
identity.

Read against what exists, two thirds of that is already built and the last third
is the part nobody has done — and the measurement that says which is which is
worth recording, because the issue's premise about the fallback shelf does not
hold any more.

**What already exists, and this record is the documentation `#1407` asks for.**
`#1106` built the proposal object and the accept path in full:

|               |                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Object        | `AtlasCategoryProposal` in `packages/core/src/account/atlas-category-proposal.ts`                                                                                                                                                                             |
| Shapes        | `existing` (file on a shelf the table holds) and `new-sub` (open a shelf under a named top) — a discriminated union, so _a new top category_ is not a value the type can hold                                                                                 |
| Evidence      | `walks` is `.min(1)`: a shelf suggested from a provider's name alone cannot be expressed                                                                                                                                                                      |
| Vocabulary    | `atlasCategoryProposalSections` offers `add:<sub>` and `new-under:<top>` and nothing else, so decision 3 is a property of the call rather than of a prompt                                                                                                    |
| Storage       | `atlas_category_proposals`, `openAtlasCategoryProposal`, `atlasCategoryProposalQueue`                                                                                                                                                                         |
| Accept path   | `decideAtlasCategoryProposal`, one transaction: a `new-sub` inserts the shelf then files the entry; an `existing` writes the join row and refuses `would-move-the-primary`; a decline records the reason and takes the pairing out of the vocabulary for good |
| State machine | 16 tests in `packages/db/src/atlas-category-proposals.test.ts`, including the four refusals                                                                                                                                                                   |

So `#1407` decisions 1, 2 and 3 are satisfied by prior art. **Nothing
auto-renames a shelf**, because nothing but `decideAtlasCategoryProposal` writes
to `atlas_categories` and it only runs on an explicit accept.

**The dry-run, and it is the finding.** `#1407` asks for at least one proposal
generated from the existing earn corpus. Measured against production
2026-08-23:

```
select axis, count(*) from provider_recipe_facets group by axis;
  tag | 115          -- and no earn row at all

select provider, kind from provider_recipes where category = 'data-apis';
  nine rows, every one of them kind = 'api'
```

**There is no earn corpus to propose from, and the junk drawer is not one.**
Every entry on `data-apis` today is an API provider — `anthropic.com`,
`alphavantage.co`, `platform.openai.com`, `rapidapi.com` and five more — filed
on the shelf named after exactly what they are. The shelf holds nine entries and
is the sixth largest; `telephony` holds 36. The bounty boards and freelance
marketplaces `#1326` and `#1329` measured there on 2026-08-19 and 2026-08-20 are
not in this database.

A proposal fabricated over that corpus would have been a proposal about nothing.
The honest deliverable is the measurement, and the two queries above are how the
next reader re-takes it.

**Decision. Ship decision 4 as a guard rather than as a repair, and say which it
is.**

The two sentences `#1407` asks for land, and both are worth landing even though
nothing is currently falling back:

1. **The fallback shelf's own page says it is a queue.** `#1329` stopped the
   _entry_ page presenting the fallback as a provider's identity and left the
   shelf's page alone — which is the surface that reads worst, because a
   heading and a standfirst over forty rows is the strongest form the site has
   of _these things belong together_. `atlasHoldingPenNote` is the sentence.
2. **A fallback-shelved entry says so, including an earn-carrying one.**
   `atlasShelfClause` is deliberately silent there and stays silent: it is a
   _header_ clause stating what the provider is, and `#1329`'s reasoning that a
   reader told _this pays for finished tasks_ has been classified is correct.
   `atlasUncategorisedNote` is a different thing in a different place — the
   route to close the gap, addressed to a reader who could close it. Folding the
   two would put both issues' reasoning in one `if`.

**What is deliberately not built.** A tag-set proposal shape. Decision 2 offers
_sub-shelf **or** tag-set_, and the tag half has no reader: `#1406` made tags
free-form and additive, a walker writes them directly on a walk report with no
gate, and 115 of them exist. A proposal pipeline in front of a field anybody may
already write is a queue nobody would file to. If a tag vocabulary ever acquires
a gate, that is the issue to open and this paragraph is what it is argued
against.

**And the fallback shelf is not renamed or split** — decision 1, and there was
nothing to split: the nine rows on it are nine API providers.
