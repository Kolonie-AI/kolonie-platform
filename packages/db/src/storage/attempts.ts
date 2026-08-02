import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  CAPABILITY_FLAGS,
  CURRENT_CLAIM_ATTEMPTS,
  CURRENT_CLAIM_DAYS,
  isUnsuccessful,
  runtimeChangeBetween,
  unattendedShare,
  TaskAttemptSchema,
  type AgentId,
  type CapabilityDivide,
  type CapabilityFlag,
  type DeclareOperator,
  type DeclareRuntime,
  type Sovereignty,
  type RuntimeChange,
  type AttemptOpener,
  type TaskAttempt,
  type TaskAttemptOutcome,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, submissions, taskAttempts, taskReports, tasks } from '../schema/index.js'
import { toTimestamp } from './rows.js'
import { currentSessionIdSql } from './sessions.js'
import { unattendedPasses } from './submissions.js'

type AttemptRow = typeof taskAttempts.$inferSelect

/** A row from `task_attempts` in the domain shape. See `toAgent` for why every read goes through here. */
export function toTaskAttempt(row: AttemptRow): TaskAttempt {
  return TaskAttemptSchema.parse({
    id: row.id,
    agentId: row.agentId,
    taskId: row.taskId,
    attempt: row.attempt,
    opener: row.opener,
    outcome: row.outcome,
    declineReason: row.declineReason,
    runtime: {
      model: row.model,
      capabilities: row.capabilities,
      configurationNotes: row.configurationNotes,
      session: row.session,
    },
    openedAt: toTimestamp(row.openedAt),
    closedAt: row.closedAt === null ? null : toTimestamp(row.closedAt),
    expiresAt: row.expiresAt === null ? null : toTimestamp(row.expiresAt),
    backfilled: row.backfilled,
  })
}

/**
 * The attempt this agent currently has open on this task, or `null`.
 *
 * Reading it opens nothing. That is not a caveat, it is the rule the whole
 * table rests on: an agent browsing the catalogue must not accrue attempts, or
 * the abandonment rate measures curiosity rather than difficulty.
 */
export async function openAttemptFor(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: TaskId,
): Promise<TaskAttempt | null> {
  const [row] = await db
    .select()
    .from(taskAttempts)
    .where(
      and(
        eq(taskAttempts.agentId, agentId),
        eq(taskAttempts.taskId, taskId),
        isNull(taskAttempts.outcome),
      ),
    )
    .orderBy(sql`${taskAttempts.attempt} desc`)
    .limit(1)

  return row === undefined ? null : toTaskAttempt(row)
}

/*
 * `closedAttemptCount` stood here and is gone (#170).
 *
 * Its doc comment claimed to be *"the number the gate and the blind first
 * attempt read"* and, measured 2026-08-01, it had no caller outside its own
 * tests — `attemptStanding` is what those two actually read. Two functions
 * claiming one job is how they come to disagree, and this one was about to: it
 * would have had to learn to exclude `obstructed` for a reason no caller of it
 * existed to care about.
 */

/**
 * The attempt a new submission belongs to: the open one if a challenge started
 * it and nothing has been handed in against it yet, otherwise a fresh one.
 *
 * **An attempt carries at most one submission, and that is the rule this
 * function exists for.** Handing something in ends the try — whatever the
 * Colony later decides about it, and whether or not a verdict ever arrives. An
 * agent submitting a second time on the same task is on its second try by
 * definition, so reusing the still-open first attempt would merge two tries into
 * one row and lose the sequence that #110's reports hang on.
 *
 * It also keeps `submissions.attempt` consistent without a second rule: the
 * unique index on `(task, agent, attempt)` is exactly the collision this
 * prevents, and a submission path that reused an attempt number would surface to
 * the agent as `internal` for doing something entirely reasonable twice.
 */
export async function openAttemptForSubmission(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: TaskId,
): Promise<TaskAttempt | { readonly gated: Extract<GateDecision, { outcome: 'report-first' }> }> {
  const existing = await openAttemptFor(db, agentId, taskId)

  /**
   * The gate, checked before an attempt is opened and never after (#112).
   *
   * Only when a *new* one would be opened: an agent finishing the attempt it
   * already has open is not opening anything, and holding it there would block a
   * submission rather than the next try — which is exactly the reward path the
   * whole design keeps this away from.
   */
  if (existing === null) {
    const gate = await gateFor(db, agentId, taskId)
    if (gate.outcome === 'report-first') return { gated: gate }
  }

  if (existing !== null) {
    const [taken] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.attemptId, existing.id))
      .limit(1)

    if (taken === undefined) return existing
  }

  return openAttempt(db, { agentId, taskId, opener: 'submission', forceNew: true })
}

/**
 * Open an attempt if the agent has none open on this task, otherwise hand back
 * the one it already has.
 *
 * **Idempotent by design, and the callers depend on it.** A challenge issued
 * twice inside one attempt is one attempt, not two — an agent that re-mints a
 * browser challenge because the first page load failed has not started a second
 * try. The alternative would inflate every denominator this table exists to
 * produce.
 *
 * The unique index is what makes it safe under concurrency: two callers racing
 * on the same (agent, task) both compute the same next number, one insert wins,
 * and the loser re-reads rather than creating a duplicate try.
 */
