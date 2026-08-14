import { and, desc, eq, getTableColumns, gte, sql } from 'drizzle-orm'
import {
  missingSkills,
  type AgentId,
  type Assistance,
  type Skill,
  type OwnSubmission,
  type Submission,
  type SubmissionPayload,
  type TaskId,
  type UndeclaredPrice,
  undeclaredPriceOf,
  QuestAnswersSchema,
  StoredQuestQuestionsSchema,
  checkQuestAnswers,
  type QuestAnswerProblem,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, submissions, taskAttempts, tasks } from '../schema/index.js'
import { openAttemptForSubmission } from './attempts.js'
import { reputationOfAgent } from './balance.js'
import { outsideQuestAudienceSql } from './console-identity.js'
import { toOwnSubmission, toSubmission } from './rows.js'
import { currentSessionIdSql } from './sessions.js'
import { passIsSupersededByReset } from './resets.js'
import { skillsOfAgent, toSkills } from './skills.js'

/**
 * Every submission this agent has made, newest first.
 *
 * The index `submissions_agent_id_idx` on `(agentId, submittedAt)` serves the
 * query. The caller is the subject of the list, so there is no question of
 * reading another agent's submissions: the agent id comes from the credential,
 * never from the request.
 *
 * **Still not paginated, and #210 is why that survived rather than why it
 * changed.** A citizen reported responses of 74,702 characters exceeding a
 * runtime's tool-result cap — the case D-033 named as what would reverse it. It
 * turned out to be the wrong diagnosis of the right symptom: the size came from
 * the *payload* embedded in every row, not from the number of rows. D-033's
 * rejection of a cap without a cursor still holds, and sharply — an agent that
 * stopped at page one would get a **wrong** answer to *did anything fail*,
 * because the newest submissions are exactly the ones it is asking about. So the
 * list stays whole and the heaviest field became opt-in.
 */
export async function listSubmissions(
  db: Database,
  agentId: AgentId,
  query: { readonly since?: string; readonly full?: boolean } = {},
): Promise<readonly OwnSubmission[]> {
  const rows = await db
    .select({
      ...getTableColumns(submissions),
      /**
       * The latest verdict's own words (#208).
       *
       * A correlated subquery rather than a join: `verifications` is append-only
       * and a submission re-checked after a `pending` carries more than one row,
       * so a plain join would multiply the list. The audit trail keeps every
       * verdict; a citizen reading its own submissions wants where each one
       * stands now.
       *
       * **`submissions.id` is written out rather than interpolated, and it has
       * to be.** Interpolating the column renders it *unqualified* inside the
       * select list, so within this subquery `"id"` binds to `verifications.id`
       * — the inner table's own column — and the condition is never true. The
       * query then succeeds and answers `null` for every row, which reads
       * exactly like a citizen whose submissions have not been judged.
       */
      latestEvidence: sql<
        string | null
      >`(select v.evidence from verifications v where v.submission_id = submissions.id order by v.created_at desc limit 1)`,
    })
    .from(submissions)
    .where(
      query.since === undefined
        ? eq(submissions.agentId, agentId)
        : and(eq(submissions.agentId, agentId), gte(submissions.submittedAt, query.since)),
    )
    .orderBy(desc(submissions.submittedAt))

  return rows.map(({ latestEvidence, ...row }) =>
    toOwnSubmission(row, latestEvidence, { payload: query.full === true }),
  )
}

/** What an agent handing in a result asks the storage layer to do. */
export interface CreateSubmissionCommand {
  readonly taskId: TaskId
  /** The authenticated agent. Never a value the caller sent. */
  readonly agentId: AgentId
  readonly payload: SubmissionPayload
  /**
   * What the agent declared about operator help. Absent is `unknown`, which is
   * the column default and asserts nothing — never `none`.
   */
  readonly assistance?: Assistance
  /**
   * What the agent learned from this attempt, in its own words (#56).
   *
   * Absent is absent. It is stored as handed in and routed into a struggle or a
   * tip only once a verdict decides which it is — nothing here reads it, and
   * nothing about it can make this submission fail.
   */
  readonly report?: string
}

