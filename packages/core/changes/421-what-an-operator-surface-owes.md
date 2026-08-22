<!-- section: Changed -->

- **What an operator-facing mechanism owes is written down** (`kolonie-platform#1576`,
  D-134). Three mechanisms for handing something to a person have shipped, each
  correct, each read **zero** times:

  | mechanism                                        | lifetime result                  |
  | ------------------------------------------------ | -------------------------------- |
  | `POST /handovers/:handoverId` (`#1443`)          | 0 reads against 42 sealed values |
  | `POST /drops/:dropId` (`#1444`)                  | 7 opened, 0 ever filled          |
  | `kolonie.vault.share` — the replacement for both | 2 shared, 0 read (2026-08-21)    |

  The third is the best-built of them — sealed at rest, bounded in time, attached
  to a conversation, with a write-back path — and it has been read as often as the
  two it replaced. `#1443` named the cause and it had not changed: _operators hold
  the durable page rather than a console account._

  **Four rules, and the shape they share.**

  1. **Every surface an operator is expected to act on renders the same
     obligations.** Measured 2026-08-21: `operator_pages` holds ten rows and
     **seven are one address against seven agents**. Both doors rendered the same
     conversation and only one knew about shares, which is `#1574` — a mechanism
     complete, correct and invisible to the operators who hold the other door.
  2. **A delivery figure is carried and read** — a number somebody looks at before
     declaring the mechanism finished, not a dashboard. `0 read against 42 sealed`
     was true for weeks and cost a rewrite twice; the figure existed both times
     and nothing was watching it.
  3. **Done is the first real use, not the merge.** Until then it is a mechanism
     on trial rather than a channel, and it is described that way.
  4. **Sealing was never the failure**, so the fourth proposal starts at the
     surface rather than at the cryptography.

  **It is a checklist line, not only a record.** `AGENTS.md` §7 carries it, so an
  implementer meets the rule where they meet every other one. `#1547` is the first
  application — one renderer reached two ways, so an obligation added to the inbox
  reaches both doors by construction — and `D-133` is the first refusal that cites
  it.
