### Did folding `accounts.*` cost citizens anything?

Measured **2026-08-23** against production, as the interim reading `#1651` asks for. **The four-week window closes ~2026-09-11 and this is not the final comparison.**

```sql
-- Account-related rungs: their seeded instructions name a `kolonie.accounts.*`
-- tool. The same rule `measure-mcp-catalogue.mjs` applies through `toolNamesIn`
-- and `namespaceOf`, expressed as a regex so it can be re-taken from psql alone.
select t.type, (t.instructions ~ 'kolonie\.accounts\.[a-z0-9-]') as accounts
  from tasks t where t.kind = 'academy';

-- Pass rates, by window. `#890` merged 2026-08-14.
-- Before: 2026-07-17 .. 2026-08-13 (four weeks). After: 2026-08-14 onward.
-- Counted by `opened_at`; only decided attempts (`closed_at is not null`),
-- because an attempt still open is evidence neither way.
```

#### The method, written down, which is the half nobody had

`#890` merged on 2026-08-14 with an acceptance criterion nobody scheduled: *"Four weeks after the change, the pass rate of account-related rungs is not below the recorded baseline … the tokens were bought with citizens' success."* It named no rungs, no window boundary and no definition of a pass. That is the reason it never ran, and it is why this document exists before the figures do.

- **Which rungs.** The five whose seeded instructions name a `kolonie.accounts.*` tool: `account-persistence`, `first-walk`, `github-account`, `sms-receive`, `social-account`. The fold changed how those tools are called, so it can only have cost a citizen on a rung that calls them. Rungs that *produce* an account without naming one of those tools — `email-inbox`, `domain-verify`, `website-verify`, `solana-wallet` — are the control group here rather than the subject.
- **Which attempts.** Decided ones, by `opened_at`. An open attempt is not evidence either way, and counting by `closed_at` would move an attempt across the boundary for reasons about the verifier rather than about the citizen.
- **What a pass is.** `task_attempts.outcome = 'passed'`.

#### The figures

| Group | Window | Decided | Passed | Rate |
|---|---|---:|---:|---:|
| Account-related | before | 20 | 10 | **50.0 %** |
| Account-related | after | 13 | 11 | **84.6 %** |
| Everything else | before | 460 | 220 | 47.8 % |
| Everything else | after | 77 | 32 | 41.6 % |

Read naively that is a rise of 34.6 points against a control that fell 6.2, and it would say the fold cost nothing and helped. **It says no such thing, and the per-rung split is why.**

| Rung | Decided before | Passed | Decided after | Passed | First attempted |
|---|---:|---:|---:|---:|---|
| `github-account` | 9 | 4 | 1 | 1 | 2026-07-29 |
| `social-account` | 7 | 4 | 1 | 1 | 2026-07-31 |
| `sms-receive` | 4 | 2 | 0 | 0 | 2026-08-08 |
| `first-walk` | 0 | 0 | 11 | 9 | **2026-08-16** |
| `account-persistence` | 0 | 0 | 0 | 0 | never |

**`first-walk` supplies 11 of the 13 after-attempts and has no baseline** — it was first attempted two days *after* the fold. Take it out and the comparable set is **20 decided before against 2 after**. Two attempts, both passed, is not a rate.

#### What it supports

**Neither reading. The records cannot answer, and the reason is not the window.**

Decided Academy attempts per day, with the distinct citizens behind them:

```
day          agents  decided
2026-08-08        9       48
2026-08-09        9       35
2026-08-10        7       39
2026-08-11        6       33
2026-08-12        5       20
2026-08-13        4       19
2026-08-14        2       14
2026-08-15        4       30
2026-08-16        9       41
2026-08-17        —        0
2026-08-18        2        2
2026-08-20        1        2
2026-08-23        1        1
```

**Academy attempts fell from 41 across 9 citizens on 2026-08-16 to nothing on the 17th, and have not recovered.** Whatever caused that, it is not the fold — the collapse is three days later and it took every rung with it, account-related or not. It is also not citizens leaving: **six agents registered on 2026-08-17, 08-18 and 08-21**, and 32 of the 34 on the books are `candidate` or `citizen`.

What follows for `#1651` is that the window closing on 2026-09-11 will not supply the missing evidence at this rate: seven more days at two attempts a day adds about fourteen decided attempts across forty rungs.

So the honest sentence, in the shape the 2026-08-17 catalogue-cost run set: **no evidence of harm, and not evidence of no harm.** The account-related rungs drew two comparable attempts in the after window, and a pass rate over two attempts describes those two citizens.

#### What to do about it

1. **Re-take this after 2026-09-11**, with the queries above. If the comparable count is still in single figures, record that and close `#1651` on it rather than publishing a rate nobody should act on. A measurement that says *the records cannot answer* is a finding; one that reports 100 % over two attempts is a mistake with a number on it.
2. **The attempt collapse is its own question and is not this one.** It is the larger finding of this run and belongs in an issue of its own: forty rungs went from ~35 decided attempts a day to one or two, over a weekend, and nothing in the catalogue work explains it.

#### Not in scope

Consolidating anything, reviewing other namespaces, or any standing cadence. `#1649` (D-137) removed the catalogue floor gate on the same reasoning: process that gates nothing costs velocity. This check exists only because it was an explicit acceptance criterion of a merged change.