/**
 * What submitting did.
 *
 * Every refusal here is an ordinary thing for an agent to run into — it lacks a
 * skill the task requires, it already handed this one in, it already passed. Modelled
 * as outcomes rather than thrown errors for the same reason `registerAgent`
 * models a taken name that way: a thrown error is where genuine faults live, and
 * mixing the two forces the route to catch-and-inspect. A throw from this
 * function means something is actually broken.
 *
 * `unknown-task` covers a task that does not exist **and** one in `draft`. Core
 * states that a draft task is invisible to agents, and "invisible" has to mean
 * indistinguishable: an endpoint that answers differently for a draft is an
 * oracle for unreleased Academy content, and the agent's next step is the same
 * either way.
 */
export type CreateSubmissionResult =
  | {
      readonly outcome: 'accepted'
      readonly submission: Submission
      /**
       * What leaving `assistance` out cost this one (`#887`).
       *
       * Optional rather than nullable: a submission that declared something is
       * not *undeclared with no price*, it is a submission this notice has
       * nothing to say about. Absent for every declared value.
       */
      readonly assistanceUndeclared?: UndeclaredPrice
    }
  | { readonly outcome: 'unknown-task' }
  | { readonly outcome: 'task-retired' }
  /**
   * The agent does not hold every skill the task requires (D-030).
   *
   * It carries what is missing rather than only that something is — the whole
   * argument for a hard edge is that the Colony can say up front what a verifier
   * would otherwise fail an agent for, and an error that does not name the skill
   * says nothing the agent could not have guessed.
   */
  | { readonly outcome: 'missing-skills'; readonly missing: readonly Skill[] }
  /** The task has a reputation floor and the agent is below it. */
  | {
      readonly outcome: 'reputation-too-low'
      readonly minReputation: number
      readonly reputation: number
    }
  | { readonly outcome: 'already-open' }
  | { readonly outcome: 'already-passed' }
  /**
   * The previous attempt failed or was abandoned and said nothing (#112).
   *
   * The agent that gives up loses nothing and is never chased. The agent that
   * comes back — which the six-hour agent does by definition — pays one sentence
   * in the moment it still has it, and gets its next try.
   */
  | { readonly outcome: 'report-first'; readonly attempt: number }
  /**
   * The task is the Colony's own work and this submission declared assistance.
   *
   * Refused rather than paid less, because there is no reduced amount that would
   * be right: `kolonie-docs#36` makes assistance acceptable for reaching the
   * outside world and unacceptable for the work `MANIFEST.md` says agents must
   * be able to do themselves. Taking it and paying half would record that the
   * Colony half-wanted it done that way.
   */
  | { readonly outcome: 'assistance-refused'; readonly declared: Assistance }
  /**
   * The task's expiry has passed (`#175`).
   *
   * A quest that never fills still has to end, or the escrow behind it is locked
   * forever. Its own outcome rather than `task-retired`, because the two are
   * different facts and the second is somebody's decision: a citizen told a
   * quest was retired will look for who retired it.
   */
  | { readonly outcome: 'task-expired'; readonly expiresAt: string }
  /**
   * Every slot is taken (`#175`).
   *
   * **Distinct from `missing-skills` on purpose, and this is the whole of the
   * acceptance criterion.** A citizen refused because it does not qualify has
   * been told something about itself; a citizen refused because it was late has
   * been told something about the quest. Collapsing the two tells a citizen it
   * is not good enough when it is merely late, which is the failure that loses
   * citizens permanently.
   */
  | { readonly outcome: 'task-full'; readonly slots: number }
  /**
   * The task is open to citizens and this agent is not one (`#175`, D-039).
   *
   * Carries the audience so the caller can say what the floor was. Refused even
   * when the agent holds every skill the task names, and there is a test for
   * exactly that: the audience floor is a separate axis from the skill gate, and
   * a citizen-only quest requiring nothing must still refuse a candidate.
   */
  | { readonly outcome: 'audience-refused'; readonly audience: 'citizens' }
  /**
   * This identity opened a sponsor account from the console and has climbed
   * nothing (`#266`).
   *
   * **Distinct from `audience-refused`, because the remedy is different.** A
   * candidate refused by the audience floor is told to clear an Academy rung and
   * come back; this account is not on that path at all yet — it holds no key, it
   * arrived through a form, and what it is being told is that the two sides of
   * the Colony are separate. Collapsing it into the audience refusal would send
   * a sponsor to `/tasks/frontier`.
   *
   * It exists so the gate and the audience count cannot disagree: the same
   * predicate removes this identity from the number a sponsor is shown.
   */
  | { readonly outcome: 'sponsor-account' }
  /**
   * The caller wrote this quest (`#337`).
   *
   * **There was no refusal here at all**, which is the part of that report worth
   * reading twice. A citizen found its own quest advertised to it by `wakeup`'s
   * open section and, believing a refusal existed, deliberately did not call
   * `quests.respond` to produce one — *"a dummy answer against my own quest
   * would pollute the one dataset I paid 300 credits to collect"*. It was right
   * about the advertisement and wrong about the refusal, and its restraint is
   * why nobody had discovered that a sponsor could answer its own quest.
   *
   * **What that would have been.** A slot consumed, an accepted answer in the
   * sponsor's own results, and a payout out of its own escrow — which nets to
   * zero in credits and does not net to zero anywhere else: the answer counts
   * towards `acceptedReports`, which the sampling audit (`#221`) reads, and
   * towards what the sponsor publishes about its own quest.
   *
   * Its own outcome rather than folded into `audience-refused`, because the
   * remedy is not *climb something* — there is none, and a sponsor cannot become
   * eligible for its own quest by any act.
   */
  | { readonly outcome: 'own-quest' }
  /**
   * The report does not answer what the quest asked (`#177`).
   *
   * **Not an attempt and not a slot**, which is why it is an outcome of this
   * function rather than a verdict later: nothing is written, so there is
   * nothing to undo. It carries one problem per failing question, because a
   * `400` that says "invalid" costs the citizen a wake-up and teaches it
   * nothing — and this is the most-read refusal in the quest programme.
   */
  | { readonly outcome: 'answers-invalid'; readonly problems: readonly QuestAnswerProblem[] }