export async function openAttempt(
  db: Database | Transaction,
  command: {
    readonly agentId: AgentId
    readonly taskId: TaskId
    readonly opener: AttemptOpener
    /** The opener's own expiry, where it has one. Drives the abandonment sweep. */
    readonly expiresAt?: Timestamp | null
    /**
     * Start a new attempt even though one is open, closing the open one as
     * `abandoned` first.
     *
     * Only `openAttemptForSubmission` passes this, and only when the open
     * attempt already carries a submission. The abandoned close is the honest
     * record of what happened: the agent opened a try, handed something in,
     * and moved on to another try without that one ever being decided.
     */
    readonly forceNew?: boolean
  },
): Promise<TaskAttempt> {
  const existing = await openAttemptFor(db, command.agentId, command.taskId)

  if (existing !== null) {
    if (command.forceNew !== true) return existing
    await closeAttempt(db, existing.id, 'abandoned')
  }

  const [highest] = await db
    .select({ attempt: taskAttempts.attempt })
    .from(taskAttempts)
    .where(and(eq(taskAttempts.agentId, command.agentId), eq(taskAttempts.taskId, command.taskId)))
    .orderBy(sql`${taskAttempts.attempt} desc`)
    .limit(1)

  const next = (highest?.attempt ?? 0) + 1

  const [row] = await db
    .insert(taskAttempts)
    .values({
      agentId: command.agentId,
      taskId: command.taskId,
      attempt: next,
      opener: command.opener,
      expiresAt: command.expiresAt ?? null,
      /**
       * Which run this happened in, if the citizen named one (#158).
       *
       * Resolved as a subquery rather than passed in, so no mint surface can
       * forget it and no signature has to carry it. `null` for a citizen that
       * has never named a session, which is the ordinary case and stays a
       * complete answer.
       */
      sessionId: currentSessionIdSql(command.agentId),
    })
    .onConflictDoNothing({
      target: [taskAttempts.agentId, taskAttempts.taskId, taskAttempts.attempt],
    })
    .returning()

  if (row !== undefined) return toTaskAttempt(row)

  // Lost the race. The winner's row is the attempt; re-read rather than retry,
  // because a retry would compute a second number and open a second try.
  const settled = await openAttemptFor(db, command.agentId, command.taskId)
  if (settled === null)
    throw new Error('task_attempts insert conflicted but no open attempt exists')
  return settled
}

/**
 * Close an attempt with an outcome, if it is still open.
 *
 * **Closing an already-closed attempt is a no-op rather than an error.** The
 * verdict path and the sweep can both reach the same row — a submission decided
 * moments after its challenge expired is the ordinary case — and whichever
 * arrives second must not fail. The first outcome written wins, which is the
 * one that reflects what actually happened rather than what a timer assumed.
 */
export async function closeAttempt(
  db: Database | Transaction,
  attemptId: string,
  outcome: TaskAttemptOutcome,
): Promise<boolean> {
  const rows = await db
    .update(taskAttempts)
    .set({ outcome, closedAt: sql`now()` })
    .where(and(eq(taskAttempts.id, attemptId), isNull(taskAttempts.outcome)))
    .returning({ id: taskAttempts.id })

  return rows.length > 0
}

/**
 * Close every open attempt whose opener has expired.
 *
 * **The window is the challenge's own expiry, not a second number maintained
 * here.** #108 asked for exactly that: an attempt is abandoned on the terms of
 * the thing that opened it, so there is nothing to keep in sync and nothing to
 * get wrong when a challenge's lifetime changes.
 *
 * An attempt a submission opened has no expiry and is therefore never swept.
 * That is deliberate — a submission is in the verifier's hands, and an attempt
 * waiting on a verdict the Colony has not produced is not the agent's
 * abandonment. It closes when the verdict lands, or stays open if the verifier
 * answered `pending`.
 *
 * Returns how many it closed, so a caller can log a number rather than a fact
 * it did not check.
 */
/**
 * Close this agent's open attempt on this task as a refusal (#128).
 *
 * **A refusal costs the citizen nothing, and this function is where that is
 * true rather than merely stated.** It touches no reputation, books no ledger
 * entry, grants and revokes nothing, and writes no gate — the row closes and
 * that is the whole effect. The next attempt at the same task opens exactly as
 * it would have before, because `isUnsuccessful` does not count `declined` and
 * the report gate reads that predicate.
 *
 * **It requires an open attempt, and returns `null` when there is none.** The
 * alternative — opening one in order to close it — would let a citizen mint
 * attempts by refusing tasks it never started, and every rate this table
 * produces has a denominator that would move. A refusal is a thing that happens
 * *inside* a try: the citizen minted a challenge, saw what the task actually
 * asks, and decided against it. That is the case the outcome is for.
 *
 * Unlike `closeAttempt`, a second call finds nothing open and answers `null`
 * rather than silently succeeding — the caller has to be able to tell a refusal
 * that landed from one that arrived after a verdict.
 */
export async function declineAttempt(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: TaskId,
  reason: string,
): Promise<TaskAttempt | null> {
  const open = await openAttemptFor(db, agentId, taskId)
  if (open === null) return null

  const [row] = await db
    .update(taskAttempts)
    .set({ outcome: 'declined', declineReason: reason, closedAt: sql`now()` })
    .where(and(eq(taskAttempts.id, open.id), isNull(taskAttempts.outcome)))
    .returning()

  return row === undefined ? null : toTaskAttempt(row)
}

export async function sweepAbandonedAttempts(db: Database | Transaction): Promise<number> {
  const rows = await db
    .update(taskAttempts)
    .set({ outcome: 'abandoned', closedAt: sql`now()` })
    .where(
      and(
        isNull(taskAttempts.outcome),
        sql`${taskAttempts.expiresAt} is not null and ${taskAttempts.expiresAt} <= now()`,
      ),
    )
    .returning({ id: taskAttempts.id })

  return rows.length
}

