### What the Atlas catalogue holds, and whether the Card v2 defects are still there

Measured **2026-08-24** against the deployed Colony, as `#1400`'s acceptance criterion asks
— *re-measured against the live catalogue, not against the 2026-08-20 reading*:

```
node scripts/measure-atlas-catalogue.mjs
curl -s https://kolonie.ai/atlas/search?earn=bounty-board
curl -s https://kolonie.ai/atlas/opentask.ai
```

**This reports and proposes nothing.** Where a defect is still there it names a follow-up
issue; nothing here rolls anything back.

#### The correction that has to come first

`#1400`'s acceptance criterion names two SQL queries, taken from `D-136`:

```sql
select axis, count(*) from provider_recipe_facets group by axis;
select provider, kind from provider_recipes where category = 'data-apis';
```

Re-run against production on 2026-08-24 they answer `tag | 115` — **no `earn` row at all** —
and nine `data-apis` providers, every one of them `kind = 'api'`. That is exactly what
`D-136` read on 2026-08-23, and it is what it concluded from: *"There is no earn corpus to
propose from, and the junk drawer is not one."*

**Both queries under-report by construction, and the published catalogue is the corpus.**
They read `provider_recipes`, which held **195** rows. The Atlas serves recipes *and*
providers known only from a walk, and `catalogue.json` — the document a third party stores
and the projection every Atlas page renders from — held **302** entries at
`2026-08-24T00:21:56Z`:

| Source | Entries |
|---|---:|
| `curated` | 184 |
| `measured` — known from a walk, no recipe row | 114 |
| `walk-published` | 4 |
| **total** | **302** |

So a reading from the recipe table misses 107 entries, and it misses them in the one
direction that matters here: a walked earn provider is exactly the thing that has no
curated recipe yet.

#### The defect `#1400` opened on is still there, and it is larger than it was

Read from the catalogue rather than from the table:

| | |
|---|---:|
| entries on the utility fallback shelf `data-apis` | **124** |
| of those, carrying an earn facet | **42** |
| — `bounty-board` | 25 |
| — `gig-marketplace` | 12 |
| — `creator-payout` | 6 |

`hackerone.com`, `gitcoin.co`, `immunefi.com`, `clawlancer.ai`, `opentask.ai` and 37 more sit
on the same shelf as `alphavantage.co`, `anthropic.com` and `platform.openai.com`. That is
the epic's third defect, in the words it was filed in — *earn boards sit next to Alpha
Vantage / OpenAI under fallback `data-apis`* — and it reproduces.

**The shelf is a junk drawer by the only measure that settles it: comparison.** It holds 124
of 302 entries, 41 % of the catalogue. The next largest shelf is `telephony` at 36.

`#1407` asked for a living taxonomy so that this shelf *"stops being a 50+ item junk
drawer"*, and it was closed against the reading above — nine entries, all APIs, no problem
to solve. On the live corpus there are 124. Filed as `#1670`.

#### The nine other defects, re-checked on the live surfaces

| Slice | Defect as filed, 2026-08-20 | Read 2026-08-24 |
|---|---|---|
| A1 tiles | `earn=bounty-board` tiles collapse to nearly identical copy | **fixed** — 25 tiles, **25 distinct**, each carrying its own description |
| A2 FAQ | *"Walkers reported walls that do not fit this question"* repeated many times | **fixed** — **0** occurrences on `opentask.ai` and on `hackerone.com` |
| A3 neighbours | same-shelf peers, so earn boards sat next to Alpha Vantage | **fixed** — `opentask.ai`'s *Where to go from here* is `0din.ai`, `agentbounties.app`, `agentbounty.org` |
| A4 chips | chip salad without hierarchy | **fixed** — `opentask.ai` carries `storefront` · `bounty-board` · `gig-marketplace` as headed groups, and one `no proved hold yet` |
| A5 favicon | no favicons | **built and not running.** `atlas_provider_icons` holds **0 rows** and the sweep has failed every tick since it deployed — `#1667` |
| A6 tags | — | **live** — 115 rows on the `tag` axis |
| A7 taxonomy | `data-apis` is a junk drawer | **still there.** See above; `#1670` |
| A8 proved ranking | proved-hold signal weak on tiles | **live** — every tile carries a proved chip or `no proved hold yet` |
| A9 icons | no icon system; Font Awesome not in Atlas HTML | **fixed** — inline token SVG, one system, no CDN |
| A10 identity | short/long identity often missing on the card | **largely fixed** — **256 of 302** entries carry a description |

#### What this supports

**Eight of the ten slices are done and visible on the live surfaces.** One is built and not
running for a reason that has its own p1 (`#1667`), and one — the fallback shelf — was
closed against a measurement that read the wrong corpus and is still there at 124 entries.

The honest reading of `#1400` is therefore: the presentation work landed, and the taxonomy
work did not, which nobody knew because the query that would have said so counted 195 of 302
entries.

---

**Re-taking this.** `scripts/measure-atlas-catalogue.mjs` takes the whole of the first two
sections and needs no credential — it reads a public document. The per-surface rows in the
last table are three `curl`s, listed at the top.