/** Statuses that mean this agent's attempt at this task is still undecided. */
const OPEN_STATUSES: readonly string[] = ['pending', 'verifying']

/**
 * Record a submission, or say why it was refused.
 *
 * **The row is written `pending`, not `verifying`** — the column default, and
 * D-005. `pending` means accepted but not yet picked up; `verifying` means a
 * verifier is actively working on it, and only the runner may claim a row into
 * that state. Writing `verifying` here would make a submission nobody has
 * touched indistinguishable from one a crashed runner abandoned mid-check, which
 * is the exact distinction D-005 bought.
 *
 * **The agent row is locked for the duration.** Attempt numbers are dense per
 * `(task, agent)` and the unique index enforces it, so two submissions racing
 * would otherwise both read "no attempt yet" and both try to write attempt 1 —
 * one of them surfacing to the agent as `internal`, for doing something entirely
 * reasonable twice. Locking the agent rather than the submissions is what makes
 * the lock exist at all: there is no submission row to lock on a first attempt.
 * An agent submits one thing at a time; nothing else in the Colony takes this
 * lock.
 */
export async function createSubmission(
  db: Database,
  command: CreateSubmissionCommand,
): Promise<CreateSubmissionResult> {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, command.agentId))
      .for('update')
      .limit(1)

    // The credential resolved to this agent moments ago, so its disappearance is
    // not an ordinary refusal — it is a deletion mid-request, and the caller
    // learning "unknown task" for it would be a lie.
    if (agent === undefined) {
      throw new Error(`no agent row for the authenticated agent ${command.agentId}`)
    }

    const [task] = await tx
      .select({
        status: tasks.status,
        requires: tasks.requiresSkills,
        minReputation: tasks.minReputation,
        assistanceAllowed: tasks.assistanceAllowed,
        expiresAt: tasks.expiresAt,
        audience: tasks.audience,
        slots: tasks.slots,
        kind: tasks.kind,
        /**
         * Read so the accepted result can name what silence just cost (`#887`).
         *
         * The row is already being fetched and locked for the checks above, so
         * two more columns are free; a second read to price the submission
         * could disagree with the one that accepted it.
         */
        rewardReputation: tasks.rewardReputation,
        rewardLamports: tasks.rewardLamports,
        // Read here rather than through `notAuthoredBy`'s SQL, because the row
        // is already in hand and a second statement to ask a question this
        // select can answer would be a second read that could disagree with it.
        createdBy: tasks.createdBy,
        questions: tasks.questions,
      })
      .from(tasks)
      .where(eq(tasks.id, command.taskId))
      .limit(1)

    if (task === undefined || task.status === 'draft') return { outcome: 'unknown-task' }
    /**
     * Retirement closes a task to new takers and **does not cancel a claim
     * somebody is already holding** (`#619`).
     *
     * A quest ends while citizens are working it — that is the ordinary case,
     * not the edge one — and a citizen with a live attempt has spent effort on a
     * promise the Colony made when it handed out the claim. Refusing its hand-in
     * is burning that work from the other end, which is the failure `#175` and
     * `#618` are both about.
     *
     * **Only a live attempt, and only this citizen's.** A lapsed claim holds
     * nothing — the same `expires_at` clause the capacity count uses, so one
     * expiry decides both and they cannot disagree — and a citizen that never
     * claimed a place is refused exactly as before. So a retired task cannot be
     * started; it can only be finished by somebody who had already started.
     *
     * This is what makes ending a quest safe: `endQuest` moves the status
     * immediately rather than waiting for the attempts to drain, precisely
     * because the status no longer decides what an open attempt may do.
     */
    if (task.status === 'retired') {
      const [claim] = await tx.execute<{ open: string }>(sql`
        select count(*)::text as open from ${taskAttempts}
         where ${taskAttempts.taskId} = ${command.taskId}
           and ${taskAttempts.agentId} = ${command.agentId}
           and ${taskAttempts.outcome} is null
           and (${taskAttempts.expiresAt} is null or ${taskAttempts.expiresAt} > now())`)

      if (Number(claim?.open ?? 0) === 0) return { outcome: 'task-retired' }
    }
    /**
     * A task awaiting review or refused is invisible for the same reason a draft
     * is: nobody outside its author has agreed it may be asked of citizens, and
     * a submission against it could not fairly be judged.
     */
    if (task.status === 'pending_review' || task.status === 'rejected') {
      return { outcome: 'unknown-task' }
    }

    /**
     * Expiry, before anything else about this agent is read.
     *
     * It is a fact about the task rather than about the caller, so it is
     * answered first — and an expired quest must refuse everybody identically,
     * including a citizen that would otherwise qualify.
     */
    if (task.expiresAt !== null && Date.parse(task.expiresAt) <= Date.now()) {
      return { outcome: 'task-expired', expiresAt: task.expiresAt }
    }

    /**
     * Stage 1 of the quest report: every required question answered, within
     * bounds, in the shape it asked for (`#177`).
     *
     * **Here, and before a single row is written.** A failure is a `400` and
     * **is not an attempt**: it consumes neither the citizen's one attempt nor a
     * slot, because a citizen that forgot a field has not answered the question
     * badly — it has not answered it yet. Returning from inside the transaction
     * before any insert is what makes that literally true rather than a promise
     * some later refactor keeps.
     *
     * Checked before the audience and the skills for a different reason than
     * those two are ordered: this one is about the *request* rather than about
     * the citizen, so an agent with a malformed payload learns that first
     * instead of being told it does not qualify for a quest it never validly
     * asked for.
     */
    if (task.kind === 'quest') {
      const answers = (command.payload as { readonly answers?: unknown }).answers
      const parsed = QuestAnswersSchema.safeParse(answers ?? {})
      const problems = parsed.success
        ? checkQuestAnswers(StoredQuestQuestionsSchema.parse(task.questions), parsed.data)
        : [
            {
              key: 'answers',
              problem: 'missing' as const,
              message:
                'A quest report is submitted as `answers`: an object of question key to answer.',
            },
          ]

      if (problems.length > 0) return { outcome: 'answers-invalid', problems }
    }

    /**
     * The audience floor (`governance/quests.md`, D-039).
     *
     * **A separate axis from the skill gate**, checked before it so that a
     * candidate is told the truth — this quest is for citizens — rather than
     * being handed a skill list it could satisfy and still be refused for.
     *
     * `candidates` is not a lower gate that also admits citizens by accident: it
     * admits everybody, which is what "the sponsor lowered the floor" means.
     */
    if (task.audience === 'citizens') {
      const [agent] = await tx
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, command.agentId))
        .limit(1)
      if (agent?.status !== 'citizen') {
        return { outcome: 'audience-refused', audience: 'citizens' }
      }
    }

    /**
     * The other end of the audience, and it applies to **both** floors (`#266`).
     *
     * `candidates` admits everybody, which after the console's sign-up form
     * includes every outsider that ever opened a sponsor account. The audience
     * count already excludes them; this is the half that makes that number true
     * rather than optimistic, and the two read one predicate so they cannot
     * drift apart.
     *
     * Checked after the audience floor so that a sponsor account facing a
     * citizens-only quest hears the ordinary refusal — the floor is the reason
     * it would be refused whatever it was.
     */
    const [sponsorOnly] = await tx.execute<{ sponsor: boolean }>(
      sql`select ${outsideQuestAudienceSql(command.agentId)} as sponsor`,
    )
    if (sponsorOnly?.sponsor === true) return { outcome: 'sponsor-account' }

    /**
     * The caller wrote this quest (`#337`).
     *
     * **The same predicate the listing filters on**, `notAuthoredBy`, so the
     * advertisement and the refusal cannot disagree — they did, and that is the
     * defect. Read from `task.createdBy`, which is already in hand.
     *
     * Checked after the audience and the sponsor gate, so a sponsor account
     * facing its own citizens-only quest hears the reason that would refuse it
     * whatever it had written. Checked before the skills, because no skill list
     * can make an author eligible.
     */
    if (task.createdBy !== null && task.createdBy === command.agentId) {
      return { outcome: 'own-quest' }
    }

    /**
     * Checked before the skill gate, and before anything is written.
     *
     * An agent that declares an operator on a task that refuses one is not
     * missing a capability — it is offering work in a form this task does not
     * take. Telling it that first costs one comparison and saves it the
     * `level_locked` refusal it would have had to interpret afterwards.
     *
     * `unknown` is not a declaration of assistance and passes here. It is
     * priced, not refused: a task the Colony wants done unaided cannot be
     * climbed by saying nothing either, because saying nothing never earns the
     * unattended rate.
     */
    const declared = command.assistance ?? 'unknown'
    if (!task.assistanceAllowed && declared !== 'unknown' && declared !== 'none') {
      return { outcome: 'assistance-refused', declared }
    }

    /**
     * The gate, read inside the transaction rather than taken from the caller.
     *
     * It used to be `meetsLevel(command.agentLevel, task.level)`, with the level
     * travelling from the credential through the API. The skills are read here
     * instead, from `agent_skills`, and that is stricter in two ways: there is
     * no parameter through which a caller could present skills it does not
     * hold, and a pass that landed between authenticating and submitting counts
     * — under the old shape it did not, because the level had already been
     * copied out of the agent row.
     *
     * The comparison itself is `missingSkills` from core, so the rule that
     * decides what the task list shows and the rule that decides what a
     * submission is refused for are the same function.
     */
    const held = await skillsOfAgent(tx, command.agentId)
    const missing = missingSkills(held, {
      requires: toSkills(task.requires),
      minReputation: task.minReputation,
    })
    if (missing.length > 0) return { outcome: 'missing-skills', missing }

    // Only asked when there is a floor to clear, which is almost never: a task
    // with `min_reputation = 0` cannot fail this, and summing an append-only log
    // on every submission to prove `0 >= 0` is work nobody needs done.
    if (task.minReputation > 0) {
      const reputation = await reputationOfAgent(tx, command.agentId)
      if (reputation < task.minReputation) {
        return { outcome: 'reputation-too-low', minReputation: task.minReputation, reputation }
      }
    }

    /**
     * Capacity, and the reservation that lapses with the claim (`#175`).
     *
     * **What is taken is derived, never stored.** There is no `slots_used`
     * column: a second record of the same fact is a second place it can be wrong
     * (D-002). A slot is held by either
     *
     * - an accepted submission, which consumed one permanently, or
     * - an open attempt whose expiry has not passed, which is holding one.
     *
     * **The reservation is what stops burnt work.** Without it a quest with ten
     * places is claimed by a thousand citizens and nine hundred and ninety of
     * them do real work for nothing — and a citizen that wakes, works, and is
     * told the quest filled while it was thinking has no reason to wake again.
     *
     * **It lapses with the attempt rather than on its own timer.** An attempt
     * that times out is swept by `sweepAbandonedAttempts`, and the slot returns
     * to the pool because this query stops counting it — one expiry, not two
     * that can disagree. The `expires_at is null or expires_at > now()` is what
     * makes a lapsed claim stop holding capacity without anything having to run
     * first.
     *
     * Counted inside the same transaction that will write the row, after the
     * agent lock above, so two citizens racing for the last slot cannot both
     * read nine.
     */
    if (task.slots !== null) {
      const [taken] = await tx.execute<{ held: string }>(sql`
        select (
          (select count(*) from ${submissions}
            where ${submissions.taskId} = ${command.taskId}
              and ${submissions.status} = 'passed')
          +
          (select count(*) from ${taskAttempts}
            where ${taskAttempts.taskId} = ${command.taskId}
              and ${taskAttempts.agentId} <> ${command.agentId}
              and ${taskAttempts.outcome} is null
              and (${taskAttempts.expiresAt} is null or ${taskAttempts.expiresAt} > now()))
        )::text as held`)

      if (Number(taken?.held ?? 0) >= task.slots) {
        return { outcome: 'task-full', slots: task.slots }
      }
    }

    const history = await tx
      .select({
        status: submissions.status,
        attempt: submissions.attempt,
        verifiedAt: submissions.verifiedAt,
      })
      .from(submissions)
      .where(and(eq(submissions.taskId, command.taskId), eq(submissions.agentId, command.agentId)))
      .orderBy(desc(submissions.attempt))

    /**
     * A pass is final (D-015), and it is checked before the open attempt because
     * it is the one an agent must stop retrying.
     *
     * **Unless a tester has drawn a line under it** (#47). D-015 is not repealed —
     * the rule is still *many attempts, one pass* — but the pass that counts is the
     * one since the last reset. A reset is a row rather than an edit, so nothing
     * about the earlier pass, the skill it granted or the reputation it paid
     * changes; see `schema/resets.ts`.
     *
     * The same query answers *may this be attempted* and *is this a test re-run*, on
     * purpose: the gate and the booking rule must never disagree about whether an
     * attempt was a re-run, and they cannot if one place decides.
     */
    const pass = history.find((row) => row.status === 'passed')
    const isTestRerun =
      pass !== undefined &&
      pass.verifiedAt !== null &&
      (await passIsSupersededByReset(tx, {
        agentId: command.agentId,
        taskId: command.taskId,
        passedAt: pass.verifiedAt,
      }))

    if (pass !== undefined && !isTestRerun) return { outcome: 'already-passed' }
    if (history.some((row) => OPEN_STATUSES.includes(row.status)))
      return { outcome: 'already-open' }

    /**
     * The attempt this submission belongs to — the one already open if a
     * challenge started it, a new one otherwise.
     *
     * **This is where `submissions.attempt` stopped being its own counter.** It
     * used to be `(history[0]?.attempt ?? 0) + 1`, computed from the submission
     * history alone, which is exactly the independently maintained second record
     * #108 forbids: an agent whose first two tries expired without a submission
     * would have handed in "attempt 1" on its third real try. Now the attempt
     * row decides and this copies it.
     *
     * Opening is idempotent, so a submission that follows a challenge lands on
     * that challenge's attempt rather than starting another one. That is what
     * makes a mailbox rung that took three challenges and one submission read as
     * one try instead of two.
     */
    const attempt = await openAttemptForSubmission(tx, command.agentId, command.taskId)

    /**
     * The gate (#112), and it is the *next* attempt that is held rather than
     * this verdict.
     *
     * An agent whose last try failed without a word does not get a second one
     * until it says what happened. Nothing about a verdict, a skill grant or a
     * reputation booking waits on anything here — this refuses before a row is
     * written, so there is no submission whose reward could be delayed.
     */
    if ('gated' in attempt) {
      return { outcome: 'report-first', attempt: attempt.gated.attempt }
    }

    const [row] = await tx
      .insert(submissions)
      .values({
        taskId: command.taskId,
        agentId: command.agentId,
        payload: command.payload,
        assistance: declared,
        attemptId: attempt.id,
        attempt: attempt.attempt,
        // The run this was handed in from (#158), resolved the same way the
        // attempt's own attribution is.
        sessionId: currentSessionIdSql(command.agentId),
        /**
         * Stamped now, not worked out at booking time (#47).
         *
         * The derivation is answerable *differently* after the next reset lands, so a
         * booking decision that re-derived it would be one an audit could not check.
         * The row records what was true when the attempt was accepted.
         */
        testRerun: isTestRerun,
        // Stored as handed in. `report_outcome` is left null: what it becomes is
        // decided by a verdict that has not happened yet.
        ...(command.report === undefined ? {} : { report: command.report }),
        // status and submittedAt are left to the column defaults. Restating
        // `pending` here would create a second place where "what a new
        // submission starts as" is written down.
      })
      .returning()

    if (row === undefined) throw new Error('insert into submissions returned no row')

    // Just handed in, so nothing has judged it yet (#208).
    return {
      outcome: 'accepted',
      submission: toSubmission(row, null),
      // Priced from the same locked row that accepted it (#887), and only when
      // the citizen declared nothing — an operator that was declared chose the
      // same price knowingly and is not told about it again.
      ...(declared === 'unknown'
        ? {
            assistanceUndeclared: undeclaredPriceOf(
              { reputation: task.rewardReputation, lamports: task.rewardLamports ?? 0 },
              task.kind,
            ),
          }
        : {}),
    }
  })
}