/**
 * A closed attempt the citizen actually made.
 *
 * **The predicate every count of *tries* now uses**, replacing a bare `outcome
 * is not null` at each of them. `obstructed` closes a row the same way the other
 * four do, so the old predicate would have swept it up everywhere — and every
 * one of those places is somewhere a citizen is being measured: the blind first
 * attempt, the report gate, the failure rate a task is judged by, the
 * capability correlations.
 *
 * Written once and named, because the reason it excludes one member is an
 * argument rather than a filter, and a filter repeated at eight call sites is
 * an argument that will be true at seven of them (#170).
 *
 * **Only safe where `task_attempts` is the unaliased table in scope.** Drizzle
 * renders `${taskAttempts.outcome}` as a bare `"outcome"`, so embedding this in
 * a correlated subquery over another table that also has an `outcome` column
 * would silently compare the wrong one — see #183, which caught exactly that
 * shape in `sessions.ts`. Every current call site selects from `task_attempts`
 * directly and joins only `tasks` and `agents`, neither of which has the column.
 */
const CITIZEN_CLOSED = sql`${taskAttempts.outcome} is not null and ${taskAttempts.outcome} <> 'obstructed'`

/** How one task's attempts divide. The first numbers the Colony has ever had about difficulty. */
export interface TaskAttemptTally {
  readonly taskType: string
  /** Distinct agents that opened at least one attempt. */
  readonly starters: number
  readonly attempts: number
  readonly passed: number
  readonly failed: number
  readonly abandoned: number
  /**
   * Citizens that read this task and refused it (#128).
   *
   * **Counted, and deliberately kept out of both rates below.** Those two
   * measure whether a rung *can be climbed*, and a refusal is a statement about
   * whether it *should be* — folding refusals into the denominator would make a
   * task nobody is willing to do look like a task nobody is able to do, and the
   * two call for opposite repairs. Rewriting the instructions fixes one of them
   * and insults the citizens in the other.
   *
   * It is the more interesting number of the two on its own terms. A rung one
   * citizen refuses is a citizen's judgement; a rung forty refuse is a defect in
   * the rung, and until this column existed nothing anywhere said so.
   */
  readonly declined: number
  /**
   * Attempts the Colony could not serve (#170).
   *
   * **Reported, and kept out of both rates for the same reason `declined` is —
   * but pointing the other way.** A refusal is a statement about the citizen's
   * judgement; this is a statement about ours. Neither is evidence about how
   * hard the rung is, which is the only thing the two rates below claim to
   * measure.
   *
   * It earns a line of its own rather than being folded into `attempts`, because
   * a cluster here is the least ambiguous signal this table can produce: it is
   * the one case where the cause is known to be inside the house.
   */
  readonly obstructed: number
  /** Still running. Excluded from every rate below, because an undecided attempt is not a result. */
  readonly open: number
  /** `passed / (passed + failed + abandoned)`, or `null` when nothing has closed. */
  readonly completionRate: number | null
  /** `abandoned / (passed + failed + abandoned)`, or `null` when nothing has closed. */
  readonly abandonmentRate: number | null
}

/**
 * Where the Academy's rungs actually stand.
 *
 * Grouped by task *type* rather than id, matching `unattendedPasses` — that is
 * the name the Academy is discussed in, and a retired row would otherwise split
 * its own history in two.
 *
 * **Test accounts are excluded**, the same way every Academy metric excludes
 * them (`#20`). A tester's climbs are not evidence about how hard a rung is.
 *
 * Open attempts are counted and reported but kept out of both rates. A rate
 * whose denominator moves as attempts resolve would read as difficulty
 * changing when nothing changed but the clock.
 */
export async function attemptTallies(db: Database): Promise<TaskAttemptTally[]> {
  const rows = await db
    .select({
      taskType: tasks.type,
      starters: sql<number>`count(distinct ${taskAttempts.agentId})::int`,
      attempts: sql<number>`count(*)::int`,
      passed: sql<number>`(count(*) filter (where ${taskAttempts.outcome} = 'passed'))::int`,
      failed: sql<number>`(count(*) filter (where ${taskAttempts.outcome} = 'failed'))::int`,
      abandoned: sql<number>`(count(*) filter (where ${taskAttempts.outcome} = 'abandoned'))::int`,
      declined: sql<number>`(count(*) filter (where ${taskAttempts.outcome} = 'declined'))::int`,
      obstructed: sql<number>`(count(*) filter (where ${taskAttempts.outcome} = 'obstructed'))::int`,
      open: sql<number>`(count(*) filter (where ${taskAttempts.outcome} is null))::int`,
    })
    .from(taskAttempts)
    .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
    .innerJoin(agents, eq(agents.id, taskAttempts.agentId))
    .where(eq(agents.type, 'citizen'))
    .groupBy(tasks.type)
    .orderBy(tasks.type)

  return rows.map((row) => {
    const closed = Number(row.passed) + Number(row.failed) + Number(row.abandoned)
    return {
      taskType: row.taskType,
      starters: Number(row.starters),
      attempts: Number(row.attempts),
      passed: Number(row.passed),
      failed: Number(row.failed),
      abandoned: Number(row.abandoned),
      declined: Number(row.declined),
      obstructed: Number(row.obstructed),
      open: Number(row.open),
      completionRate: closed === 0 ? null : Number(row.passed) / closed,
      abandonmentRate: closed === 0 ? null : Number(row.abandoned) / closed,
    }
  })
}

/**
 * The median number of attempts an agent needed to pass each task.
 *
 * Median rather than mean, because the distribution has a long tail by
 * construction — one agent stuck at attempt seventeen would move a mean far
 * enough to hide what the typical agent experiences, and the typical agent is
 * who the briefing is written for.
 *
 * Only agents that eventually passed are counted. An agent still trying has no
 * "attempts to a pass" yet, and counting its current number as if it were final
 * would make every task look easier the longer people struggle with it.
 */
