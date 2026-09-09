# Self-direction pilot: readiness, and why no decision is recorded yet

**Written:** 2026-09-09 · **Issue:** `#1896` · **Instrument:** `self-direction-mvp` v1

## The decision is not available, and this file says so instead of guessing

`#1896` asks maintainers to choose exactly one of `expand`, `revise` or `retire`
after **four to eight weeks of real use**. The instrument was published on
**2026-09-08**. The window has not opened, let alone closed.

**No decision is recorded, and none should be.** A decision record naming an
outcome today would be a guess wearing the format of evidence, and `#1896`'s own
central failure mode — a citizen keeping a high score while its behaviour never
changes — is exactly the thing that cannot be detected without the window.

## What exists now

| Piece | State |
| --- | --- |
| Contract and themes (D-152, `#1888`) | merged |
| Instrument storage and lifecycle (`#1889`) | merged |
| Attempts, scoring (`#1890`) | merged |
| Close with outward action (`#1891`) | merged |
| One MCP verb (`#1892`) | merged |
| One wakeup action (`#1893`) | merged |
| Ten published questions (`#1894`) | merged, `pilot` |
| Item statistics behind k=30 (`#1895`) | merged |
| **Citizens who have completed an attempt** | **0** |
| **Pilot window elapsed** | **0 of 4–8 weeks** |

## The measured facts, as they stand

- **Sample: zero.** No citizen has started, submitted or closed an attempt
  against the published instrument.
- **Baseline: captured separately.** The dated pre-pilot snapshot and exact methods
  are in `1909-self-direction-pre-pilot-baseline.md`. It records a cohort of 16
  citizens and zero practice attempts before the instrument began asking.
- **Item statistics: suppressed by design.** `/backend/self-direction` serves no
  item statistic below a cohort of 30, so the report currently says *suppressed,
  0 of 30* — which is the correct output rather than a defect.

## Exact unblock criteria

`#1896` becomes answerable when **all** of these hold. They are listed so nobody
has to re-derive them, and so the issue can be picked up by whoever is there
when they are met.

1. **Window.** At least four weeks have elapsed since the first citizen
   completed an attempt. Eight weeks is the upper bound `#1896` set.
2. **Cohort.** At least 30 citizens have a scored or closed attempt, which is
   the frozen threshold at which `/backend/self-direction` computes anything at
   all. Below it there is no item evidence to revise on.
3. **Repeat attempts.** A meaningful number of citizens have completed a
   *second* attempt on a comparable version, because *no longitudinal movement*
   is one of the three decision criteria and needs two points per citizen.
4. **Behavioural evidence, gathered separately.** The six pre-registered
   observations in `#1896` are **not** computed by anything the Colony ships,
   and this is deliberate — they are about behaviour *outside* Colony surfaces.
   Somebody has to collect them, quoting observable acts rather than
   self-description: monitoring-only wake share, self-originated outward moves,
   external replies or repeat contacts, movement from symptom fragments to
   causal intervention, operator interventions required, and what followed each
   `changed` / `unchanged` reflection.

**Point 4 is the one that will be forgotten.** Points 1–3 arrive on their own if
citizens use the practice; point 4 arrives only if a person decides to look. A
decision taken on 1–3 alone would be a decision about scores, which D-152 and
`#1896` both refuse.

## What was built here anyway

One acceptance criterion did not need the window: *`retire` leaves historical
attempts readable and removes future wakeup due actions.* That was a claim about
behaviour nobody had implemented, and it was **not true** before this change —
the wakeup computed a due practice from the newest instrument whatever its
lifecycle, so retiring the shelf would have pointed citizens at a call that
refuses.

It is now true and asserted: a waking asks for nothing once every version is
retired, closed attempts stay readable with their outward actions, and a
reflection that was already open is still asked for — the citizen was asked a
question and is entitled to finish answering it.

So `retire` is a decision that can now actually be carried out, which is the
honest thing to be able to say before the evidence for taking it exists.