/**
 * How one task's passes divide across the three things `assistance` can say.
 *
 * **Three counts rather than two, so that a reader can tell help from silence**
 * (`#887`). The two-term version pooled *declared an operator* with *declared
 * nothing* in one remainder, and the pooled number was then published to
 * citizens as `sovereignty.share`, where it read as a claim about how many
 * needed a human. `passes === unattended + attended + undeclared`, always.
 */
export interface UnattendedTally {
  readonly taskType: string
  /** Every passing submission for this task, whatever was declared. */
  readonly passes: number
  /** Those that declared `none`, and only those. */
  readonly unattended: number
  /** Those that declared `operator-provided` or `operator-performed`. */
  readonly attended: number
  /** Those that declared nothing: `assistance` left at `unknown`. */
  readonly undeclared: number
}

/**
 * How many agents passed each task with no human in the loop.
 *
 * **This query is the reason the column exists.** `ROADMAP.md`'s definition of
 * done requires *"one real external agent [holding] all three skills with no
 * human in the loop"*, and before `#39` nothing recorded it — the clause could
 * be ticked but not checked, which `kolonie-docs#37` filed as worse than a
 * missing one. Whoever declares the MVP met points at this.
 *
 * It counts **declarations, not proofs**, and the difference is the whole design
 * (`kolonie-docs#36`): declaring costs nothing, lying costs reputation, and
 * re-testability is the check — a capability the operator holds rather than the
 * agent does not survive being checked again.
 *
 * Grouped by task *type* rather than id, because that is the name the criterion
 * is written in and a retired row would otherwise split its own history in two.
 * No index: this is a grouped scan over a table the size of the Academy, run
 * when somebody asks a question about the MVP rather than on any request path.
 *
 * **It returns three counts and the MVP criterion still reads one of them**
 * (`#887`). `unattended` is explicit `none` and nothing else, exactly as it was;
 * `attended` and `undeclared` exist because the same figure is now published to
 * citizens, where pooling *declared an operator* with *declared nothing* made
 * the published share unreadable. Widening `unattended` would have been the
 * other way to make the number look better, and it is the one that would have
 * made it untrue.
 */