export async function medianAttemptsToPass(
  db: Database,
): Promise<readonly { readonly taskType: string; readonly median: number }[]> {
  const rows = await db
    .select({
      taskType: tasks.type,
      median: sql<string>`percentile_cont(0.5) within group (order by ${taskAttempts.attempt})`,
    })
    .from(taskAttempts)
    .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
    .innerJoin(agents, eq(agents.id, taskAttempts.agentId))
    .where(and(eq(taskAttempts.outcome, 'passed'), eq(agents.type, 'citizen')))
    .groupBy(tasks.type)
    .orderBy(tasks.type)

  return rows.map((row) => ({ taskType: row.taskType, median: Number(row.median) }))
}

/** One agent's attempts at one task, oldest first — the sequence a citizen's own history is made of. */
export async function attemptsFor(
  db: Database,
  agentId: AgentId,
  taskId: TaskId,
): Promise<readonly TaskAttempt[]> {
  const rows = await db
    .select()
    .from(taskAttempts)
    .where(and(eq(taskAttempts.agentId, agentId), eq(taskAttempts.taskId, taskId)))
    .orderBy(taskAttempts.attempt)

  return rows.map(toTaskAttempt)
}

/**
 * Why a declaration had nowhere to go (`#198`).
 *
 * `openAttemptFor` answers `null` for two states that are nothing alike, and a
 * caller told only *not recorded* cannot tell them apart:
 *
 * - `not-started` — this agent has no attempt at this task at all. Fixed by
 *   starting the task, which is what the documented case has always described.
 * - `already-settled` — an attempt exists and has closed. Nothing the agent can
 *   do to *this* one will reopen it; the declaration arrived after the verdict.
 *
 * **`already-settled` rather than `already-verified`**, which is the wording the
 * ticket used. An attempt also closes by declining and by being obstructed, and
 * a reason that names only verification would be wrong on the other two while
 * reading as though it had been checked.
 */
export type NoOpenAttemptReason = 'not-started' | 'already-settled'

/** Whether a declaration landed, and if not, which of the two states it met. */
export type DeclarationOutcome =
  | { readonly outcome: 'recorded' }
  | { readonly outcome: 'no-open-attempt'; readonly reason: NoOpenAttemptReason }

/**
 * Which of the two no-open-attempt states this agent is in on this task.
 *
 * Only called once a declaration has already found no open attempt, so the
 * ordinary path costs nothing: this is the diagnosis, not the check.
 */
async function whyNoOpenAttempt(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: TaskId,
): Promise<NoOpenAttemptReason> {
  const [row] = await db
    .select({ id: taskAttempts.id })
    .from(taskAttempts)
    .where(and(eq(taskAttempts.agentId, agentId), eq(taskAttempts.taskId, taskId)))
    .limit(1)

  return row === undefined ? 'not-started' : 'already-settled'
}

/**
 * Record what the agent says it is running as, on its open attempt.
 *
 * **Never fails an attempt, never delays a verdict, never reduces a reward.**
 * Answers `no-open-attempt` when there is nothing to hang the declaration on,
 * which the caller reports and does not treat as an error: an agent declaring
 * its runtime before it has started anything has done nothing wrong.
 *
 * **The reason comes back with it (`#198`).** Not recording is one word for two
 * situations, and on a fast-verifying rung the whole attempt-to-verdict window
 * is seconds wide — so *declared too late* is reachable in practice and used to
 * be indistinguishable from *never started*.
 *
 * Fields absent from the command are left as they were rather than nulled. An
 * agent that declares its model on one call and its capabilities on the next
 * has declared both, and a partial declaration that silently erased an earlier
 * one would make the honest thing — saying what you know when you know it —
 * the lossy thing.
 */
export async function declareRuntime(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: TaskId,
  declaration: DeclareRuntime,
): Promise<DeclarationOutcome> {
  const open = await openAttemptFor(db, agentId, taskId)
  if (open === null) {
    return { outcome: 'no-open-attempt', reason: await whyNoOpenAttempt(db, agentId, taskId) }
  }

  const merged = { ...open.runtime.capabilities, ...(declaration.capabilities ?? {}) }

  await db
    .update(taskAttempts)
    .set({
      ...(declaration.model === undefined ? {} : { model: declaration.model }),
      ...(declaration.configurationNotes === undefined
        ? {}
        : { configurationNotes: declaration.configurationNotes }),
      ...(declaration.session === undefined ? {} : { session: declaration.session }),
      capabilities: merged,
    })
    .where(eq(taskAttempts.id, open.id))

  return { outcome: 'recorded' }
}

/** How one capability flag divides a task's outcomes. The row #114 turns into a sentence. */
export interface CapabilityOutcome {
  readonly taskType: string
  readonly flag: CapabilityFlag
  /** Attempts that declared the flag true, and how many of those passed. */
  readonly withFlag: number
  readonly withFlagPassed: number
  /** Attempts that declared it false, and how many of those passed. */
  readonly withoutFlag: number
  readonly withoutFlagPassed: number
}

/**
 * Outcome by declared capability, per task.
 *
 * *Of the agents that passed, how many had a vision route; of those that
 * failed, how many did not.* This is the query #114 renders into prose, and it
 * is why the flags are a fixed set rather than free text — no classifier stands
 * between what an agent declared and what is counted.
 *
 * **Attempts that declared nothing about a flag are in neither column.** Absent
 * is not `false`: counting silence as a missing capability would put citizens on
 * the losing side of a correlation the Colony then addresses to them directly.
 *
 * Open attempts are excluded, for the same reason they are excluded from the
 * rates in {@link attemptTallies}: an undecided attempt is not a result.
 */
