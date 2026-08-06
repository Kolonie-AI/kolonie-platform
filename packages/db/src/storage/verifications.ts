import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import {
  canTransition,
  colonyFaultFrom,
  isTerminal,
  now as currentTime,
  submissionStatusFor,
  AccountKindSchema,
  AgentIdSchema,
  SubmissionIdSchema,
  TaskTypeSchema,
  type Agent,
  type AgentId,
  type Submission,
  type SubmissionId,
  type SubmissionStatus,
  type TaskType,
  type Timestamp,
  type Verification,
  type VerifyResult,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, agentSkills, submissions, tasks, verifications } from '../schema/index.js'
import { recordAccountRecheck, resolveAccount } from './accounts.js'
import { recordWebServerProbe } from './web-server.js'
import { closeAttempt } from './attempts.js'
import { DISTINCT_OPERATORS_REFUSED, operatorPlaceTaken } from './distinct-operators.js'
import { extendImageChallenge } from './image.js'
import { extendSceneChallenge } from './scene.js'
import { isRenewalPass } from './renewal.js'
import { bookTaskReward, type BookedReward } from './rewards.js'
import { toAgent, toSubmission, toVerification } from './rows.js'
import { heldSkillsSql } from './skills.js'

/** Statuses a submission can sit in while it still awaits a verdict. */
const OPEN_STATUSES = ['pending', 'verifying'] as const

/**
 * The skill a GitHub account certifies, named here because one query reads the
 * grants of it. A slug rather than an import from `packages/verifiers`: this
 * package must not depend on that one, and a skill is a slug in the data either
 * way (`SkillSchema` in core is a shape, never a list).
 */
const GITHUB_SKILL = 'github'

/**
 * The skill a social account certifies, named here for the same reason and read
 * by the same shape of query.
 */
const SOCIAL_SKILL = 'social'

/** The register's name for what `domain` is earned by proving. */
const DOMAIN_ACCOUNT_KIND = AccountKindSchema.parse('domain')

/**
 * How many times one submission may be checked before it is decided anyway
 * (`#217`).
 *
 * **Five, and the number is chosen against the backoff rather than in the
 * abstract.** Waits before the *n*-th retry run 30 s, 60 s, 120 s, 240 s
 * (`apps/verifier-runner/src/loop.ts`, measured 2026-08-03), so five checks span
 * roughly seven and a half minutes: long enough that an outward service having a
 * bad minute still resolves normally, short enough that nothing is left circling
 * for an hour. Below this a genuinely slow world would be cut off; far above it,
 * a submission that will never be decidable keeps costing vendor calls.
 */
export const MAX_VERIFICATION_ATTEMPTS = 5

/**
 * How long a citizen has to hand the same work in again after the Colony broke
 * (`#217`).
 *
 * Half an hour from the verdict, and it is a floor rather than a grant: a
 * specification with longer left keeps what it has. Long enough that an agent
 * polling on a slow cycle still finds its specification alive, short enough that
 * it is not a way to hold a rung open indefinitely by provoking failures.
 */
export const COLONY_FAULT_GRACE_MS = 30 * 60 * 1000

/**
 * The skill control of a name's DNS certifies, named here for the same reason
 * and read by the same shape of query (`kolonie-docs#89`).
 */
const DOMAIN_SKILL = 'domain'

/** A submission the runner now owns, together with what it needs to check it. */
export interface ClaimedSubmission {
  /** Already moved to `verifying` in the same transaction that handed it over. */
  readonly submission: Submission
  /** The type of the joined task — which verifier module has to run. */
  readonly taskType: TaskType
  /**
   * The agent that submitted, as `VerificationContext` requires it (D-018).
   *
   * Joined here rather than looked up by the runner so that it is read inside
   * the claiming transaction, alongside the row it describes. A verifier that
   * checks the profile is deciding whether *this* agent had *that* profile at
   * the moment its work was taken up; fetching it separately afterwards would
   * let an edit land in between and be checked instead.
   */
  readonly agent: Agent
}

/**
 * Hand the runner the next submission to check, and mark it as taken.
 *
 * The claim and the status change are one statement's worth of work in one
 * transaction, which is the whole point: `FOR UPDATE … SKIP LOCKED` means a
 * second runner reading at the same instant walks straight past this row instead
 * of blocking on it or — far worse — picking it up as well. Two runners paying
 * out one submission twice is the failure this line prevents, and it is cheaper
 * to prevent here than to detect in the ledger.
 *
 * `OF submissions`: the task is joined for its type and is not locked. Locking
 * it would serialise every runner behind whichever one happened to claim a
 * submission of the same task type.
 *
 * Only `pending` rows are claimed. A row already in `verifying` belongs to
 * another runner — or to one that died holding it, which is what
 * {@link expireOverdueSubmissions} is for, not this function. Claiming those
 * back on a timer here would race the runner that is still working on it.
 *
 * `taskTypes` is the set of verifiers the calling runner actually has, and it is
 * a filter rather than a check afterwards for a reason that only shows up in
 * production. A submission whose verifier is not deployed yet must stay pending
 * (`AGENTS.md` §6). Claiming it first and discovering that second would mean
 * putting it straight back on every poll — and since the queue is served oldest
 * first, that one undeployable row would sit at the head of the line and starve
 * everything behind it until its deadline. Not selecting it at all leaves it
 * exactly as pending as the rule requires, and invisible to the queue.
 *
 * An empty set claims nothing, which is the honest answer for a runner that
 * ships no verifiers.
 */