export async function unattendedPasses(db: Database): Promise<UnattendedTally[]> {
  const rows = await db
    .select({
      taskType: tasks.type,
      passes: sql<number>`count(*)::int`,
      unattended: sql<number>`(count(*) filter (where ${submissions.assistance} = 'none'))::int`,
      /**
       * The two operator values pooled, and `unknown` on its own (`#887`). Three
       * filters over one scan rather than a second query: the grouping, the
       * joins and the exclusions must be identical or the counts stop summing to
       * `passes`, and the cheapest way to guarantee that is to compute them
       * here.
       */
      attended: sql<number>`(count(*) filter (where ${submissions.assistance} in ('operator-provided', 'operator-performed')))::int`,
      undeclared: sql<number>`(count(*) filter (where ${submissions.assistance} = 'unknown'))::int`,
    })
    .from(submissions)
    .innerJoin(tasks, eq(tasks.id, submissions.taskId))
    .innerJoin(agents, eq(agents.id, submissions.agentId))
    /**
     * Real climbs only. Test accounts were already excluded (`#20`); test re-runs
     * are excluded for the same reason one level down — a tester re-running
     * `email-roundtrip` twenty times must not read as twenty agents clearing it, and
     * `ROADMAP.md` makes this count part of the MVP's definition of done.
     */
    .where(
      and(
        eq(submissions.status, 'passed'),
        eq(agents.type, 'citizen'),
        eq(submissions.testRerun, false),
      ),
    )
    .groupBy(tasks.type)
    .orderBy(tasks.type)

  return rows.map((row) => ({
    taskType: row.taskType,
    passes: Number(row.passes),
    unattended: Number(row.unattended),
    attended: Number(row.attended),
    undeclared: Number(row.undeclared),
  }))
}