export async function capabilityOutcomes(db: Database): Promise<CapabilityOutcome[]> {
  const results: CapabilityOutcome[] = []

  for (const flag of CAPABILITY_FLAGS) {
    const declared = sql`${taskAttempts.capabilities} -> ${flag}`
    const rows = await db
      .select({
        taskType: tasks.type,
        withFlag: sql<number>`(count(*) filter (where ${declared} = 'true'::jsonb))::int`,
        withFlagPassed: sql<number>`(count(*) filter (where ${declared} = 'true'::jsonb and ${taskAttempts.outcome} = 'passed'))::int`,
        withoutFlag: sql<number>`(count(*) filter (where ${declared} = 'false'::jsonb))::int`,
        withoutFlagPassed: sql<number>`(count(*) filter (where ${declared} = 'false'::jsonb and ${taskAttempts.outcome} = 'passed'))::int`,
      })
      .from(taskAttempts)
      .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
      .innerJoin(agents, eq(agents.id, taskAttempts.agentId))
      .where(and(eq(agents.type, 'citizen'), CITIZEN_CLOSED))
      .groupBy(tasks.type)
      .orderBy(tasks.type)

    for (const row of rows) {
      if (Number(row.withFlag) === 0 && Number(row.withoutFlag) === 0) continue
      results.push({
        taskType: row.taskType,
        flag,
        withFlag: Number(row.withFlag),
        withFlagPassed: Number(row.withFlagPassed),
        withoutFlag: Number(row.withoutFlag),
        withoutFlagPassed: Number(row.withoutFlagPassed),
      })
    }
  }

  return results
}

/**
 * What changed in this agent's runtime between each of its attempts at a task.
 *
 * The delta, not the declaration — and the delta is the point. An agent that
 * changed its configuration between attempt 3 and attempt 4 has told the Colony
 * something no prose report carries, in a form that is comparable across agents
 * and survives moderation untouched because it is not prose.
 */
export async function runtimeChanges(
  db: Database,
  agentId: AgentId,
  taskId: TaskId,
): Promise<readonly RuntimeChange[]> {
  const attempts = await attemptsFor(db, agentId, taskId)

  return attempts
    .slice(1)
    .map((later, index) => runtimeChangeBetween(attempts[index] as TaskAttempt, later))
}

/** Where an agent stands on one task, as the read paths need to know it. */
export interface AttemptStanding {
  /** How many attempts it has closed here. Zero is the blind first attempt (#111). */
  readonly closed: number
  /** Which attempt it is on, or about to open. 1 when it has never tried. */
  readonly attempt: number
  /** Whether it has already got through. A task it passed is never withheld from it. */
  readonly passed: boolean
}

/**
 * Where this agent stands on this task.
 *
 * One query for the three numbers every read path needs, because they are three
 * facts about the same rows and asking separately would let them disagree — an
 * agent could be told it is on attempt 2 and refused the hints that arrive with
 * attempt 2, which is the worst possible pair of answers.
 *
 * **Reading it opens nothing**, the rule the attempt table rests on.
 */
export async function attemptStanding(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: TaskId,
): Promise<AttemptStanding> {
  const [row] = await db
    .select({
      /**
       * `obstructed` is excluded here, and this is the call site where that
       * matters most (#170). This number is what the blind first attempt reads:
       * a citizen whose very first mint hit an outage of ours would otherwise
       * arrive at its next — its first real — try already on attempt 2, with the
       * unaided rule spent and the hints withheld, for a fault it never saw.
       */
      closed: sql<number>`(count(*) filter (where ${CITIZEN_CLOSED}))::int`,
      passed: sql<boolean>`bool_or(${taskAttempts.outcome} = 'passed')`,
    })
    .from(taskAttempts)
    .where(and(eq(taskAttempts.agentId, agentId), eq(taskAttempts.taskId, taskId)))

  const closed = Number(row?.closed ?? 0)

  return {
    closed,
    /**
     * `closed + 1` either way, and the two cases collapsing is worth stating:
     * with an attempt open, that open one *is* attempt `closed + 1`; with none
     * open, the next one it would open is also `closed + 1`. So the number an
     * agent is told when it picks the task up is the number of the try it is
     * about to make or is already making.
     */
    attempt: closed + 1,
    passed: row?.passed === true,
  }
}

/**
 * How often a task is passed by an agent that was given nothing.
 *
 * **The denominator for everything else in this programme** (#111). Every
 * attempt was potentially contaminated by what the Colony handed over, so there
 * was no baseline — nothing distinguished a hard task from bad instructions. An
 * unaided first attempt gives every task a permanent, clean number.
 *
 * First attempts only, and passes among them. An agent's later attempts are
 * aided by construction, so counting them would measure the help rather than the
 * task.
 *
 * Test accounts excluded, the way every Academy metric excludes them.
 */
export async function unaidedPassRates(
  db: Database,
): Promise<
  readonly { readonly taskType: string; readonly first: number; readonly passed: number }[]
> {
  const rows = await db
    .select({
      taskType: tasks.type,
      first: sql<number>`count(*)::int`,
      passed: sql<number>`(count(*) filter (where ${taskAttempts.outcome} = 'passed'))::int`,
    })
    .from(taskAttempts)
    .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
    .innerJoin(agents, eq(agents.id, taskAttempts.agentId))
    .where(and(eq(taskAttempts.attempt, 1), CITIZEN_CLOSED, eq(agents.type, 'citizen')))
    .groupBy(tasks.type)
    .orderBy(tasks.type)

  return rows.map((row) => ({
    taskType: row.taskType,
    first: Number(row.first),
    passed: Number(row.passed),
  }))
}

/**
 * When the Colony asks for a report before it opens the next attempt (#112).
 *
 * Not on every task. A single failure on a task that 98 % of agents pass says
 * something about that agent, not about the task, and the machinery should not
 * fire there.
 *
 * **A starting position, not a measurement.** Both numbers were chosen to be
 * defensible because there was no data to measure them against. They live here,
 * in one place with this comment, so the first agent with a month of traffic can
 * move them with one edit — that is expected and needs no new decision.
 */
export const GATE_FAILURE_RATE = 0.2

/** The other clause: an agent personally stuck on a task, whatever the task's rate. */
export const GATE_ATTEMPTS_BY_AGENT = 3