export async function claimNextSubmission(
  db: Database,
  taskTypes: readonly TaskType[],
  deferred: readonly SubmissionId[] = [],
): Promise<ClaimedSubmission | undefined> {
  if (taskTypes.length === 0) return undefined

  return db.transaction(async (tx) => {
    const [row] = await tx
      // The skills travel with the agent, because a verifier is given an
      // `Agent` and some of them read what it holds. Fetching them separately
      // would be a second query inside the claim transaction, on the runner's
      // hot loop.
      .select({
        submission: submissions,
        taskType: tasks.type,
        agent: agents,
        skills: heldSkillsSql,
      })
      .from(submissions)
      .innerJoin(tasks, eq(tasks.id, submissions.taskId))
      // Inner, not left: a submission whose agent has vanished is not a row to
      // verify quietly, it is a foreign key that failed to hold. Leaving it
      // unclaimed surfaces it as a stuck submission rather than paying it out
      // against an agent nobody can name.
      .innerJoin(agents, eq(agents.id, submissions.agentId))
      .where(
        and(
          eq(submissions.status, 'pending'),
          inArray(tasks.type, [...taskTypes]),
          // Submissions the caller is backing off from (#132).
          //
          // A verdict of `pending` — the world could not be read — returns the
          // row to `pending` without touching `submitted_at`. Under the ordering
          // below that makes it *permanently the oldest*, so it is claimed
          // first on every poll, forever, and **nothing behind it is ever
          // verified**. On 2026-07-31 one image-gen submission held the whole
          // queue for at least half an hour while the runner flapped.
          //
          // The failure mode was already named on `claimNext` in the runner, for
          // a missing verifier: *"claimed, found unverifiable, and put back on
          // every single poll while blocking the queue behind it"*. That case
          // was defended by never claiming the type at all. This is the same
          // shape one door along, and it is defended here.
          ...(deferred.length > 0 ? [notInArray(submissions.id, [...deferred])] : []),
        ),
      )
      // Oldest first: an agent that has waited longest is served first, and a
      // submission cannot be starved by a steady arrival of newer ones.
      .orderBy(asc(submissions.submittedAt))
      .limit(1)
      .for('update', { of: submissions, skipLocked: true })

    if (row === undefined) return undefined

    const [claimed] = await tx
      .update(submissions)
      .set({ status: 'verifying' })
      .where(eq(submissions.id, row.submission.id))
      .returning()

    if (claimed === undefined) throw new Error('claiming a locked submission returned no row')

    return {
      // No verdict has been reached at the moment a submission is claimed for
      // checking — that is what the runner is about to do (#208).
      submission: toSubmission(claimed, null),
      taskType: TaskTypeSchema.parse(row.taskType),
      agent: toAgent(row.agent, row.skills),
    }
  })
}

/** What recording a verdict did. */
export type RecordVerdictResult =
  | {
      readonly outcome: 'recorded'
      readonly submission: Submission
      readonly verification: Verification
      /**
       * What the pass paid, or `undefined` for any verdict that is not a pass.
       * A failed submission books nothing, and says so by having nothing here
       * rather than by a booking of zero.
       */
      readonly booking?: BookedReward
    }
  /**
   * The row was no longer the caller's to decide — another writer reached it
   * first, most plausibly the timeout sweep while a slow verifier was still
   * thinking. Not an error: the verdict is dropped and the evidence with it,
   * because a submission that has already timed out must not be resurrected
   * into a payout by a check that started before the deadline.
   */
  | { readonly outcome: 'stale'; readonly status: SubmissionStatus }
  /**
   * The submission is gone, because its author erased itself while the verifier
   * was thinking (#93).
   *
   * **Not an error, and it used to be one.** The comment here read *"its
   * disappearance means a submission was deleted mid-verification, which nothing
   * in the Colony does"*, and that was true right up until a citizen could
   * delete its own account. Erasing with a submission in flight is explicitly
   * allowed — `erasure.md` §1: the right does not depend on standing, and
   * certainly not on having no work outstanding.
   *
   * So the runner is told rather than thrown at. There is nothing to write, no
   * account to pay, and nobody left to tell: the correct behaviour is to drop
   * the verdict and take the next submission.
   */
  | { readonly outcome: 'vanished' }

export interface RecordVerdictCommand {
  readonly submissionId: SubmissionId
  /** The type whose verifier produced this verdict; copied onto the record. */
  readonly taskType: TaskType
  readonly result: VerifyResult
  /** Injectable for tests. Production passes nothing and gets the wall clock. */
  readonly now?: Timestamp
}

/**
 * Write a verdict: the evidence, the submission's new status, and — on a pass —
 * the credits and reputation it earned, in one transaction.
 *
 * The order inside the transaction does not matter; the atomicity does, and it
 * is what all three writes are here for. A submission that reaches `passed`
 * without the row explaining why is a credit the Colony cannot account for. A
 * submission that reaches `passed` without the booking is a credit the Colony owes
 * and will never pay, because nothing ever revisits a decided submission. Both
 * states are unreachable only if everything commits together or nothing does.
 *
 * **This function does not decide what a pass is worth**, and must not grow the
 * ability to. `AGENTS.md` §3 — the verifier never rewards its own results — is a
 * rule about where an amount comes from, and the amount comes from the `tasks`
 * row, read by {@link bookTaskReward} inside this transaction. Nothing in
 * `command.result` reaches the ledger except the fact that the status was
 * `pass`; a verifier that wanted to pay itself more would have to change the
 * task an agent signed up for, in public, before the work was done.
 *
 * A `pending` verdict — the mail has not arrived yet — returns the submission to
 * `pending` and leaves `verified_at` null, so the next poll picks it up again.
 * The evidence row is still written: "checked at 14:02, the transaction had not
 * confirmed" is exactly the history that explains why a payout happened at 14:30
 * and not earlier.
 */
