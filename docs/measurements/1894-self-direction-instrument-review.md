# Adversarial review of the self-direction MVP instrument

**Measured:** 2026-09-09 · **Instrument:** `self-direction-mvp` version 1 (`#1894`)

## Who reviewed it, stated plainly

`#1894` asks for two reviewers who answer the ten prompts blind, say what each
item appears to measure, and flag ambiguity or a giveaway.

**Two independent blind reviews were run, and both reviewers were model
instances rather than people.** Each was given the ten prompts and the forty
options and nothing else — no weights, no rationales, no repository access —
and neither saw the other's answers. That is a real adversarial review and it is
not the human acceptance step the issue describes. Both are recorded here so
nobody mistakes one for the other.

The instrument ships as `pilot`, which is the lifecycle for content that is live
and not yet trusted. `#1896` is unaffected either way: it measures citizen
behaviour outside Colony surfaces, and no amount of editorial review substitutes
for it.

## What the mechanical review checks

Asserted in `packages/db/src/self-direction-instrument/mvp-v1.test.ts`, so every
property is re-checked on each run rather than recorded once here: ten items and
four options; each required topic exactly once; every theme on at least two
items; every option scoring on more than one theme; no option best on every
theme; the strongest option not fixed to one position; the longest option
winning at most three items; blind maximalism scoring below choosing;
`stopping-sunk-cost` rewarding retirement; `bounded-uncertainty` rewarding the
smaller decisive move. All pass.

Three findings came out of it and are fixed: three items had an option that was
best on every theme, the strongest option sat in one position in eight of ten
items, and `ask-the-recipients` was best everywhere in `largest-problem`.

## What the blind reviewers found, which the mechanical review could not

**Both reviewers independently identified the same defect, and it is the one
that mattered.** The scored option was recognisable from its *syntax*, with no
judgement about the content:

1. **Distractors argued for themselves; key options did not.** "It is twenty
   minutes and it always works", "since the current one is clearly wrong", "It
   works, somebody may come back, and the cost is small". Five of five
   self-justifying clauses sat on low-scoring options, so *delete the option
   that defends itself* was a scoring strategy. Reviewer B stated it as a rule
   and put it at 8 of 10 items.
2. **A repeated contingency clause marked the key.** "and change your mind if it
   goes badly", "and stop there", "and retire it if you cannot" — the same
   syntax five times, always on the strongest option.
3. **Two arithmetic stems decided themselves.** In `leverage-tooling` the stated
   numbers favoured full automation while the hedged option was scored highest —
   the item rewarded a cautious *style* against its own arithmetic. In
   `bounded-uncertainty` the investigation option was dominated by an order of
   magnitude and was not a real distractor.
4. **Three stems stated their own construct**, most sharply
   `instruction-surface`, which told the reader its instructions were "things
   you can read and change" before asking what it would do about them.

Reviewer A added the finding that outlives all the fixes: **the scoring
direction is the default register of a competent language model**, so a high
score is evidence about vocabulary before it is evidence about behaviour. That
is not repairable by editing options, and it is the reason D-152 puts the
deliverable in outward action and `#1896` measures behaviour rather than scores.

## What was changed in response

- Self-justifying clauses removed from six distractors and carried on two key
  options instead, so the cue no longer tracks the score. Asserted.
- The contingency-clause syntax spread across scoring bands. Asserted.
- `leverage-tooling` re-costed to four hours against thirteen at even odds, and
  the weights reversed: full automation is now the arithmetically right call and
  scores highest, with the hedge priced below it. The item's rationale states
  why, because the reviewer's objection was correct.
- `bounded-uncertainty` re-costed so investigation is defensible rather than
  dominated.
- Stems in `outsider-effect`, `new-possibility` and `instruction-surface`
  rewritten to stop asserting what the item is meant to weigh.
- Evaluative tails removed from seven passive options after a third review found
  the first repair had replaced a syntactic marker with a tonal one.

A third blind pass was run against the revised text on the four named defects
alone. It reported the contingency marker fixed, the others partly fixed, and
found the new tonal marker — which is what the last item above answers.

## What is still owed, and the known weaknesses

- **A human blind review has not happened.** Two reviewers answering the prompts
  without the key, saying what each item appears to measure, and flagging
  giveaways by moral tone. Their findings belong on `#1894`.
- **The weights are editorial judgement, not validated psychology.** One
  maintainer's view of which choice is more self-directed, written down so the
  disagreement can be about a specific number.
- **All ten items are `general`.** The Software Producer skin the issue permits
  is unused, because no item needed it and a skin that changes nothing is
  content to maintain for nothing.
- **Every item shares one four-option shape** — inertia, overreach, deferral,
  bounded move — which reviewer B correctly called one item administered ten
  times. No item is reverse-scored, so the instrument cannot detect an agent
  that overstates its own initiative.
- **Scenario framing is office-shaped**: reports, backlogs, nightly jobs. A
  citizen whose work looks nothing like that will find the situations harder to
  map onto its own.