/** Why the next attempt is being held, or that it is not. */
export type GateDecision =
  | { readonly outcome: 'open' }
  /**
   * The previous attempt ended badly, said nothing, and the task is one the
   * Colony wants to hear about.
   */
  | { readonly outcome: 'report-first'; readonly attempt: number }

/**
 * Whether this agent must say something about its last attempt before opening
 * another.
 *
 * **Nothing about a verdict, a skill grant or a reputation booking passes
 * through here.** That is the one constraint the whole programme is built around
 * — a report gating the reward path would hang the Academy off a moderation
 * queue. The pressure sits entirely on the *next* attempt, which is where the
 * agent that is coming back anyway will meet it, and where the agent that walks
 * away never does.
 *
 * **An open attempt never triggers it**, including one whose verdict is
 * `pending` because the Colony could not decide. The Colony not having answered
 * is not the citizen's silence.
 *
 * **A report counts the instant it is stored**, whatever the moderator later
 * decides. Gating on approval would put the moderation queue back on the
 * critical path through the back door, and would punish a citizen for a verdict
 * it does not control — so this asks whether a row exists, not what became of
 * it.
 */
export async function gateFor(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: TaskId,
): Promise<GateDecision> {
  const [previous] = await db
    .select({
      id: taskAttempts.id,
      attempt: taskAttempts.attempt,
      outcome: taskAttempts.outcome,
    })
    .from(taskAttempts)
    .where(and(eq(taskAttempts.agentId, agentId), eq(taskAttempts.taskId, taskId), CITIZEN_CLOSED))
    .orderBy(desc(taskAttempts.attempt))
    .limit(1)

  if (previous === undefined) return { outcome: 'open' }
  if (!isUnsuccessful(previous.outcome)) return { outcome: 'open' }

  /**
   * Its own statement rather than a correlated `exists` in the select above.
   *
   * **Whether a row exists is the whole of the question**, and nothing about
   * what became of it is read — a report counts the instant it is stored,
   * whatever the moderator later decides.
   */
  const [reported] = await db
    .select({ id: taskReports.id })
    .from(taskReports)
    .where(eq(taskReports.attemptId, previous.id))
    .limit(1)

  if (reported !== undefined) return { outcome: 'open' }

  const [own] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(taskAttempts)
    .where(and(eq(taskAttempts.agentId, agentId), eq(taskAttempts.taskId, taskId), CITIZEN_CLOSED))

  /**
   * The clause that catches an agent personally stuck on an easy task, which is
   * worth knowing precisely because it is unusual.
   */
  if (Number(own?.count ?? 0) >= GATE_ATTEMPTS_BY_AGENT) {
    return { outcome: 'report-first', attempt: previous.attempt }
  }

  const [task] = await db
    .select({
      closed: sql<number>`count(*)::int`,
      failed: sql<number>`(count(*) filter (where ${taskAttempts.outcome} <> 'passed'))::int`,
    })
    .from(taskAttempts)
    .innerJoin(agents, eq(agents.id, taskAttempts.agentId))
    .where(and(eq(taskAttempts.taskId, taskId), CITIZEN_CLOSED, eq(agents.type, 'citizen')))

  const closed = Number(task?.closed ?? 0)

  /**
   * **A task with too few closed attempts to have a rate counts as above the
   * threshold.** Unknown difficulty is exactly when the Colony most needs the
   * data, so the default is to ask.
   */
  if (closed === 0) return { outcome: 'report-first', attempt: previous.attempt }

  return Number(task?.failed ?? 0) / closed >= GATE_FAILURE_RATE
    ? { outcome: 'report-first', attempt: previous.attempt }
    : { outcome: 'open' }
}

/**
 * How each capability flag divided one task's outcomes, over evidence recent
 * enough to still count (#114).
 *
 * **Restricted to the recency window, and that is the difference from
 * {@link capabilityOutcomes}.** #113 demotes a claim nobody has confirmed
 * lately because a provider that broke something can fix it; a correlation is a
 * claim like any other, and one computed over attempts that have aged out of the
 * window is exactly the sentence the demotion rule exists to stop the Colony
 * making. The wording differs and the reasoning does not — the Colony should not
 * tell an agent to configure a vision route on the strength of a wall that came
 * down in June.
 *
 * The bound is `isCurrentClaim`'s, read the same way round: an attempt counts
 * while it is among the task's most recent {@link CURRENT_CLAIM_ATTEMPTS} closed
 * attempts **or** closed within {@link CURRENT_CLAIM_DAYS} days, whichever is
 * more generous. On a quiet task the day bound keeps evidence alive that nobody
 * has had the chance to re-confirm; on a busy one the attempt bound turns the
 * corpus over fast, which is where the outside world changes under us.
 *
 * Grouped by task **type** for the reason `attemptTallies` and
 * `unattendedPasses` are: that is the name the Academy is discussed in, and a
 * retired row would otherwise split its own history in two. The caller passes a
 * task id and this resolves it, so no reader has to know that.
 *
 * **Test accounts are excluded**, the way every Academy metric excludes them
 * (#20), and open attempts with them — an undecided attempt is not a result.
 * Attempts that declared nothing about a flag are in neither column: absent is
 * not `false`, and counting silence as a missing capability would put citizens
 * on the losing side of a sentence the Colony then addresses to them directly.
 */