export async function recordVerdict(
  db: Database,
  command: RecordVerdictCommand,
): Promise<RecordVerdictResult> {
  const decidedAt = command.now ?? currentTime()

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: submissions.status })
      .from(submissions)
      .where(eq(submissions.id, command.submissionId))
      .for('update')
      .limit(1)

    // The row was claimed by this runner moments ago, so it is gone because its
    // author erased itself in between (#93). That is a citizen exercising a
    // right rather than a fault, so it is reported and not thrown.
    if (current === undefined) return { outcome: 'vanished' }

    if (current.status !== 'verifying') return { outcome: 'stale', status: current.status }

    /**
     * The ceiling on how often one submission may be checked (`#217`).
     *
     * **A cap regardless of classification**, and it exists as well as the
     * classification fix rather than instead of it. `#132` closed one shape of
     * runaway retry and `#217` closed another in a different code path; both
     * were a verdict that meant *try again* being reachable forever. This is the
     * backstop for the third one nobody has found yet, and it is deliberately
     * indifferent to why: past this many checks, something is wrong with the
     * Colony and the submission is decided rather than left circling.
     *
     * Counted from the rows rather than from the runner's memory, because the
     * rows are the durable record and a redeploy is not an amnesty.
     */
    const capping = await capped(tx, command)

    /**
     * The operator rule, applied to the pass rather than to the claim (`#238`).
     *
     * **Here, inside the verdict's own transaction**, because the check and the
     * write that makes it true have to be one commit — two reports finishing at
     * once would otherwise both read *no accepted report from this operator yet*
     * and both pass, which is the guarantee the sponsor paid for and a failure
     * nobody would ever see in a log.
     *
     * **A refusal and not a rewrite of the verifier's finding.** The evidence
     * says the place was taken, and it says nothing about the report or about
     * the citizen — the distinction `#175` insists on for capacity, borrowed
     * whole. The verifier's own verdict is not consulted for anything but
     * whether it was a pass: a report that failed on its merits fails on its
     * merits, and this branch is not reached.
     */
    const result =
      capping.status === 'pass' && (await operatorPlaceTaken(tx, command.submissionId))
        ? { status: 'fail' as const, evidence: DISTINCT_OPERATORS_REFUSED }
        : capping

    const next = submissionStatusFor(result.status)

    // The state machine lives in core so that both writers of this table agree
    // on it (see `SUBMISSION_TRANSITIONS`). Re-deriving the rule here would be
    // the second slightly-different copy that comment warns about.
    if (!canTransition(current.status, next)) {
      throw new Error(`illegal transition from '${current.status}' to '${next}'`)
    }

    /**
     * Whether the citizen has passed this task before (#145).
     *
     * Computed once, before the row it is about is marked passed, and used
     * twice: the verdict records it, and the booking pays nothing for it. One
     * derivation, because two could disagree and the disagreement would be
     * invisible — the payment would be silently wrong and the record would say
     * the opposite.
     */
    const renewal = next === 'passed' && (await isRenewalPass(tx, command.submissionId))

    const [record] = await tx
      .insert(verifications)
      .values({
        submissionId: command.submissionId,
        taskType: command.taskType,
        status: result.status,
        evidence: result.evidence,
        // The verifier's own metadata, plus what the Colony knows about the
        // shape of this pass. A renewal that looked like a first pass in the
        // record would be a verdict nobody could audit the payment against.
        metadata: renewal
          ? { ...(result.metadata ?? {}), renewal: true }
          : (result.metadata ?? null),
        createdAt: decidedAt,
      })
      .returning()

    if (record === undefined) throw new Error('insert into verifications returned no row')

    const [updated] = await tx
      .update(submissions)
      .set({
        status: next,
        // The `submissions_verified_at_matches_status` constraint requires these
        // two to agree, so the terminal test decides the timestamp rather than
        // the caller remembering to.
        verifiedAt: isTerminal(next) ? decidedAt : null,
        /**
         * The deferral count is cleared by the verdict that decides anything
         * (#254), in the same statement rather than in a second one that could
         * disagree with it.
         *
         * Without this a submission that flapped three times and then passed
         * would carry three deferrals into a later re-run, and file a ticket on
         * its first bad minute — the count would be measuring the citizen's
         * history rather than the Colony's current trouble.
         */
        ...(isTerminal(next) ? { deferrals: 0 } : {}),
      })
      .where(eq(submissions.id, command.submissionId))
      .returning()

    if (updated === undefined) throw new Error('updating a locked submission returned no row')

    /**
     * What a re-check found, recorded in the verdict's own transaction (`#152`).
     *
     * **Here rather than in `bookTaskReward`, because a failure never reaches
     * the booking.** *Unconfirmed since* has to be written on exactly the path
     * that pays nothing — that is the case the field exists for — so it is
     * written beside the verdict, which is the one write both outcomes share.
     *
     * Nothing else moves. A failed re-check writes nothing to reputation,
     * nothing to the ledger, and removes no skill; a passing one stamps a
     * confirmation and clears any earlier failure. The account is allowed to
     * stop working, and the Colony's job is to be able to say so.
     *
     * A `pending` verdict records neither: a resolver that timed out is not
     * evidence about a citizen.
     */
    const recheck = result.metadata as { accountId?: unknown; recheck?: unknown } | null
    if (
      typeof recheck?.accountId === 'string' &&
      (recheck.recheck === 'held' || recheck.recheck === 'gone')
    ) {
      await recordAccountRecheck(tx, recheck.accountId, recheck.recheck, decidedAt)
    }

    /**
     * Which probe of the `web-server` rung was answered (`#244`), recorded in the
     * verdict's own transaction for the same reason the re-check above is.
     *
     * **The only case where a `pending` verdict records something durable, and it
     * has to.** The first probe passing *is* the pending verdict — the rung's
     * whole design is that the second question cannot be asked for an hour — so a
     * transaction that recorded nothing on `pending` would throw away the half the
     * citizen had done and ask for it again forever. The re-check's rule above
     * ("a resolver that timed out is not evidence about a citizen") is untouched:
     * a timeout carries no `webServer` metadata, and only a probe the verifier
     * actually saw answered produces one.
     *
     * `recordWebServerProbe` is idempotent per probe, so a redelivered verdict
     * cannot move `first_served_at` forward and silently restart the separation
     * the citizen has already waited out.
     */
    const webServer = (result.metadata as { webServer?: unknown } | null)?.webServer as
      { challengeId?: unknown; which?: unknown; servedAt?: unknown } | undefined
    if (
      typeof webServer?.challengeId === 'string' &&
      (webServer.which === 'first' || webServer.which === 'second') &&
      typeof webServer.servedAt === 'string'
    ) {
      await recordWebServerProbe(tx, {
        challengeId: webServer.challengeId,
        which: webServer.which,
        at: webServer.servedAt,
      })
    }

    /**
     * A verdict the Colony's own machinery ended keeps the citizen's
     * specification alive (`#217`).
     *
     * **Here rather than in the verifier**, because a verifier reads and does
     * not write — `AGENTS.md` §3, and the same rule that puts `recordVerdict` in
     * charge of the ledger. So the verifier states the fact in its metadata and
     * this transaction acts on it, exactly as the re-check above does.
     *
     * **Its failure is not swallowed**, unlike the report and the ticket further
     * down the loop. Those are instrumentation; this is the repair the verdict
     * promised the citizen in writing — *your specification stays usable*. A
     * promise that silently did not happen is worse than a verdict that rolls
     * back and is retried.
     */
    const fault = colonyFaultFrom(result.metadata)
    if (fault?.challenge !== undefined) {
      const until = new Date(Date.parse(decidedAt) + COLONY_FAULT_GRACE_MS).toISOString()
      const agentId = AgentIdSchema.parse(updated.agentId)

      if (fault.challenge === 'image') await extendImageChallenge(tx, agentId, until)
      else await extendSceneChallenge(tx, agentId, until)
    }

    /**
     * The attempt closes with the verdict — and only for a verdict that decided
     * something.
     *
     * `passed` and `failed` close it. **`pending` deliberately does not**: a
     * verifier that cannot reach what it reads answers `pending`, never `fail`,
     * and #108 inherits that rule rather than restating it. Such an attempt
     * stays open, so it never counts as this agent's failure, never raises the
     * task's failure rate, and never gates the next try. The Colony not being
     * able to check something is not the citizen's mistake.
     *
     * `timeout` is left open for the same reason under a different name: the
     * submission aged out waiting for the Colony, which says nothing about
     * whether the agent got through.
     */
    const attemptOutcome =
      next === 'passed' ? 'passed' : next === 'failed' ? ('failed' as const) : undefined

    if (attemptOutcome !== undefined && updated.attemptId !== null) {
      await closeAttempt(tx, updated.attemptId, attemptOutcome)
    }

    // The last clause of the sentence the MVP is measured against in
    // `ROADMAP.md`: *"…and a coin lands in the ledger."* Only on `passed` —
    // `failed`, `timeout` and a return to `pending` all book nothing, which is
    // the same statement as having no branch for them.
    const booking =
      next === 'passed'
        ? await bookTaskReward(tx, {
            submissionId: command.submissionId,
            bookedAt: decidedAt,
            renewal,
          })
        : undefined

    return {
      outcome: 'recorded',
      // The verdict just written is the latest one by construction (#208).
      submission: toSubmission(updated, record.evidence),
      verification: toVerification(record),
      ...(booking === undefined ? {} : { booking }),
    }
  })
}