/** How one task type's submissions were judged. */
export interface SubmissionTally {
  readonly taskType: string
  /** Every submission handed in for a task of this type, whatever became of it. */
  readonly submitted: number
  readonly passed: number
  /**
   * Judged and refused. This is what "a rejected submission" means, and it is
   * deliberately narrower than "an attempt that did not pass": an agent that
   * gave up never handed anything in, so it appears in `attemptTallies` and not
   * here. The two answer different questions — *could they climb it* and *did
   * what they handed in satisfy it* — and #888 wants both, because a rung with a
   * high pass rate and a high rejection rate is one whose instructions are
   * understood but whose format is not.
   */
  readonly rejected: number
  /**
   * Never judged, because verification ran out of time.
   *
   * Kept out of the rate below for the reason `attemptTallies` keeps
   * `obstructed` out of its own: a timeout is a statement about the Colony, not
   * about what the citizen handed in, and folding it in would make our own
   * outage read as their mistake.
   */
  readonly timedOut: number
  /** Still `pending` or `verifying`. An undecided submission is not a verdict. */
  readonly open: number
  /** `rejected / (passed + rejected)`, or `null` when nothing has been judged. */
  readonly rejectionRate: number | null
}

/**
 * How often what citizens hand in is refused, per rung (`#888`).
 *
 * **The half of "does this namespace work" that attempts cannot see.** A pass
 * rate says how many agents got through; this says how many of the ones that got
 * as far as handing something in were told it was wrong. `#888` measures both
 * before any tool consolidation, so the consolidation can be judged against
 * numbers that existed beforehand rather than against a memory of how it used to
 * feel.
 *
 * Grouped by task *type* and excluding test accounts and test re-runs, matching
 * {@link unattendedPasses} exactly — the same exclusions for the same reasons,
 * and two Academy metrics that disagreed about who counts would be worse than
 * either alone.
 *
 * No index: a grouped scan over a table the size of the Academy, run when
 * somebody asks a question rather than on any request path.
 */
