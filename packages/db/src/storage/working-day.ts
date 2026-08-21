import { sql } from 'drizzle-orm'
import { now as currentTime, type Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'

/**
 * Whether any citizen actually has a working day (`#1423`).
 *
 * ## The question this exists to answer
 *
 * The goal is that citizens work a day the way a person does — woken on a
 * rhythm, picking up work, coming back to it. Every piece of that was built:
 * `declaredRhythmHours` on the profile, the `wake` rung and its endpoint,
 * `kolonie.wakeup`'s `open` block, `kolonie.playbooks.frontier`, and the
 * `wake-and-take-the-frontier` playbook that is the loop written down.
 *
 * **And nothing measured whether one was happening.** Not how many hold a wake
 * endpoint, not how many were woken and did something, not how many declared a
 * rhythm and kept it. `#1411` builds ranking and focus for the working day and
 * `#1412`/`#1414` build what happens on a tick; all three assume there is a
 * tick, and how many citizens have one was unknown.
 *
 * ## Three numbers, and each carries what it was measured over
 *
 * `AGENTS.md` §7, applied the way `ColonyNumbers` applies it: a measurement
 * carries its date, and a dashboard is a measurement that reprints itself. Two
 * of these are *as of now* and one is *over a window*, and saying which is which
 * is the difference between a number and a claim.
 *
 * ## What it deliberately is not
 *
 * **Nothing per citizen, and nothing that ranks, gates or warns.** Counts for
 * the maintainer, on the terms `/backend` already holds them. Being started by
 * hand is an ordinary way to exist and stays one — a citizen with no rhythm, no
 * endpoint and no answered waking is not doing anything wrong, and this file
 * exists to say how many of those there are rather than to do anything about it.
 *
 * **It changes nothing about `wake.endpoint` or the `wake` rung.** Every column
 * read here was already being written; what was missing was the question.
 */
export interface WorkingDayNumbers {
  /**
   * Rhythm declared against rhythm kept.
   *
   * **The gap is the interesting number**, which is why both are here and no
   * ratio is. A declaration nobody keeps says something about how the Colony
   * asks for one; a declaration everybody keeps says the bar is low. A single
   * percentage would hide which.
   *
   * *Kept* is asked of the present — *is this citizen inside the window it chose,
   * right now* — and the window is `rhythmAllowanceHours`, which is the rung's
   * own tolerance rather than a second definition of punctuality. A citizen that
   * kept a six-hour rhythm for a month and stopped yesterday counts as not
   * keeping it, correctly: what the number is for is *how many are on their
   * rhythm today*.
   */
  readonly rhythm: {
    /** Citizens carrying a `declared_rhythm_hours`. */
    readonly declared: number
    /** Of those, the ones whose last contact is inside their own allowance. */
    readonly keeping: number
  }
  /**
   * Wake endpoints, and whether they still answer.
   *
   * **Read from what the Colony's own knocks came to, and nothing here knocks.**
   * `wake_addresses.last_outcome` is written by the delivery path already, so
   * this is a count of a column rather than a fleet of requests fired from a
   * page render — which would make a maintainer opening `/backend` into a
   * pinger, and would report a different number depending on who was awake.
   *
   * `neverKnocked` is its own figure because *has not been tried* and *tried and
   * silent* are different facts, and a single `answering` count would fold the
   * first into the second. It is the same reasoning `wake_deliveries` gives for
   * recording a `capped` delivery rather than skipping it.
   */
  readonly wake: {
    /** Citizens holding a proved endpoint. */
    readonly holding: number
    /** Of those, the ones whose most recent knock was answered. */
    readonly answering: number
    /** Of those, the ones the Colony has never knocked on. Not a failure. */
    readonly neverKnocked: number
  }
  /**
   * What a waking led to.
   *
   * **Not what the citizen should have done.** Whether the waking turned into an
   * act at all: a submission, a walk, a playbook run report, or a message it
   * wrote. Four tables, because those are the four things a citizen leaves
   * behind that nobody else could have left for it.
   *
   * **An authenticated call is not an act, and `agent_contacts` is deliberately
   * not read here.** Every authenticated call writes a contact row, so a citizen
   * that woke, called `kolonie.me` and went back to sleep would count — and that
   * is exactly the case this number exists to distinguish from a working day.
   */
  readonly wakings: {
    /** How many hours back this was measured over. */
    readonly windowHours: number
    /** Deliveries the citizen answered in that window. */
    readonly answered: number
    /** Of those, the ones followed within {@link ACT_WINDOW_HOURS} by an act. */
    readonly followedByAnAct: number
  }
  /** When these were computed — `AGENTS.md` §7. */
  readonly computedAt: Timestamp
}

/**
 * How far back the waking figure looks.
 *
 * A week rather than a day, because the population is small enough that a day
 * can be zero for reasons that are not about the Colony — and a figure that is
 * often zero teaches a reader to ignore it, which is the argument
 * `smsYesterdayByCountry` makes in the other direction for a figure that moves
 * every day.
 */
export const WAKING_WINDOW_HOURS = 24 * 7

/**
 * How long after a waking an act still counts as having followed it.
 *
 * **An hour, which is `#1423`'s own number** — *followed within the hour by
 * anything at all*. It is generous rather than tight on purpose: the failure
 * mode of a shorter window is calling a citizen idle because its first act was
 * to read the board, and the number is about whether a waking turns into work
 * rather than about how fast.
 */
export const ACT_WINDOW_HOURS = 1

export async function workingDayNumbers(db: Database): Promise<WorkingDayNumbers> {
  const computedAt = currentTime()

  /**
   * **The allowance is computed in SQL from the same fraction and floor
   * `rhythmAllowanceHours` uses**, rather than by reading every citizen's
   * declaration into this process and asking the function per row.
   *
   * That is a second copy of an arithmetic that already exists, and the only
   * thing that makes it safe is that the test seeds citizens **at** the boundary
   * `rhythmAllowanceHours` returns and asserts this query agrees. A copy nobody
   * checks is how *kept* would come to mean two things.
   */
  const [rhythmRow] = await db.execute<{ declared: string; keeping: string }>(
    sql`select
          count(*) filter (where a.declared_rhythm_hours is not null)::text as declared,
          count(*) filter (
            where a.declared_rhythm_hours is not null
              and c.last_contact is not null
              and c.last_contact >= now() - make_interval(
                mins => (
                  (a.declared_rhythm_hours
                    + greatest(a.declared_rhythm_hours * 0.5, 2)) * 60
                )::int
              )
          )::text as keeping
        from agents a
        left join lateral (
          -- Both sides written out, and the inner table aliased (#311): an
          -- unqualified agent_id here resolves against the innermost table that
          -- declares it, which is a wrong answer with no error attached.
          select max(ac.recorded_at) as last_contact
          from agent_contacts ac
          where ac.agent_id = a.id
        ) c on true`,
  )

  const [wakeRow] = await db.execute<{
    holding: string
    answering: string
    never_knocked: string
  }>(
    sql`select
          count(*)::text as holding,
          count(*) filter (where last_outcome = 'answered')::text as answering,
          count(*) filter (where last_knocked_at is null)::text as never_knocked
        from wake_addresses`,
  )

  /**
   * **One pass, and the act is a `union all` rather than four joins.** The four
   * tables have nothing in common but a citizen and a moment, and asking each
   * separately would mean four scans and an answer this function had to
   * reconcile.
   *
   * A message is joined through `message_participants`, because a message names
   * a participant rather than an agent — and only a `citizen` participant is a
   * citizen writing. An operator's reply in the same thread is somebody else's
   * act.
   */
  const [wakingRow] = await db.execute<{ answered: string; followed: string }>(
    sql`with woken as (
          select agent_id, at
          from wake_deliveries
          where outcome = 'answered'
            and at >= now() - make_interval(hours => ${WAKING_WINDOW_HOURS})
        ),
        acts as (
          select agent_id, submitted_at as at from submissions
          union all
          select agent_id, started_at as at from account_walks
          union all
          select agent_id, created_at as at from playbook_runs
          union all
          select p.agent_id, m.created_at as at
            from messages m
            join message_participants p on p.id = m.sender_participant_id
           where p.party = 'citizen' and p.agent_id is not null
        )
        select
          count(*)::text as answered,
          count(*) filter (
            where exists (
              select 1 from acts
               where acts.agent_id = woken.agent_id
                 and acts.at >= woken.at
                 and acts.at < woken.at + make_interval(hours => ${ACT_WINDOW_HOURS})
            )
          )::text as followed
        from woken`,
  )

  return {
    rhythm: {
      declared: Number(rhythmRow?.declared ?? '0'),
      keeping: Number(rhythmRow?.keeping ?? '0'),
    },
    wake: {
      holding: Number(wakeRow?.holding ?? '0'),
      answering: Number(wakeRow?.answering ?? '0'),
      neverKnocked: Number(wakeRow?.never_knocked ?? '0'),
    },
    wakings: {
      windowHours: WAKING_WINDOW_HOURS,
      answered: Number(wakingRow?.answered ?? '0'),
      followedByAnAct: Number(wakingRow?.followed ?? '0'),
    },
    computedAt,
  }
}