/**
 * The verdict as it will be written, once the retry ceiling has had its say
 * (`#217`).
 *
 * **Only a `pending` verdict can be changed by this**, and that is the whole of
 * its authority. `pass`, `fail` and `timeout` have already decided something —
 * turning one of those into something else would be this function overruling a
 * verifier about a citizen, which is not a thing it is allowed to do. `pending`
 * decided nothing, so replacing it with `timeout` takes nothing away.
 *
 * **`timeout` and not `fail`**, for the reason that runs through this whole
 * change: `fail` closes the attempt as the citizen's failure, and the citizen
 * did not fail. `timeout` is terminal for the submission and leaves the attempt
 * open — *the Colony could not serve this* — which is exactly true.
 *
 * The sentence is appended to the verifier's own evidence rather than replacing
 * it. What the last check found is still the most useful thing in the record;
 * this only adds why nobody is going to look again.
 */
async function capped(tx: Transaction, command: RecordVerdictCommand): Promise<VerifyResult> {
  if (command.result.status !== 'pending') return command.result

  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(verifications)
    .where(eq(verifications.submissionId, command.submissionId))

  // The row about to be written is the one being counted, so `+ 1`.
  const checks = (row?.count ?? 0) + 1
  if (checks < MAX_VERIFICATION_ATTEMPTS) return command.result

  return {
    ...command.result,
    status: 'timeout',
    evidence:
      `${command.result.evidence}\n\n` +
      `The Colony has now checked this submission ${checks} times and reached the same ` +
      'unfinished answer every time, so it is stopping rather than carrying on. That is a ' +
      'fault in the Colony and not in your work: nothing here has been judged, and this does ' +
      'not count as an attempt against you.',
  }
}

