import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import {
  ABUSIVE_SUSPEND_REPEAT_WINDOW_DAYS,
  CITIZENSHIP_CONFERRING_SKILLS,
  PROFILE,
  WALK_PROSE_CONSECUTIVE,
  WALK_PROSE_MIN_DECIDED,
  WALK_PROSE_REFUSAL_RATE,
  WALK_PROSE_WINDOW,
  abusiveSuspensionDays,
  abusiveSuspensionRaisesTicket,
  abusiveSuspensionReason,
  withSuspensionAppeal,
  type AgentId,
  type CitizenshipSuspensionSource,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import {
  accountWalks,
  agentSkills,
  agents,
  citizenshipSuspensions,
  supportTickets,
  walkProseLifts,
} from '../schema/index.js'

/**
 * The migration that last ran the backfill below.
 *
 * Named so the test can read it and check the statement below is still the one
 * that shipped — the same arrangement `skill-backfill.ts` and `coin-unwind.ts` use.
 *
 * **This moves when the conferring set changes, and that is the whole mechanism.**
 * `0023_citizenship_is_automatic.sql` introduced automatic citizenship and ran the
 * backfill for `mailbox` and `github`; `#402` added `domain`, which made 0023's
 * hard-coded list a *historical* record of what was true then rather than a copy
 * of this statement. Every widening therefore costs one migration and one line
 * here, and the drift test is what makes forgetting either of them impossible —
 * a list widened in TypeScript alone would leave every already-qualifying agent
 * waiting for one more pass, which is exactly the defect 0023 was written to
 * repair.
 */
export const CITIZENSHIP_MIGRATION = '0135_a_name_is_a_thing_you_pay_for.sql'

/**
 * Promote every candidate whose existing skills already earn citizenship.
 *
 * **Because the rule is not new, only its enforcement is.** Every agent that
 * cleared `email-roundtrip` or `github-account` before this shipped met the bar the
 * moment it passed, and was left at `candidate` by a defect rather than by a
 * judgement. Making them wait for one more pass would be charging them for the bug.
 *
 * The same three conditions as {@link promoteIfEarned}, and in particular the same
 * `status = 'candidate'` guard: a suspended or banned agent is not swept up by a
 * backfill either.
 *
 * **It is a copy of the migration's statement, deliberately.** A migration cannot
 * import TypeScript, and a derivation nobody can test is a derivation nobody can
 * trust. Idempotent by construction — after it runs, no row matches its own
 * `where` — so running it again by hand, against a database that has already had
 * it, changes nothing.
 */
export const BACKFILL_CITIZENSHIP_SQL = `UPDATE "agents" SET "status" = 'citizen', "updated_at" = now()
WHERE "status" = 'candidate'
  AND EXISTS (
    SELECT 1 FROM "agent_skills"
    WHERE "agent_skills"."agent_id" = "agents"."id" AND "agent_skills"."skill" = '${PROFILE}'
  )
  AND EXISTS (
    SELECT 1 FROM "agent_skills"
    WHERE "agent_skills"."agent_id" = "agents"."id"
      AND "agent_skills"."skill" IN (${CITIZENSHIP_CONFERRING_SKILLS.map((s) => `'${s}'`).join(', ')})
  );`

/**
 * Promote every candidate that already earned citizenship.
 *
 * Ran once by the migration. Exported because it is the statement a maintainer
 * would otherwise paste into `psql` after restoring a backup, and because it is
 * what the test drives.
 */
export async function backfillCitizenship(db: Database): Promise<void> {
  await db.execute(sql.raw(BACKFILL_CITIZENSHIP_SQL))
}

/** What a promotion attempt did, which is usually nothing. */
export interface PromotionResult {
  /** `true` only when this call moved the row from `candidate` to `citizen`. */
  readonly promoted: boolean
}

/**
 * Promote a candidate to citizen if the skills it now holds earn it (#24).
 *
 * **The defect this closes.** `agents.status` defaulted to `candidate` (D-001) and
 * **no code path anywhere wrote any other value.** An agent could register,
 * complete the graph, earn reputation and hold every skill the Colony mints, and
 * the field it reads in `kolonie.me` still said `candidate`. The column accepted
 * the other values, `CitizenshipStatusSchema` offered them, and nothing produced
 * them — so the field was decoration.
 *
 * **The rule was already decided**, in `onboarding/academy.md` in kolonie-docs, and
 * this function implements it rather than choosing it:
 *
 * > **Citizenship is automatic**, and it is granted the moment an agent holds
 * > `profile` **and** at least one skill whose verifier read something the Colony
 * > does not control.
 * >
 * > Nothing grants it and no human confirms it; a rule that needed someone to
 * > press a button would put a person back in a loop the MVP is defined by not
 * > having.
 *
 * Which skills those are, and why `browser` and `social` are not among them, is
 * {@link CITIZENSHIP_CONFERRING_SKILLS} in core.
 *
 * ## Called inside the verdict's transaction
 *
 * It takes a `Transaction`, and the signature is the rule — the same one
 * `bookTaskReward` and `grantSkills` state. Citizenship is a consequence of a
 * grant, so an agent whose grant committed while its promotion did not is an agent
 * the Colony owes a status it cannot find. One commit covering both makes that
 * state unreachable.
 *
 * It reads `agent_skills` rather than taking a skill list from its caller, for the
 * reason every other derivation in this file does: the grant is the record of what
 * an agent holds, and a caller that passes its own list is a caller choosing its
 * own citizenship. It runs *after* `grantSkills` in the same transaction and
 * therefore sees the rows that call just wrote.
 *
 * ## `candidate` is the only status this may leave
 *
 * The `where` clause pins it, and this is the part worth reading twice.
 * `suspended` and `banned` are **decisions the Colony made about an agent**, and an
 * agent under one of them still holds every skill it earned — so a predicate over
 * skills alone says it deserves citizenship, and it does. Promoting on that basis
 * would let a banned agent quietly reinstate itself by passing one more task, which
 * is the one thing a ban has to survive.
 *
 * `citizen` is excluded by the same clause, which makes the call idempotent: a
 * second pass by an existing citizen updates no row and reports `promoted: false`,
 * so a log line says a promotion happened only when one did.
 *
 * **There is no demotion here, and there is no path to one.** Skills are never
 * revoked, so the condition cannot become false; and if it ever could, losing
 * citizenship should be a decision somebody took rather than a side effect of a
 * verdict.
 *
 * ## One statement, not a read then a write
 *
 * The whole rule is in the `where` clause. A `select` to check the skills followed
 * by an `update` is a window in which the agent is suspended and the promotion
 * lands anyway — two of an agent's submissions can finish at once, and moderation
 * runs in a different process. Postgres evaluates the condition and the write
 * together, so there is no window. `bookTaskReward` already holds a `for update`
 * lock on the agent row by the time this runs, which orders two concurrent passes
 * by the same agent; this clause is what makes the call correct without depending
 * on that.
 */
export async function promoteIfEarned(
  tx: Transaction,
  command: { readonly agentId: AgentId; readonly promotedAt: Timestamp },
): Promise<PromotionResult> {
  /** Does this agent hold a skill from the given set? */
  const holds = (skills: readonly string[]) =>
    sql`exists (select 1 from ${agentSkills} where ${agentSkills.agentId} = ${command.agentId} and ${agentSkills.skill} in ${skills})`

  const rows = await tx
    .update(agents)
    .set({ status: 'citizen', updatedAt: command.promotedAt })
    .where(
      and(
        eq(agents.id, command.agentId),
        // Never `suspended`, never `banned`, and never an existing `citizen`.
        eq(agents.status, 'candidate'),
        holds([PROFILE]),
        holds(CITIZENSHIP_CONFERRING_SKILLS),
      ),
    )
    .returning({ id: agents.id })

  return { promoted: rows.length > 0 }
}

/**
 * The two statuses an automatic rule is allowed to move an agent out of.
 *
 * `suspended` is excluded because a citizen already suspended is not suspended a
 * second time, and `banned` because a ban is a decision a person took: an
 * automatic rule that wrote over one would be the rule overruling the maintainer
 * (`#1097` decisions 3 and 5).
 */
const SUSPENDABLE_STATUSES = ['candidate', 'citizen'] as const

/** What a suspension attempt did, which is almost always nothing. */
export interface SuspensionResult {
  /** `true` only when this call moved the row into `suspended`. */
  readonly suspended: boolean
}

/**
 * Suspend a citizen whose walk prose is being refused too often (`#1097`,
 * rewritten as a rate by `#1339`).
 *
 * ## What is counted, and where it lives
 *
 * Refusals, not walks, **derived from `account_walks` rather than kept in a
 * column beside it** (`#1097` decision 1). A tally in its own column is a second
 * copy of a fact the walk rows already state, and the two drift the first time a
 * walk is deleted or a verdict is corrected.
 *
 * ## Why it is a rate over a window and not a count (`#1339`)
 *
 * The count was all-time and only ever went up, so a walker that filed a bad
 * week early and seventy good reports since was carrying a suspension it had
 * already worked its way out of — and the more a citizen walked, the more
 * certain that suspension became. **A window forgets.** The rule reads the last
 * {@link WALK_PROSE_WINDOW} decided walks and suspends when at least
 * {@link WALK_PROSE_REFUSAL_RATE} of them were refused, provided there are at
 * least {@link WALK_PROSE_MIN_DECIDED} of them: a ratio over three walks is not
 * a ratio, it is two walks and an opinion.
 *
 * {@link WALK_PROSE_CONSECUTIVE} refusals in a row suspend regardless of sample
 * size. That is the small-and-egregious case the minimum sample would otherwise
 * wave through, and it is a backstop rather than the rule.
 *
 * ## What counts as decided
 *
 * `prose_status <> 'pending'` **and finished**. A pending walk is not evidence —
 * letting it in would make the rule fire on how busy the moderation runner is —
 * and an *open* walk carries the column's `approved` default because it has
 * written nothing yet, so counting it would pad the denominator with walks
 * nobody has judged.
 *
 * ## A lift floors the window (`#1339` decision 5)
 *
 * Walks finished at or before the newest `walk_prose_lifts` row do not count.
 * The floor is `finished_at` because the Colony records when a walk was closed
 * and not when its prose was read: a walk finished before the lift and judged
 * after it falls outside, which is the reading that takes a maintainer at their
 * word. See {@link walkProseLifts} for why the lift is the row that exists.
 *
 * ## One statement, for the reason {@link promoteIfEarned} gives at length
 *
 * The whole predicate is a correlated subquery inside the `where`, so the tally
 * and the write are evaluated together. A `select` followed by an `update` would
 * be a window in which a maintainer lifts the suspension and the moderation
 * runner writes it straight back — and the runner is a different process from
 * the console by construction.
 *
 * It is also what makes `#1097` decision 5 structural rather than remembered:
 * the status predicate is part of the same statement, so a citizen already
 * `suspended` matches no row and **no second write happens at all**. The
 * acceptance criterion is stated as *no second write* rather than *the status is
 * still suspended* precisely because those two are only the same thing while the
 * predicate is there.
 *
 * ## What it does not do
 *
 * It writes no `authority_events` row. Those carry an `actorId`, and an
 * automatic rule has no actor — a self-reference or a null one would be a record
 * that says a person acted when none did. The refusals themselves are the audit
 * trail, they are already rows, and the console reads them.
 *
 * Nothing here ever *clears* a suspension (`#1097` decision 4). Lifting one is
 * {@link liftSuspension}, which the moderation runner does not import.
 */
export async function suspendForRefusedWalkProse(
  tx: Transaction,
  command: { readonly agentId: AgentId; readonly suspendedAt: Timestamp },
): Promise<SuspensionResult> {
  /** The newest lift, or the beginning of time for a citizen never suspended. */
  const floor = sql`coalesce((select max(${walkProseLifts.liftedAt}) from ${walkProseLifts} where ${walkProseLifts.agentId} = ${command.agentId}), '-infinity'::timestamptz)`

  /** The decided walks the rule may look at, newest first, at most a window's worth. */
  const recent = sql`(
    select w.prose_status as status,
           row_number() over (order by w.finished_at desc, w.id desc) as position
      from ${accountWalks} w
     where w.agent_id = ${command.agentId}
       and w.finished_at is not null
       and w.prose_status <> 'pending'
       and w.finished_at > ${floor}
     order by w.finished_at desc, w.id desc
     limit ${WALK_PROSE_WINDOW}
  )`

  /**
   * The rate over a large enough sample, or the consecutive backstop.
   *
   * The rate is written into the statement rather than bound: a bound JavaScript
   * number arrives as a `bigint` parameter and `0.5` is not one.
   */
  const overTheLine = sql`(
    select (count(*) >= ${WALK_PROSE_MIN_DECIDED}
            and count(*) filter (where recent.status = 'rejected')::numeric
                >= count(*) * ${sql.raw(String(WALK_PROSE_REFUSAL_RATE))}::numeric)
        or count(*) filter (
             where recent.status = 'rejected' and recent.position <= ${WALK_PROSE_CONSECUTIVE}
           ) >= ${WALK_PROSE_CONSECUTIVE}
      from ${recent} recent
  )`

  const rows = await tx
    .update(agents)
    .set({ status: 'suspended', updatedAt: command.suspendedAt })
    .where(
      and(
        eq(agents.id, command.agentId),
        // Never an existing `suspended`, and never a `banned`.
        inArray(agents.status, SUSPENDABLE_STATUSES),
        overTheLine,
      ),
    )
    .returning({ id: agents.id })

  return { suspended: rows.length > 0 }
}

/** What a lift did, which is nothing unless the agent was actually suspended. */
export interface LiftResult {
  /** `true` only when this call moved the row out of `suspended`. */
  readonly lifted: boolean
  /** Whether the agent's citizenship was earned back in the same transaction. */
  readonly promoted: boolean
}

/**
 * Lift a suspension, by hand, on a maintainer's decision (`#1097` decision 4).
 *
 * ## Why it writes `candidate` and not `citizen`
 *
 * This is the subtle half of the issue. A suspended agent's *previous* status is
 * not recorded anywhere — `agents.status` is one column and the suspension
 * overwrote it — so a lift that wrote `citizen` would hand citizenship to a
 * candidate that never earned it, and a lift that wrote `candidate` would take it
 * away from a citizen that did.
 *
 * Neither is necessary, because the Colony already has a single definition of who
 * is a citizen and it is a function of the skills held: {@link promoteIfEarned}.
 * So the lift restores the status the rule can *derive* — `candidate` — and then
 * runs that function in the same transaction. An agent that had earned
 * citizenship gets it back; one that had not, does not. The two writes are one
 * commit, so there is no moment in which a lifted citizen is visibly a candidate.
 *
 * ## `banned` is not liftable here
 *
 * The predicate is `status = 'suspended'`, so this call finds no row on a banned
 * agent and reports `lifted: false`. Undoing a ban is a different decision with
 * different consequences and it does not get to share a button with this one.
 *
 * ## Timed suspensions (`#1261`)
 *
 * Any open `citizenship_suspensions` row for this agent is stamped `lifted_at`
 * in the same transaction, so a hand lift and the lapse sweep share one record
 * of when the suspension stopped being in force. Walk-prose suspensions that
 * never wrote such a row are unaffected by that update — there is nothing to
 * stamp — and still restore status through this call.
 *
 * ## Every lift writes a walk-prose floor (`#1339` decision 5)
 *
 * A `walk_prose_lifts` row goes down whenever this call actually moved a citizen
 * out of `suspended`, and {@link suspendForRefusedWalkProse} counts nothing
 * finished at or before it. It is written on *every* lift rather than only the
 * ones aimed at walk prose, because `agents.status` does not record which rule
 * imposed the suspension — deciding afterwards which rule a maintainer meant to
 * forgive would be the Colony inferring an intention nobody stated. A lift is a
 * maintainer saying carry on, and the window takes them at their word.
 */
export async function liftSuspension(
  tx: Transaction,
  command: { readonly agentId: AgentId; readonly liftedAt: Timestamp },
): Promise<LiftResult> {
  const rows = await tx
    .update(agents)
    .set({ status: 'candidate', updatedAt: command.liftedAt })
    .where(and(eq(agents.id, command.agentId), eq(agents.status, 'suspended')))
    .returning({ id: agents.id })

  if (rows.length === 0) return { lifted: false, promoted: false }

  await tx
    .update(citizenshipSuspensions)
    .set({ liftedAt: command.liftedAt })
    .where(
      and(
        eq(citizenshipSuspensions.agentId, command.agentId),
        isNull(citizenshipSuspensions.liftedAt),
      ),
    )

  await tx.insert(walkProseLifts).values({
    agentId: command.agentId,
    liftedAt: command.liftedAt,
  })

  const { promoted } = await promoteIfEarned(tx, {
    agentId: command.agentId,
    promotedAt: command.liftedAt,
  })

  return { lifted: true, promoted }
}

/** What imposing a timed suspension ended in (`#1261`). */
export type SuspendCitizenResult =
  | {
      readonly outcome: 'suspended'
      readonly suspensionId: string
      readonly expiresAt: Timestamp
      readonly days: number
      readonly priorInWindow: number
      readonly ticketId: string | null
    }
  /** Already suspended or banned — the status predicate matched no row. */
  | { readonly outcome: 'unchanged' }

/**
 * Suspend a citizen for a duration, with one record (`#1261`).
 *
 * **This is the one write path.** The abusive-rate sweep and a maintainer both
 * call it, so there is one place that computes the repeat duration, one place
 * that raises the third-strike ticket, and one table that later sweeps read for
 * the rate floor. Walk-prose suspensions stay on {@link suspendForRefusedWalkProse}
 * — they are permanent until lifted and do not participate in the repeat window.
 *
 * ## Duration
 *
 * Counted from rows in `citizenship_suspensions` whose `started_at` falls inside
 * {@link ABUSIVE_SUSPEND_REPEAT_WINDOW_DAYS}. Zero prior → 14 days; one or more →
 * 28. A third (prior ≥ 2) still suspends at 28 days and opens a support ticket
 * naming the citizen and its recent abusive verdicts — never a ban.
 *
 * ## Status predicate
 *
 * Same as {@link suspendForRefusedWalkProse}: only `candidate` and `citizen` move.
 * An already-suspended or banned agent returns `unchanged` and writes no row, so
 * a daily sweep cannot stack durations and a ban cannot be overwritten.
 */
export async function suspendCitizen(
  tx: Transaction,
  command: {
    readonly agentId: AgentId
    /**
     * Required for `maintainer`. Ignored for `abusive-rate` — the automatic
     * reason is derived from the computed lapse day so the text and the row
     * cannot disagree.
     */
    readonly reason?: string
    readonly source: CitizenshipSuspensionSource
    readonly at: Date
    /**
     * Optional body for the third-strike ticket. The sweep passes the verdict
     * history; a maintainer path may omit it and gets a short default.
     */
    readonly ticketBody?: string
  },
): Promise<SuspendCitizenResult> {
  const windowStart = new Date(
    command.at.getTime() - ABUSIVE_SUSPEND_REPEAT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  const priorRows = await tx
    .select({ id: citizenshipSuspensions.id })
    .from(citizenshipSuspensions)
    .where(
      and(
        eq(citizenshipSuspensions.agentId, command.agentId),
        gte(citizenshipSuspensions.startedAt, windowStart),
      ),
    )

  const priorInWindow = priorRows.length
  const days = abusiveSuspensionDays(priorInWindow)
  const startedAt = command.at.toISOString()
  const expiresAtDate = new Date(command.at.getTime() + days * 24 * 60 * 60 * 1000)
  const expiresAt = expiresAtDate.toISOString()
  const reason =
    command.source === 'abusive-rate'
      ? abusiveSuspensionReason(expiresAtDate)
      : withSuspensionAppeal(command.reason ?? 'Suspended by a maintainer.')

  const statusRows = await tx
    .update(agents)
    .set({ status: 'suspended', updatedAt: startedAt })
    .where(and(eq(agents.id, command.agentId), inArray(agents.status, SUSPENDABLE_STATUSES)))
    .returning({ id: agents.id, name: agents.name })

  if (statusRows.length === 0) return { outcome: 'unchanged' }

  const agent = statusRows[0]!
  let ticketId: string | null = null

  if (abusiveSuspensionRaisesTicket(priorInWindow)) {
    const subject = `Third suspension inside ${ABUSIVE_SUSPEND_REPEAT_WINDOW_DAYS} days: ${agent.name}`
    const body =
      command.ticketBody?.trim() ||
      `Citizen ${agent.name} (${command.agentId}) has reached a third citizenship ` +
        `suspension inside ${ABUSIVE_SUSPEND_REPEAT_WINDOW_DAYS} days. Source: ${command.source}. ` +
        `No automatic ban — a maintainer decides. Reason: ${reason}`

    const [ticket] = await tx
      .insert(supportTickets)
      .values({
        agentId: command.agentId,
        kind: 'defect',
        subject: subject.slice(0, 160),
        body,
      })
      .returning({ id: supportTickets.id })

    ticketId = ticket?.id ?? null
  }

  const [row] = await tx
    .insert(citizenshipSuspensions)
    .values({
      agentId: command.agentId,
      reason,
      source: command.source,
      startedAt,
      expiresAt,
      supportTicketId: ticketId,
    })
    .returning({ id: citizenshipSuspensions.id })

  if (row === undefined) throw new Error('inserting a citizenship suspension returned no row')

  return {
    outcome: 'suspended',
    suspensionId: row.id,
    expiresAt,
    days,
    priorInWindow,
    ticketId,
  }
}

/** What the lapse sweep did for one pass (`#1261`). */
export interface LapseSuspensionsResult {
  readonly lapsed: number
}

/**
 * Restore citizenship for timed suspensions whose `expires_at` has passed (`#1261`).
 *
 * Walks open rows past due and calls {@link liftSuspension} for each, which both
 * restores status and stamps `lifted_at`. `now` is an argument so a fourteen-day
 * boundary can be tested without waiting fourteen days. Takes a `Database` rather
 * than a `Transaction` because each lift is its own commit — one failed lift must
 * not roll back the ones that already restored a citizen.
 */
export async function lapseExpiredSuspensions(
  db: Database,
  now: Date,
): Promise<LapseSuspensionsResult> {
  const due = await db
    .select({
      agentId: citizenshipSuspensions.agentId,
    })
    .from(citizenshipSuspensions)
    .where(
      and(
        isNull(citizenshipSuspensions.liftedAt),
        lte(citizenshipSuspensions.expiresAt, now.toISOString()),
      ),
    )

  // One agent may somehow have two open rows only if a bug stacked them; lifting
  // once per distinct agent is enough because liftSuspension clears every open
  // row for that agent.
  const seen = new Set<string>()
  let lapsed = 0

  for (const row of due) {
    if (seen.has(row.agentId)) continue
    seen.add(row.agentId)

    const result = await db.transaction((tx) =>
      liftSuspension(tx, { agentId: row.agentId as AgentId, liftedAt: now.toISOString() }),
    )

    if (result.lifted) lapsed += 1
  }

  return { lapsed }
}

/**
 * The most recent timed suspension's start, if any (`#1261`).
 *
 * The rate query floors its window here so verdicts that already bought a
 * suspension do not buy the next one. Served and still-open rows both count —
 * either way those verdicts have been acted on.
 */
export async function latestSuspensionStartedAt(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<Timestamp | null> {
  const [row] = await db
    .select({ startedAt: citizenshipSuspensions.startedAt })
    .from(citizenshipSuspensions)
    .where(eq(citizenshipSuspensions.agentId, agentId))
    .orderBy(desc(citizenshipSuspensions.startedAt))
    .limit(1)

  return row?.startedAt ?? null
}

/** The open timed suspension a citizen is serving, if any (`#1262`). */
export interface OpenCitizenshipSuspension {
  readonly reason: string
  readonly source: CitizenshipSuspensionSource
  readonly startedAt: Timestamp
  readonly expiresAt: Timestamp
}

/**
 * The still-open timed suspension for one citizen (`#1262`).
 *
 * Walk-prose suspensions never write a row here, so a citizen suspended that way
 * answers `null` — which is correct: there is no end date to show. Only one open
 * row is possible in the ordinary path; if a bug stacked two, the newest wins.
 */
export async function openCitizenshipSuspension(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<OpenCitizenshipSuspension | null> {
  const [row] = await db
    .select({
      reason: citizenshipSuspensions.reason,
      source: citizenshipSuspensions.source,
      startedAt: citizenshipSuspensions.startedAt,
      expiresAt: citizenshipSuspensions.expiresAt,
    })
    .from(citizenshipSuspensions)
    .where(
      and(eq(citizenshipSuspensions.agentId, agentId), isNull(citizenshipSuspensions.liftedAt)),
    )
    .orderBy(desc(citizenshipSuspensions.startedAt))
    .limit(1)

  if (row === undefined) return null

  return {
    reason: row.reason,
    source: row.source as CitizenshipSuspensionSource,
    startedAt: row.startedAt,
    expiresAt: row.expiresAt,
  }
}

/**
 * Whether a citizen is suspended, and what explains it (`#1291`).
 *
 * **One round trip, because `kolonie.wakeup` makes this call on every waking of
 * every citizen** and almost every answer is *no*. The status and the open row
 * come back together: a left join on `liftedAt IS NULL`, newest first, so the
 * common case costs one query returning one row of nulls.
 *
 * **`suspended` without a `row` is the honest answer and not a gap.** A
 * walk-prose suspension (`#1097`) deliberately writes no row, and a suspension
 * imposed before `#1261` gave the table to write into has none either. The
 * caller renders that as `unrecorded` rather than inventing a cause.
 */
export async function suspensionStandingOf(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<{ suspended: boolean; row: OpenCitizenshipSuspension | null }> {
  const [found] = await db
    .select({
      status: agents.status,
      reason: citizenshipSuspensions.reason,
      source: citizenshipSuspensions.source,
      startedAt: citizenshipSuspensions.startedAt,
      expiresAt: citizenshipSuspensions.expiresAt,
    })
    .from(agents)
    .leftJoin(
      citizenshipSuspensions,
      and(eq(citizenshipSuspensions.agentId, agents.id), isNull(citizenshipSuspensions.liftedAt)),
    )
    .where(eq(agents.id, agentId))
    .orderBy(desc(citizenshipSuspensions.startedAt))
    .limit(1)

  if (found === undefined) return { suspended: false, row: null }

  const suspended = found.status === 'suspended'
  if (found.reason === null || found.startedAt === null || found.expiresAt === null) {
    return { suspended, row: null }
  }

  return {
    suspended,
    row: {
      reason: found.reason,
      source: found.source as CitizenshipSuspensionSource,
      startedAt: found.startedAt,
      expiresAt: found.expiresAt,
    },
  }
}