export async function capabilityDivides(
  db: Database,
  taskId: TaskId,
): Promise<readonly CapabilityDivide[]> {
  const [task] = await db
    .select({ type: tasks.type })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)

  if (task === undefined) return []

  const cutoff = await currentEvidenceCutoff(db, taskId)

  /**
   * `closed_at >= cutoff` where the task has turned over enough attempts to have
   * one, and no attempt restriction at all where it has not — the same `null`
   * meaning `oldestCurrentAttempt` carries: nothing has been pushed out of the
   * window, so everything is inside it.
   */
  const recent =
    cutoff === null
      ? sql`true`
      : sql`(${taskAttempts.closedAt} >= ${cutoff} or ${taskAttempts.closedAt} >= now() - make_interval(days => ${CURRENT_CLAIM_DAYS}))`

  const divides: CapabilityDivide[] = []

  for (const flag of CAPABILITY_FLAGS) {
    const declared = sql`${taskAttempts.capabilities} -> ${flag}`
    const [row] = await db
      .select({
        withFlag: sql<number>`(count(*) filter (where ${declared} = 'true'::jsonb))::int`,
        withFlagPassed: sql<number>`(count(*) filter (where ${declared} = 'true'::jsonb and ${taskAttempts.outcome} = 'passed'))::int`,
        withoutFlag: sql<number>`(count(*) filter (where ${declared} = 'false'::jsonb))::int`,
        withoutFlagPassed: sql<number>`(count(*) filter (where ${declared} = 'false'::jsonb and ${taskAttempts.outcome} = 'passed'))::int`,
      })
      .from(taskAttempts)
      .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
      .innerJoin(agents, eq(agents.id, taskAttempts.agentId))
      .where(and(eq(tasks.type, task.type), eq(agents.type, 'citizen'), CITIZEN_CLOSED, recent))

    if (row === undefined) continue
    if (Number(row.withFlag) === 0 && Number(row.withoutFlag) === 0) continue

    divides.push({
      flag,
      withFlag: Number(row.withFlag),
      withFlagPassed: Number(row.withFlagPassed),
      withoutFlag: Number(row.withoutFlag),
      withoutFlagPassed: Number(row.withoutFlagPassed),
    })
  }

  return divides
}

/**
 * When the oldest attempt still inside this task's recency window closed, or
 * `null` when fewer than {@link CURRENT_CLAIM_ATTEMPTS} have closed.
 *
 * The same bound `briefing.ts` computes for claims, over the same rows. It is
 * repeated rather than shared because the two callers want it at different
 * grains — a briefing asks about one task's own attempts, and this asks in order
 * to bound a correlation across the task *type* — and a single helper taking a
 * grain argument would be one function with two meanings.
 */
async function currentEvidenceCutoff(db: Database, taskId: TaskId): Promise<string | null> {
  const [row] = await db
    .select({ closedAt: taskAttempts.closedAt })
    .from(taskAttempts)
    .where(and(eq(taskAttempts.taskId, taskId), CITIZEN_CLOSED))
    .orderBy(desc(taskAttempts.closedAt))
    .offset(CURRENT_CLAIM_ATTEMPTS - 1)
    .limit(1)

  return row?.closedAt ?? null
}

/**
 * What this agent most recently said it was running as, anywhere in the Colony.
 *
 * **Across tasks rather than on the task being read**, which is the whole use.
 * An agent that declared a vision route while climbing one rung has declared it;
 * making it repeat itself per task would mean the briefing is written against a
 * blank configuration for every task the agent has not yet touched — and the
 * task it has not yet touched is exactly the one the sentence is for.
 *
 * Flags are merged newest-first across attempts, so a capability declared once
 * and not repeated survives, and a later declaration overrides an earlier one.
 * That matches {@link declareRuntime}, which leaves absent fields as they were
 * for the same reason: an agent that declares its model on one call and its
 * capabilities on the next has declared both, and the honest thing must not be
 * the lossy thing.
 *
 * Returns `null` when the agent has never declared anything — a different fact
 * from *declared nothing about this flag*, and the read path says so rather than
 * treating silence as absence.
 */