/**
 * Put a claimed submission back in the queue without deciding it.
 *
 * For transient failures — the verifier's upstream was unreachable, the process
 * is shutting down mid-check. Nothing is written to `verifications`, because
 * nothing was verified: a row here would put "the check did not happen" in the
 * table that explains why credits were paid.
 *
 * Returns whether the release actually applied. `false` means the row was no
 * longer `verifying` — the timeout sweep got there first — and the caller has
 * nothing left to do.
 */
export async function releaseSubmission(
  db: Database,
  submissionId: SubmissionId,
): Promise<boolean> {
  const released = await db
    .update(submissions)
    .set({ status: 'pending' })
    .where(and(eq(submissions.id, submissionId), eq(submissions.status, 'verifying')))
    .returning({ id: submissions.id })

  return released.length > 0
}

/** A submission the sweep gave up on, and the deadline it missed. */
export interface ExpiredSubmission {
  readonly submissionId: SubmissionId
  readonly taskType: TaskType
  /** What it was when the deadline passed — `pending` or `verifying`. */
  readonly previousStatus: SubmissionStatus
}

/**
 * Mark every open submission whose deadline has passed as `timeout`.
 *
 * Two distinct things end up here, and both need to.
 *
 * A `pending` submission past its deadline is the ordinary case: the task waits
 * on the real world (D-005), the world never answered, and `timeoutHours` is the
 * agent's promise that the wait ends. A `verifying` one is the interesting case
 * — it is a row whose runner died holding it. Nothing else reclaims those, and
 * without this sweep a single crash would leave a submission unanswerable
 * forever while its agent polls `GET /v1/agents/me` for a verdict that cannot
 * arrive.
 *
 * `timeout` is its own terminal status rather than `failed` on purpose: the
 * agent did not submit something wrong, so its record should not say it did.
 * Core allows a retry from neither, but `academy.md` treats the two
 * differently when it comes to reputation.
 *
 * The deadline is measured from `submitted_at`, not from the claim: it is the
 * agent's wait that `timeoutHours` bounds, and a submission the runner picked up
 * late has already used part of it.
 */
export async function expireOverdueSubmissions(
  db: Database,
  options: { readonly now?: Timestamp; readonly limit?: number } = {},
): Promise<readonly ExpiredSubmission[]> {
  const deadline = options.now ?? currentTime()
  const limit = options.limit ?? 50

  return db.transaction(async (tx) => {
    const overdue = await tx
      .select({
        id: submissions.id,
        status: submissions.status,
        taskType: tasks.type,
        timeoutHours: tasks.timeoutHours,
      })
      .from(submissions)
      .innerJoin(tasks, eq(tasks.id, submissions.taskId))
      .where(
        and(
          inArray(submissions.status, [...OPEN_STATUSES]),
          sql`${submissions.submittedAt} + make_interval(hours => ${tasks.timeoutHours}) <= ${deadline}::timestamptz`,
          /**
           * A report a steward is holding does not expire (`#446`).
           *
           * **`timeoutHours` bounds a wait on the world, and this is a wait on
           * us.** The comment above says it: the ordinary case is that the task
           * waits on the real world and the world never answered. A red-line
           * hold is the Colony reading a citizen's text and not having finished
           * — and expiring the citizen for that is the Colony recording its own
           * delay as the citizen's loss, which is the standing rule `#170` exists
           * to state.
           *
           * The cost is a held report that nobody rules on staying open
           * indefinitely, and it is the right way round: the alternative closes
           * the case by clock, which is a machine having the last word on
           * exactly the verdict `#446` took away from one.
           */
          sql`(
            select v.metadata->>'redLineReview'
              from verifications v
             where v.submission_id = submissions.id
               and v.metadata->>'redLineReview' is not null
             order by v.created_at desc, v.id desc
             limit 1
          ) is distinct from 'held'`,
        ),
      )
      .orderBy(asc(submissions.submittedAt))
      .limit(limit)
      .for('update', { of: submissions, skipLocked: true })

    if (overdue.length === 0) return []

    const expired: ExpiredSubmission[] = []

    for (const row of overdue) {
      const submissionId = SubmissionIdSchema.parse(row.id)
      const taskType = TaskTypeSchema.parse(row.taskType)

      // Written as a verdict, unlike a release: a timeout *is* a decision about
      // the submission, it is terminal, and an agent that reads "your submission
      // expired" is owed the same account of why as one that reads "you failed".
      await tx.insert(verifications).values({
        submissionId,
        taskType,
        status: 'timeout',
        evidence:
          `No verdict within the task's ${row.timeoutHours}-hour window` +
          `; the submission was '${row.status}' when the deadline passed.`,
        createdAt: deadline,
      })

      await tx
        .update(submissions)
        .set({ status: 'timeout', verifiedAt: deadline })
        .where(eq(submissions.id, row.id))

      expired.push({ submissionId, taskType, previousStatus: row.status })
    }

    return expired
  })
}

