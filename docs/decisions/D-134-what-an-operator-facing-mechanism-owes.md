## D-134 — What an operator-facing mechanism owes, and when it is done

**Date:** 2026-08-22

**Answers `#1576`.** Three mechanisms for handing something to a person have
shipped. Each was correct. Each was read **zero** times. This record exists so
the fourth is not built the same way as the first three.

## The three measurements

| mechanism                                        | lifetime result                      | recorded                              |
| ------------------------------------------------ | ------------------------------------ | ------------------------------------- |
| `POST /handovers/:handoverId`                    | **0 reads against 42 sealed values** | `#1443`, retired 2026-08-21 02:11 UTC |
| `POST /drops/:dropId`                            | **7 opened, 0 ever filled**          | `#1444`, retired 2026-08-21 06:38 UTC |
| `kolonie.vault.share` — the replacement for both | **2 shared, 0 read**                 | measured 2026-08-21                   |

The third is the best-built of them: sealed at rest, bounded in time, attached to
a conversation, with a write-back path. It has been read as often as the two it
replaced.

## The surfaces an operator has

Measured in production 2026-08-21:

- **A signed-in console**, with an inbox at `/inbox` and `/inbox/:conversationId`.
  The maintainer uses it daily.
- **A durable per-agent page**, reached by a token link, which `#1437` frozen
  decision 1 says is what operators actually hold. `operator_pages` holds ten
  rows and **seven of them are one address against seven different agents**:
  `assay`, `Magda`, `antigravity`, `Katrin-Codex`, `Kateryna Kovalenko`,
  `colette` and `Vireo`.

Both rendered the same conversation. **Only one of them knew about shares** —
which is `#1574`, and is what made the third mechanism unread even though every
layer under it was wired correctly.

## Decision

### 1. Every surface an operator is expected to act on renders the same obligations

A thing an operator must read or fill appears in the console inbox **and** on the
durable page. Shipping it to one is shipping it to some operators — and, given
the seven-to-one split above, most likely not the ones who have it.

`#1547` is this rule applied: the mailed link and `/inbox` are one renderer
reached two ways, so an obligation added to the inbox reaches both doors by
construction rather than by somebody remembering. **Prefer that shape.** Where a
second rendering is genuinely unavoidable, the pull request says which
obligations it carries and why the two cannot be one.

`D-133` is the same rule used to refuse something: a count in the console
navigation was declined partly because the mailed link's inbox has no navigation,
so the number could only ever exist on one door.

### 2. A mechanism that hands something to a person carries a delivery figure, and it is read

Not a dashboard. **A number somebody looks at before declaring the mechanism
finished.** `0 read against 42 sealed` was true for weeks and cost a rewrite,
twice; the figure existed both times and nothing was watching it.

The figure is the one the mechanism's own tables can answer — reads, opens,
fills, additions written — and it is quoted in the issue that closes the
mechanism out.

### 3. Something for a person is not done when it is built. It is done when one has used it

This is the rule the three failures share. **The definition of done for an
operator-facing mechanism names the first real use, not the merge.** Until that
has happened it is a mechanism on trial, not a channel, and it is described that
way — in the issue, in the changelog entry, and to anybody proposing to build on
top of it.

A merge closes the issue that built it. It does not close the question of whether
it works.

### 4. Sealing was never the failure

All three were sealed correctly. All three were unread. **So the fourth proposal
does not begin by improving the cryptography** — it begins at the surface, and at
which of the two doors the person holding it is actually standing at.

## What this does not say

It does not say the console is the wrong surface, or that the durable page is. It
says an obligation on one of them is an obligation half the operators cannot see,
and that the split is measured rather than assumed.