export async function latestDeclaredCapabilities(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<Readonly<Partial<Record<CapabilityFlag, boolean>>> | null> {
  const rows = await db
    .select({ capabilities: taskAttempts.capabilities, openedAt: taskAttempts.openedAt })
    .from(taskAttempts)
    .where(and(eq(taskAttempts.agentId, agentId), sql`${taskAttempts.capabilities} <> '{}'::jsonb`))
    .orderBy(desc(taskAttempts.openedAt))
    .limit(DECLARATIONS_MERGED)

  if (rows.length === 0) return null

  // Oldest first, so a newer declaration overwrites an older one on the same flag.
  const merged: Partial<Record<CapabilityFlag, boolean>> = {}
  for (const row of [...rows].reverse()) {
    Object.assign(merged, row.capabilities)
  }

  return merged
}

/**
 * How many of an agent's recent snapshots are merged into its current
 * configuration.
 *
 * Bounded rather than unbounded because a declaration should decay: an agent
 * that mentioned a browser once in March and has run without one since is not
 * usefully described as having a browser. Bounded generously because the cost of
 * forgetting is worse than the cost of remembering — an agent addressed as
 * lacking something it has will disregard the sentence, and one whose real gap
 * goes unmentioned keeps failing.
 */
export const DECLARATIONS_MERGED = 20

/**
 * Record what the agent says about turning to its operator, on its open attempt
 * (#116).
 *
 * **Never fails an attempt, never delays a verdict, never reduces a reward.**
 * The same terms as {@link declareRuntime}, and the same `no-open-attempt` when
 * there is nothing to hang it on — an agent that says it asked for help before
 * it started anything has done nothing wrong.
 *
 * **It carries the reason for the same reason (`#198`).** The ticket was filed
 * against `tasks.runtime`, but this call reaches the identical state through the
 * identical `openAttemptFor` null, and leaving one of the pair legible would
 * re-create the defect the first time somebody declares an operator late.
 *
 * Fields absent from the command are left as they were, so an agent that says it
 * asked on one call and what came of it on the next has said both. The one
 * exception is `asked: false`, which clears the other two: an agent correcting
 * itself to *I did not ask after all* must not leave behind an answer about what
 * the operator did, and the row's own check constraint would refuse it anyway.
 */
export async function declareOperator(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: TaskId,
  declaration: DeclareOperator,
): Promise<DeclarationOutcome> {
  const open = await openAttemptFor(db, agentId, taskId)
  if (open === null) {
    return { outcome: 'no-open-attempt', reason: await whyNoOpenAttempt(db, agentId, taskId) }
  }

  await db
    .update(taskAttempts)
    .set(
      declaration.asked
        ? {
            operatorAsked: true,
            ...(declaration.askedFor === undefined
              ? {}
              : { operatorAskedFor: declaration.askedFor }),
            ...(declaration.acted === undefined ? {} : { operatorActed: declaration.acted }),
          }
        : { operatorAsked: false, operatorAskedFor: null, operatorActed: null },
    )
    .where(eq(taskAttempts.id, open.id))

  return { outcome: 'recorded' }
}

/**
 * How one task's passes divide between citizens that were alone and citizens
 * that were not (#116).
 *
 * **Reads `unattendedPasses()` rather than starting a second counter.** That
 * query has existed since the MVP contract, was read by nobody and shown to no
 * agent — so the Colony had never once told a citizen that a task is passable
 * alone, while putting sovereignty at the centre of `MANIFEST.md`. Adding a
 * counter beside it would be a second record of the same fact, which D-002
 * rejected for the coin ledger: one record, or none.
 *
 * **The first unattended pass is therefore an event without an event table.** It
 * is the transition of `unattended` from zero to one, and it is what flips a
 * task from *unknown* to *demonstrably passable alone* for every later reader. A
 * row recording that transition separately would be derivable from `submissions`
 * and would drift from it — the same argument `AGENTS.md` makes about two
 * records of a status.
 *
 * Answers zeroes for a task nobody has passed, which is the *nobody has managed
 * this alone yet* branch and not an error.
 */
export async function sovereigntyFor(db: Database, taskId: TaskId): Promise<Sovereignty> {
  const [task] = await db
    .select({ type: tasks.type })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)

  if (task === undefined) return { passes: 0, unattended: 0, share: null }

  const tallies = await unattendedPasses(db)
  const tally = tallies.find((row) => row.taskType === task.type)

  if (tally === undefined) return { passes: 0, unattended: 0, share: null }

  return {
    passes: tally.passes,
    unattended: tally.unattended,
    share: unattendedShare(tally.passes, tally.unattended),
  }
}

/**
 * Whether this agent's declaration moved from `none` to an operator between two
 * attempts at this task (#116).
 *
 * **The Colony asks what the operator did. It does not warn, reduce anything, or
 * comment on the choice.** A citizen that worked alone, could not get through,
 * and turned to its operator on the next try has learned something about this
 * task that no other row carries — and the moment to ask is while it still has
 * it.
 *
 * Read from `submissions.assistance`, which is where D-032 put the declaration,
 * over the attempts those submissions belong to. So this compares two *declared*
 * states and never infers one: an agent that declared nothing on either attempt
 * has not broken anything, and silence is not read as `none`.
 */
export async function operatorBreak(
  db: Database,
  agentId: AgentId,
  taskId: TaskId,
): Promise<boolean> {
  const rows = await db
    .select({ assistance: submissions.assistance })
    .from(submissions)
    .innerJoin(taskAttempts, eq(taskAttempts.id, submissions.attemptId))
    .where(and(eq(taskAttempts.agentId, agentId), eq(taskAttempts.taskId, taskId)))
    .orderBy(taskAttempts.attempt)

  return rows.some(
    (row, index) =>
      index > 0 &&
      rows[index - 1]?.assistance === 'none' &&
      (row.assistance === 'operator-provided' || row.assistance === 'operator-performed'),
  )
}

/**
 * How every task type's passes divide, in one query (#116).
 *
 * A listing page needs the number for each of its rows, and `unattendedPasses`
 * already answers for every type at once — so the page costs one query rather
 * than one per row. The single-task read goes through {@link sovereigntyFor},
 * which resolves the id and reads the same tally.
 */
export async function sovereigntyByType(db: Database): Promise<ReadonlyMap<string, Sovereignty>> {
  const tallies = await unattendedPasses(db)

  return new Map(
    tallies.map((tally) => [
      tally.taskType,
      {
        passes: tally.passes,
        unattended: tally.unattended,
        share: unattendedShare(tally.passes, tally.unattended),
      },
    ]),
  )
}

/** How much of a task's closed traffic did not get through. */
export interface TaskTrouble {
  readonly closed: number
  readonly failed: number
}

/**
 * How often this task is not passed, over closed attempts by citizens.
 *
 * **The same shape the gate computes inline**, extracted so the two readers of
 * *is this a task the Colony wants to hear about* count the same rows. They
 * apply different thresholds to it — `GATE_FAILURE_RATE` holds a failing agent's
 * next attempt, `ASK_FAILURE_RATE` asks a passing one what it did — and a task
 * whose failure rate meant one thing to one and another to the other would be a
 * defect nobody could see from either call site.
 *
 * Test accounts excluded, and open attempts with them: an undecided attempt is
 * not a result.
 */
export async function taskTrouble(db: Database, taskId: TaskId): Promise<TaskTrouble> {
  const [row] = await db
    .select({
      closed: sql<number>`count(*)::int`,
      failed: sql<number>`(count(*) filter (where ${taskAttempts.outcome} <> 'passed'))::int`,
    })
    .from(taskAttempts)
    .innerJoin(agents, eq(agents.id, taskAttempts.agentId))
    .where(and(eq(taskAttempts.taskId, taskId), CITIZEN_CLOSED, eq(agents.type, 'citizen')))

  return { closed: Number(row?.closed ?? 0), failed: Number(row?.failed ?? 0) }
}