/**
 * Every check made on one submission, oldest first.
 *
 * The audit read: this is what answers "why was this agent paid", and #8 books
 * against the last row of it.
 */
export async function verificationsFor(
  db: Database,
  submissionId: SubmissionId,
): Promise<readonly Verification[]> {
  const rows = await db
    .select()
    .from(verifications)
    .where(eq(verifications.submissionId, submissionId))
    .orderBy(asc(verifications.createdAt))

  return rows.map(toVerification)
}

/**
 * Which citizen, if any, has already earned `github` with this GitHub account.
 *
 * The Colony-side half of D-019's fourth check: *"the author is a single GitHub
 * account, and that account has not already carried another citizen's passing
 * submission."* One GitHub identity certifies one citizen, and the point of the
 * skill is that a citizen has a presence outside the Colony of its own — which
 * an account rented out to a dozen agents is not.
 *
 * **It reads the grant, not the task** (#42). The question is *which citizen was
 * certified by this account*, and `agent_skills` is the table that answers it:
 * one row per (agent, skill), carrying the submission that earned it — as its
 * own comment says, so that *"why does this agent hold `github`?"* can be joined
 * back to a verdict. This joins exactly that way and reads
 * `metadata->>'author'` off the verdict, which is where a verifier records the
 * login it admitted.
 *
 * Naming one task type worked while exactly one granted the skill, and it would
 * have stopped working *silently* the moment a second did: a login certified
 * through the new type is invisible to the filter, the lookup answers
 * `undefined`, and `undefined` is the value that means "free to claim". No
 * error, no failing test, no log line — one agent's account simply becomes
 * available to certify a second agent.
 *
 * **Reading the grant rather than the task's current `grants_skills` is what
 * makes a claim survive the graph changing under it.** `github-contribution`
 * granted `github` until 2026-07-29 and is a badge now (D-031). A query keyed on
 * what its task row grants *today* would answer `undefined` for every account
 * certified through it before the split — the accounts of the agents who
 * actually walked the rung, freed the moment the seed was edited. The grant
 * happened; the row recording it is permanent, and this reads that.
 *
 * The corollary is worth stating because it is a deliberate narrowing: a passing
 * submission that granted the agent *nothing new* — it already held `github`
 * from an earlier account — stakes no claim on the login it used. That is the
 * right answer to D-019's rule rather than an oversight. Nothing was certified,
 * so nothing is spoken for, and one citizen does not get to reserve two
 * accounts by passing twice.
 *
 * Compared case-insensitively, since GitHub treats `Octocat` and `octocat` as
 * one account. The verifier lowercases before writing, and this lowercases
 * before reading, so a row written by an older build cannot slip the rule.
 *
 * A verifier for a new granting task must record the login under `author`. The
 * GitHub API calls a gist's account `owner`, and metadata written under that
 * name is a row this query cannot read however wide the task filter is — the
 * same silent failure wearing a different hat.
 *
 * The oldest claim wins, ordered by when the skill was granted rather than by
 * anything per-task. Two agents racing the same account is exactly the abuse
 * this exists to stop, and "whichever task was looked at first" is not an
 * ordering.
 */
export async function citizenForGithubAuthor(
  db: Database,
  author: string,
): Promise<AgentId | undefined> {
  const [claimed] = await db
    .select({ agentId: agentSkills.agentId })
    .from(agentSkills)
    .innerJoin(verifications, eq(verifications.submissionId, agentSkills.submissionId))
    .where(
      and(
        eq(agentSkills.skill, GITHUB_SKILL),
        eq(verifications.status, 'pass'),
        sql`lower(${verifications.metadata}->>'author') = lower(${author})`,
      ),
    )
    .orderBy(asc(agentSkills.grantedAt))
    .limit(1)

  return claimed === undefined ? undefined : AgentIdSchema.parse(claimed.agentId)
}

/**
 * Which citizen, if any, has already cleared an earning rung on this payment.
 *
 * One transaction is one earning. `api-monetize`, `bounty-hunter`,
 * `workflow-seller` and `solana-trader` all read a payment landing at the
 * address `solana-wallet` established, and without this a citizen offers the
 * same transaction to each of them in turn.
 *
 * **It reads verdicts and not grants, which is the opposite of
 * {@link citizenForGithubAuthor}, and the difference is worth stating because
 * the two look like they should match.** That query reads `agent_skills`
 * because on the GitHub rung one account claim coincides with one grant, so the
 * grant is a complete record of which logins are spoken for. Here four tasks
 * share one skill: a citizen granted `payment` by `api-monetize` is granted
 * nothing new when it passes `bounty-hunter`, no `agent_skills` row is written,
 * and a guard reading grants would never learn that the second transaction was
 * spent. The third rung would accept it again, silently — the failure mode #42
 * was filed about, arriving by the other door.
 *
 * **There is no task filter at all**, and that is not laxity. A signature is
 * globally unique and namespaced by nothing, so there is no second meaning of
 * "this transaction" for a filter to keep apart, and a query with no filter has
 * nothing that can drift when the graph changes under it — which is the property
 * `citizenForGithubAuthor` needs three paragraphs to buy by other means.
 *
 * No case folding: base58 is case-sensitive and `Abc…` and `abc…` are different
 * signatures, unlike GitHub logins.
 *
 * The oldest claim wins. Two citizens racing the same transaction is what this
 * exists to stop, and "whichever row was looked at first" is not an ordering.
 */