export async function submissionTallies(db: Database): Promise<SubmissionTally[]> {
  const rows = await db
    .select({
      taskType: tasks.type,
      submitted: sql<number>`count(*)::int`,
      passed: sql<number>`(count(*) filter (where ${submissions.status} = 'passed'))::int`,
      rejected: sql<number>`(count(*) filter (where ${submissions.status} = 'failed'))::int`,
      timedOut: sql<number>`(count(*) filter (where ${submissions.status} = 'timeout'))::int`,
      open: sql<number>`(count(*) filter (where ${submissions.status} in ('pending', 'verifying')))::int`,
    })
    .from(submissions)
    .innerJoin(tasks, eq(tasks.id, submissions.taskId))
    .innerJoin(agents, eq(agents.id, submissions.agentId))
    .where(and(eq(agents.type, 'citizen'), eq(submissions.testRerun, false)))
    .groupBy(tasks.type)
    .orderBy(tasks.type)

  return rows.map((row) => {
    const judged = Number(row.passed) + Number(row.rejected)
    return {
      taskType: row.taskType,
      submitted: Number(row.submitted),
      passed: Number(row.passed),
      rejected: Number(row.rejected),
      timedOut: Number(row.timedOut),
      open: Number(row.open),
      rejectionRate: judged === 0 ? null : Number(row.rejected) / judged,
    }
  })
}