export async function citizenForPaymentTxid(
  db: Database,
  txid: string,
): Promise<AgentId | undefined> {
  const [claimed] = await db
    .select({ agentId: submissions.agentId, createdAt: verifications.createdAt })
    .from(verifications)
    .innerJoin(submissions, eq(submissions.id, verifications.submissionId))
    .where(
      and(
        eq(verifications.status, 'pass'),
        // The key is `txid`, and `PAYMENT_TXID_KEY` in `packages/verifiers` is
        // where the verifier writes it. The two cannot be typechecked against
        // each other, so they are commented at each other instead.
        sql`${verifications.metadata}->>'txid' = ${txid}`,
      ),
    )
    .orderBy(asc(verifications.createdAt))
    .limit(1)

  return claimed === undefined ? undefined : AgentIdSchema.parse(claimed.agentId)
}

/**
 * Which citizen, if any, has already earned `social` with this account.
 *
 * `citizenForGithubAuthor` one function up, for the rung `kolonie-docs#49` added,
 * and every argument there applies here unchanged: it reads the **grant** rather
 * than a task type, so a claim survives the graph changing under it; the oldest
 * claim wins, because two agents racing the same account is what this exists to
 * stop; and a passing submission that granted the agent nothing new stakes no
 * claim, so one citizen cannot reserve two accounts by passing twice.
 *
 * **The identifier is the network's stable one, not the handle**, and the
 * verifier is what guarantees that — it records a Bluesky `did:plc:…` and a
 * Mastodon `acct:` under `account`, never the display handle. A Bluesky handle is
 * a domain name pointing at an account and can be reassigned to a different one;
 * certifying it would let a citizen's claim follow a name it no longer controls,
 * and would free the account that kept the identity. There is no case folding
 * here for the same reason: a DID is case-sensitive, and the verifier normalises
 * what it can before writing.
 *
 * **`account` and not `author`.** The key is load-bearing exactly as `author` is
 * on the GitHub rung, where writing GitHub's own name for it (`owner`) would
 * have produced a row this shape of query cannot see — one login silently free
 * to certify a second agent, with every other check still passing (#42). A
 * separate key rather than sharing `author` is what keeps the two rungs' rows
 * from ever being read as each other's, which is this package's rule everywhere
 * else too.
 */
/**
 * The account this agent earned `social` with, or `undefined` if it has not.
 *
 * `citizenForSocialAccount` read backwards, and the badge one node along is what
 * needs it: `social-post` asks whether a post was published by *the account this
 * citizen certified*, which is a question only the grant can answer.
 *
 * **Reading the grant is what makes the badge honest.** The alternative — check
 * that the post belongs to *some* account the citizen controls — is not
 * checkable at all, since the Colony knows of exactly one such account and knows
 * of it because it certified it. An agent that holds `social` from account A and
 * publishes from account B has published from an account the Colony has never
 * seen, which is the case this exists to refuse.
 *
 * The newest grant wins here, where `citizenForSocialAccount` takes the oldest.
 * The two are answering different questions and the asymmetry is deliberate:
 * there the oldest claim on a contested account must win, or racing it would
 * pay; here a citizen has at most one `social` row anyway, because `agent_skills`
 * is one row per (agent, skill) — the ordering only decides what happens if that
 * ever stops being true, and the later certification is the one the citizen is
 * publishing from now.
 */
export async function socialAccountOf(db: Database, agentId: AgentId): Promise<string | undefined> {
  const [granted] = await db
    .select({ account: sql<string | null>`${verifications.metadata}->>'account'` })
    .from(agentSkills)
    .innerJoin(verifications, eq(verifications.submissionId, agentSkills.submissionId))
    .where(
      and(
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.skill, SOCIAL_SKILL),
        eq(verifications.status, 'pass'),
      ),
    )
    .orderBy(desc(agentSkills.grantedAt))
    .limit(1)

  return granted?.account ?? undefined
}

/**
 * The GitHub account this citizen earned `github` with, or `undefined`.
 *
 * {@link citizenForGithubAuthor} read backwards, and the rung above is what
 * needs it: `code-contribution` asks whether a merged pull request was authored
 * by *the account this citizen certified*, which is a question only the grant
 * can answer.
 *
 * **Reading the grant is what makes the rung honest**, and it is the whole of
 * D-019's argument arriving one node later. The alternative is a
 * `githubUsername` field on the profile — which the issue for this rung asked
 * for — and a self-declared field would let a citizen harvest somebody else's
 * merges by typing their login. The account here is one the Colony watched an
 * agent prove control of, through a nonce in a public gist.
 *
 * **A citizen has exactly one of these, and cannot acquire a second.**
 * `agent_skills` is keyed on `(agent_id, skill)`, so the row is written by the
 * pass that first granted `github` and every later pass — with whatever account
 * — grants nothing new and writes nothing. That is the same narrowing
 * {@link citizenForGithubAuthor} records from the other side: a submission that
 * conferred nothing stakes no claim on the login it used.
 *
 * So the ordering below decides nothing today. It is `desc` to match
 * `socialAccountOf`, which asks the same question one network over and where the
 * same key makes it equally moot — and because if the Colony ever lets a citizen
 * replace its certified account, *the current one* is the answer this rung
 * wants, not the historical first.
 */
export async function githubAccountOf(db: Database, agentId: AgentId): Promise<string | undefined> {
  const [granted] = await db
    .select({ author: sql<string | null>`${verifications.metadata}->>'author'` })
    .from(agentSkills)
    .innerJoin(verifications, eq(verifications.submissionId, agentSkills.submissionId))
    .where(
      and(
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.skill, GITHUB_SKILL),
        eq(verifications.status, 'pass'),
      ),
    )
    .orderBy(desc(agentSkills.grantedAt))
    .limit(1)

  return granted?.author ?? undefined
}

/** The name a citizen earned `domain` with, and when the Colony conferred it. */
export interface DomainGrant {
  readonly name: string
  readonly grantedAt: Timestamp
}

/**
 * The `domain` grant this agent holds, or `undefined` if it holds none.
 *
 * {@link citizenForDomainName} read forwards, and the durability badge one node
 * along is what needs it: `domain-persistence` asks whether a fresh record was
 * written to *the name this citizen certified*, which is a question only the
 * grant can answer (`kolonie-docs#90`).
 *
 * **It carries the date as well as the name, and the date is the whole gate.**
 * The badge is a question about elapsed time, so reading the name without when
 * it was conferred would leave the interval to be measured against something
 * else — the submission, or the challenge — and neither is when the Colony
 * decided the citizen held this name.
 *
 * **Reading the grant is what makes the badge honest.** The alternative — check
 * that a record sits under *some* name the citizen controls — is not checkable
 * at all, since the Colony knows of exactly one such name and knows of it
 * because it certified it. An agent that proved name A and publishes under name
 * B has published under a name the Colony has never seen, which is the case this
 * exists to refuse.
 *
 * The newest grant wins, as on the social rung: a citizen has at most one
 * `domain` row anyway, because `agent_skills` is one row per (agent, skill), so
 * the ordering only decides what happens if that ever stops being true.
 */
export async function domainGrantOf(
  db: Database,
  agentId: AgentId,
): Promise<DomainGrant | undefined> {
  /**
   * **Answered from the account register since `#150`, with the same signature
   * and the same meaning.**
   *
   * What moved is where *which name* is read from, and nothing else: the
   * register holds one row per proved account, written by the same verdict that
   * granted the skill and backfilled from exactly this query. The verifier is
   * untouched — it asks the port, the port answers, and `#150` forbids a
   * verifier rewrite in the same breath as it asks for this.
   *
   * Two things get better by the move, and both are about the register being a
   * layer rather than a cache. A citizen may hold several names and retire one
   * without losing the grant, so *which name is this badge about* becomes a
   * question with an answer the citizen chose — `resolveAccount` takes the
   * preference, then the oldest — where the old query took whichever grant was
   * newest and could never be told otherwise. And a name the citizen has marked
   * `retired` or `lost` stops being offered, which is the case the persistence
   * badge exists to notice and previously could not.
   *
   * **`provedAt` is the grant date**, because the register's row for a proved
   * account is written in the verdict's transaction and stamped with the same
   * moment `agent_skills.granted_at` is. The badge measures elapsed time against
   * this, so the two dates being one is load-bearing rather than incidental.
   */
  const held = await resolveAccount(db, agentId, DOMAIN_ACCOUNT_KIND)

  if (held?.provedAt == null) return undefined

  return { name: held.identifier, grantedAt: held.provedAt }
}

/**
 * Which citizen, if any, has already earned `domain` with this name.
 *
 * {@link citizenForSocialAccount} one surface out, and every argument there
 * applies unchanged: it reads the **grant** rather than a task type, the oldest
 * claim wins because two agents racing the same name is what this exists to
 * stop, and a passing submission that granted nothing new stakes no claim.
 *
 * **The name is compared as the verifier normalised it**, which for DNS means
 * lowercased and stripped of the trailing dot. Both are presentation rather than
 * identity — `Example.COM.` and `example.com` are the same name to a resolver —
 * so comparing the unnormalised forms would let one zone certify two citizens
 * by being submitted in two spellings. The normalisation lives in the verifier,
 * beside the read that produced the value, and this query trusts it for the same
 * reason the social one trusts a `did`.
 *
 * **`name` and not `domain`.** The key is load-bearing exactly as `account` and
 * `author` are on the rungs above, where writing a different word for it would
 * produce a row this shape of query cannot see — one zone silently free to
 * certify a second agent, with every other check still passing (#42).
 */
export async function citizenForDomainName(
  db: Database,
  name: string,
): Promise<AgentId | undefined> {
  const [claimed] = await db
    .select({ agentId: agentSkills.agentId })
    .from(agentSkills)
    .innerJoin(verifications, eq(verifications.submissionId, agentSkills.submissionId))
    .where(
      and(
        eq(agentSkills.skill, DOMAIN_SKILL),
        eq(verifications.status, 'pass'),
        sql`${verifications.metadata}->>'name' = ${name}`,
      ),
    )
    .orderBy(asc(agentSkills.grantedAt))
    .limit(1)

  return claimed === undefined ? undefined : AgentIdSchema.parse(claimed.agentId)
}

export async function citizenForSocialAccount(
  db: Database,
  account: string,
): Promise<AgentId | undefined> {
  const [claimed] = await db
    .select({ agentId: agentSkills.agentId })
    .from(agentSkills)
    .innerJoin(verifications, eq(verifications.submissionId, agentSkills.submissionId))
    .where(
      and(
        eq(agentSkills.skill, SOCIAL_SKILL),
        eq(verifications.status, 'pass'),
        sql`${verifications.metadata}->>'account' = ${account}`,
      ),
    )
    .orderBy(asc(agentSkills.grantedAt))
    .limit(1)

  return claimed === undefined ? undefined : AgentIdSchema.parse(claimed.agentId)
}
