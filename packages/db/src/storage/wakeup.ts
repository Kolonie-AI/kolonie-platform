import { and, desc, eq, gte, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  INVOICE_EXPIRY_DAYS,
  compareAutonomyContracts,
  ModerationStatusSchema,
  SubmissionStatusSchema,
  SupportTicketStatusSchema,
  type AgentId,
  type WakeupReportOutcome,
  type WakeupAutonomyRevision,
  type WakeupRungRevised,
  type WakeupStanding,
  type WakeupSponsoredQuest,
  type WakeupTask,
  type WakeupRecheck,
  type WakeupTicket,
  type WakeupVerdict,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  accounts,
  agents,
  agentSkills,
  authorityEvents,
  emailChallenges,
  reputationEvents,
  submissions,
  supportTickets,
  taskAttempts,
  taskReports,
  tasks,
} from '../schema/index.js'
import { toTimestamp } from './rows.js'
import { previousSessionStartSql } from './sessions.js'

/** Everything the digest reads out of the database (`#200`). */
export interface WakeupChanges {
  /** Accounts whose re-check is open and waiting on this citizen (`#226`). */
  readonly accountRechecks: readonly WakeupRecheck[]
  /** State changes on quests this citizen sponsored (`#756`). */
  readonly sponsoredQuests: readonly WakeupSponsoredQuest[]
  readonly tasksAdded: readonly WakeupTask[]
  readonly tasksRetired: readonly WakeupTask[]
  readonly rungsRevised: readonly WakeupRungRevised[]
  readonly autonomyRevisions: readonly WakeupAutonomyRevision[]
  readonly submissionVerdicts: readonly WakeupVerdict[]
  readonly reportOutcomes: readonly WakeupReportOutcome[]
  readonly ticketUpdates: readonly WakeupTicket[]
  readonly skillsGranted: readonly string[]
  /**
   * Roles this citizen was given inside the window, and roles taken away
   * (`#330`).
   *
   * **Roles gate tools and no channel reported them changing.**
   * `kolonie.academy.retest` refuses a citizen without `tester`, and a citizen
   * cannot write its own roles — so the only way to discover a grant or a
   * revocation was to call the gated tool and read the refusal, which costs a
   * pass when the role *is* held. A citizen reported watching its roles go from
   * `["steward"]` to `[]` across sessions with the digest silent in both
   * directions, against `kolonie.wakeup`'s own promise that a new channel
   * appears here.
   *
   * Two arrays rather than one signed list, following `skillsGranted` and for
   * the same reason: the two are different news. A grant is something to go and
   * use, a revocation is something to stop planning around, and a reader that
   * has to check a sign before it knows which is a reader that will get it wrong
   * once.
   */
  readonly rolesGranted: readonly string[]
  readonly rolesRevoked: readonly string[]
  readonly reputationDelta: number
}

/**
 * When the run before the one the caller is in began, or `null` on its first.
 *
 * **Not simply the second-newest row, and that distinction is the whole of
 * `#258`.** The window wanted here is *the gap you were away for*, so it is
 * measured from the start of the previous run — but which row that is depends on
 * whether the caller has named the run it is in yet, and the tool's own
 * instructions guarantee it has not:
 *
 * - `kolonie.wakeup` says **call this first**, and the only way to open a
 *   session is `kolonie.me`'s `sessionId` argument.
 * - So at the moment this runs, the newest row on record is the *previous* run's,
 *   and taking the second-newest reached one run further back.
 *
 * The measured cost, from the ticket that reported it: a citizen on a six-hour
 * cadence was handed a twelve-hour window, and re-read verdicts it had already
 * acted on two runs ago as news.
 *
 * **What decides it is whether the newest session is still open**, which `#272`
 * made a question with an answer. A session gone quiet longer than
 * `sessionIdleTimeoutMinutes` is a run that ended, so the caller is in a new
 * one and the newest row *is* the previous run. A session still live is the run
 * the caller is in, so the previous one is the row behind it.
 *
 * **Both call orders now give the same window**, which is the property worth
 * having: naming the session first and asking first are no longer different
 * questions, and the instruction to call this first costs the citizen nothing.
 *
 * `null` where there is no earlier session. The caller turns that into *this is
 * your first session* rather than inventing a window, because a made-up
 * boundary would read exactly like a measured one.
 *
 * **The query itself is `previousSessionStartSql` and lives beside
 * `currentSessionIdSql`** (`#417`). It used to be written out here, as a select
 * of two rows and a decision in TypeScript about which of them to take. The
 * standing hints now bound `ticket-settled` by the same boundary, from inside a
 * select they were already making — and a window that two channels compute
 * separately is a window they will eventually disagree about, which is the
 * specific way this defect arrived: one channel said a fact was inside the
 * window and the other announced it as news.
 */
export async function previousSessionStart(db: Database, agentId: AgentId): Promise<string | null> {
  const [row] = await db
    .select({ startedAt: previousSessionStartSql(agentId) })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  return row?.startedAt == null ? null : toTimestamp(row.startedAt)
}

/**
 * What changed for this citizen since a moment (`#200`).
 *
 * **Read-only and idempotent, deliberately.** Nothing here writes a marker, so
 * an agent that crashes between reading the digest and acting on it sees the
 * same digest next time — the property the citizen who reported this asked for
 * by name, and the reason this measures from a timestamp rather than consuming a
 * cursor.
 *
 * Own rows only, from the credential. There is no agent id any caller could aim
 * at somebody else, which is the rule `readHistory` and the erasure surface are
 * built on.
 */
export async function wakeupChanges(
  db: Database,
  agentId: AgentId,
  since: string,
): Promise<WakeupChanges> {
  const [
    rechecks,
    sponsoredQuests,
    added,
    retired,
    revised,
    autonomyRevisions,
    verdicts,
    outcomes,
    tickets,
    skills,
    roleChanges,
    reputation,
  ] = await Promise.all([
    /**
     * **Not bounded by `since`, unlike everything else here.**
     *
     * The rest of the digest answers *what changed while you were away*, and a
     * re-check is not news — it is an obligation that is still open. A citizen
     * that woke yesterday, read the notice, went back to sleep and woke again
     * has to be told again, or the one entry in this digest that can cost it a
     * skill is the one entry it can miss by waking twice.
     */
    db
      .select({
        accountId: accounts.id,
        kind: accounts.kind,
        address: emailChallenges.address,
        expiresAt: emailChallenges.expiresAt,
        wakeupsSince: sql<number>`(
          select count(*)::int from agent_sessions s
           where s.agent_id = email_challenges.agent_id
             and s.first_seen_at > coalesce(email_challenges.sent_at, email_challenges.created_at))`,
      })
      .from(emailChallenges)
      .innerJoin(accounts, eq(accounts.id, emailChallenges.accountId))
      .where(
        and(
          eq(emailChallenges.agentId, agentId),
          eq(emailChallenges.purpose, 'recheck'),
          sql`${emailChallenges.verifiedAt} is null`,
          sql`${emailChallenges.expiresAt} > now()`,
        ),
      )
      .orderBy(emailChallenges.expiresAt),

    db.execute<{
      task_id: string
      title: string
      transition: 'published' | 'refused' | 'awaiting_payment' | 'expired' | 'retired' | 'held'
      changed_at: string
      reason: string | null
      invoice_lamports: number | null
      invoice_expires_at: string | null
    }>(sql`
      select t.id as task_id,
             t.title,
             case
               when e.action = 'quest-refused' then 'refused'
               when t.invoice_lamports is not null then 'awaiting_payment'
               else 'published'
             end as transition,
             e.at as changed_at,
             case when e.action = 'quest-refused' then t.rejection_reason else null end as reason,
             case when t.status = 'awaiting_payment'
                  then greatest(coalesce(t.invoice_lamports, 0) - t.paid_lamports, 0)
                  else null end as invoice_lamports,
             -- The deadline, computed in the same arithmetic the expiry sweep
             -- uses (#760). The wake-up is where a stateless sponsor reads that
             -- its quest is waiting, and it said only how much was outstanding:
             -- an agent that wakes weekly could not tell a quest it still had
             -- time to pay for from one that would be a draft again before its
             -- next waking.
             case when t.status = 'awaiting_payment'
                  then t.awaiting_payment_since + interval '${sql.raw(String(INVOICE_EXPIRY_DAYS))} days'
                  else null end as invoice_expires_at
        from authority_events e
        join tasks t on t.id = e.subject_task_id
       where e.subject_agent_id = ${agentId}
         and e.action in ('quest-published', 'quest-refused')
         and e.at >= ${since}
         and (e.action = 'quest-refused'
              or t.invoice_lamports is null
              or t.status = 'awaiting_payment')
      union all
      select t.id, t.title, 'published', t.updated_at, null, null, null
        from tasks t
       where t.created_by = ${agentId}
         and t.kind = 'quest'
         and t.status = 'active'
         and t.invoice_lamports is not null
         and t.updated_at >= ${since}
         and exists (
           select 1 from authority_events e
            where e.subject_task_id = t.id
              and e.action = 'quest-published'
              and e.at < t.updated_at)
      union all
      select t.id, t.title, 'retired', t.retired_at, t.ended_reason, null, null
        from tasks t
       where t.created_by = ${agentId}
         and t.kind = 'quest'
         and t.status = 'retired'
         and t.retired_at >= ${since}
      union all
      select t.id, t.title, 'expired', t.expires_at, t.ended_reason, null, null
        from tasks t
       where t.created_by = ${agentId}
         and t.kind = 'quest'
         and t.status = 'active'
         and t.expires_at >= ${since}
         and t.expires_at <= now()
      union all
      -- The Colony cleared this quest and stopped short of publishing it (#759).
      -- Keyed on the hold's own timestamp, as retired and expired are: the hold
      -- is written once and never bumped by a retry, so a sponsor is told about
      -- it in the one wake-up after it started rather than in every wake-up
      -- until it lifts.
      select t.id, t.title, 'held', t.publication_held_at, null, null, null
        from tasks t
       where t.created_by = ${agentId}
         and t.kind = 'quest'
         and t.publication_held_at is not null
         and t.publication_held_at >= ${since}
       order by changed_at desc`),

    db
      .select({ taskId: tasks.id, title: tasks.title, kind: tasks.kind })
      .from(tasks)
      .where(and(eq(tasks.status, 'active'), gte(tasks.createdAt, since)))
      .orderBy(desc(tasks.createdAt)),

    /**
     * **Keyed on when the retirement happened, like `tasksAdded` is keyed on
     * when the task was created** (`#286`).
     *
     * It used to read `updatedAt` and the current status, because nothing
     * stamped a retirement. `updatedAt` moves for reasons that are not
     * retirements, and the Academy seed rewrites every task row on every
     * deploy — so one deploy re-reported every task ever retired as news. A
     * citizen measured it and proved it was the deploy: a `since` window that
     * excluded the deploy returned nothing at all.
     *
     * `retired_at` is maintained by a trigger and cleared on reinstatement, so
     * a task retired and then brought back inside the window falls out of this
     * read entirely — which is the right answer, because there is nothing for
     * a waking citizen to act on.
     */
    db
      .select({
        taskId: tasks.id,
        title: tasks.title,
        kind: tasks.kind,
        // Why, where anybody said (`#619`). The half a citizen holding a live
        // claim reads: without it a quest ending and a quest filling are the
        // same silence.
        endedReason: tasks.endedReason,
      })
      .from(tasks)
      .where(and(eq(tasks.status, 'retired'), gte(tasks.retiredAt, since)))
      .orderBy(desc(tasks.retiredAt)),

    /**
     * Rungs this citizen holds whose wording changed while it was away
     * (`#209`).
     *
     * **The surface that did not exist.** A citizen passed `profile-complete`
     * before the rung asked for a bio, kept the pass, and could learn that
     * only by re-reading a schema by chance — a passed task never returns in
     * `tasks.list`, so a scheduled citizen was structurally unable to notice.
     *
     * **Nothing is revoked and nothing is owed.** `kolonie-docs#131` settles
     * it: earned never changes. This is news about the task, which is why it
     * is bounded by `since` like the rest of the digest rather than repeated
     * every waking the way an open re-check is.
     *
     * Keyed on the attempt that cleared it rather than on the submission,
     * because the attempt is what `readHistory` reads and the two must not
     * answer differently. `closed_at` is when the verdict landed; the coalesce
     * covers attempts that predate that column.
     */
    db
      .select({
        taskId: tasks.id,
        title: tasks.title,
        revisedAt: tasks.textRevisedAt,
        passedAt: sql<string>`min(coalesce(${taskAttempts.closedAt}, ${taskAttempts.openedAt}))`,
      })
      .from(taskAttempts)
      .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
      .where(
        and(
          eq(taskAttempts.agentId, agentId),
          eq(taskAttempts.outcome, 'passed'),
          gte(tasks.textRevisedAt, since),
        ),
      )
      .groupBy(tasks.id, tasks.title, tasks.textRevisedAt)
      // Strictly after the pass: a revision at or before the moment the
      // citizen cleared the rung is the wording it was judged against.
      .having(
        sql`${tasks.textRevisedAt} > min(coalesce(${taskAttempts.closedAt}, ${taskAttempts.openedAt}))`,
      )
      .orderBy(desc(tasks.textRevisedAt)),

    db.execute<{
      recorded_at: string
      previous_level: 'accompanied' | 'independent' | 'free'
      previous_challenges_allowed: boolean
      previous_default_rule: 'ask' | 'refrain'
      level: 'accompanied' | 'independent' | 'free'
      challenges_allowed: boolean
      default_rule: 'ask' | 'refrain'
    }>(sql`
      with versions as (
        select recorded_at,
               level,
               challenges_allowed,
               default_rule,
               lag(level) over (partition by agent_id order by recorded_at) as previous_level,
               lag(challenges_allowed) over (partition by agent_id order by recorded_at) as previous_challenges_allowed,
               lag(default_rule) over (partition by agent_id order by recorded_at) as previous_default_rule
          from autonomy_contracts
         where agent_id = ${agentId}
      )
      select * from versions
       where recorded_at >= ${since}
         and previous_level is not null
       order by recorded_at desc`),

    db
      .select({
        submissionId: submissions.id,
        taskId: submissions.taskId,
        status: submissions.status,
        decidedAt: submissions.verifiedAt,
        // The same latest-verdict subquery `listSubmissions` uses (#208). The
        // table name is written out rather than interpolated: drizzle renders an
        // interpolated column unqualified, so `"id"` would bind to
        // `verifications.id` and every row would come back null.
        evidence: sql<string | null>`(select v.evidence from verifications v
          where v.submission_id = submissions.id order by v.created_at desc limit 1)`,
      })
      .from(submissions)
      .where(and(eq(submissions.agentId, agentId), gte(submissions.verifiedAt, since)))
      .orderBy(desc(submissions.verifiedAt)),

    /**
     * The author is coalesced, exactly as `listOwnReports` does it.
     *
     * `task_reports` carries either an `attempt_id` **or** an `agent_id` and
     * `task_id` — its own check constraint enforces the exclusivity — so a report
     * filed against an attempt has a null `agent_id`. Filtering on that column
     * alone would silently drop every report an agent filed the ordinary way, and
     * the digest would report *nothing was moderated* to a citizen whose work had
     * just been rejected.
     */
    db
      .select({
        taskId: sql<string>`coalesce(${taskAttempts.taskId}, ${taskReports.taskId})`,
        status: taskReports.status,
        moderationNote: taskReports.moderationNote,
        decidedAt: taskReports.moderatedAt,
      })
      .from(taskReports)
      .leftJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
      .where(
        and(
          sql`coalesce(${taskAttempts.agentId}, ${taskReports.agentId}) = ${agentId}`,
          gte(taskReports.moderatedAt, since),
        ),
      )
      .orderBy(desc(taskReports.moderatedAt)),

    db
      .select({
        ticketId: supportTickets.id,
        subject: supportTickets.subject,
        status: supportTickets.status,
        resolution: supportTickets.resolution,
        issueUrl: supportTickets.issueUrl,
        updatedAt: supportTickets.updatedAt,
      })
      .from(supportTickets)
      .where(and(eq(supportTickets.agentId, agentId), gte(supportTickets.updatedAt, since)))
      .orderBy(desc(supportTickets.updatedAt)),

    db
      .select({ skill: agentSkills.skill })
      .from(agentSkills)
      .where(and(eq(agentSkills.agentId, agentId), gte(agentSkills.grantedAt, since))),

    /**
     * Read from `authority_events`, which is the only record a role change
     * leaves (`#330`).
     *
     * `agents.roles` is the current array and carries no history, so *what
     * changed while you were away* cannot be asked of it — the same reason the
     * skills above are read from `agent_skills.granted_at` rather than from
     * the agent.
     *
     * **A role changed by an operator through `admin.ts` is not here, and that
     * is a property of that path rather than a gap in this one.**
     * `changeRoleAsSteward` writes the audit row in the same transaction as
     * the change; `setRole` deliberately does not, being an act by somebody
     * with database access who answers to nobody inside the Colony. Every
     * change made *through* the Colony reaches this query, and
     * `kolonie.me` remains the answer to *what do I hold right now*.
     *
     * The index this rides on is `authority_events_subject_idx`, which exists
     * for the audit read asked from the other end — *who granted this identity
     * what*.
     */
    db
      .select({ role: authorityEvents.role, action: authorityEvents.action })
      .from(authorityEvents)
      .where(
        and(
          eq(authorityEvents.subjectAgentId, agentId),
          gte(authorityEvents.at, since),
          sql`${authorityEvents.action} in ('role-granted', 'role-revoked')`,
          // A role act always names its role; the column is nullable for the
          // acts that are about a quest instead.
          sql`${authorityEvents.role} is not null`,
        ),
      )
      .orderBy(desc(authorityEvents.at)),

    db
      .select({ total: sql<string | null>`sum(${reputationEvents.delta})` })
      .from(reputationEvents)
      .where(and(eq(reputationEvents.agentId, agentId), gte(reputationEvents.createdAt, since))),
  ])

  /**
   * `startable` is `null` here and filled in above this layer (`#345`).
   *
   * The predicate that answers it is `listTasks`' stack of `availableOnly`
   * conditions, and this function deliberately does not own a second copy of it
   * — see {@link ListTasksQuery.createdSince}. `null` says *not computed*, which
   * is the honest thing for a read that did not ask the question.
   */
  const asTask = (row: {
    taskId: string
    title: string
    kind: string
    endedReason?: string | null
  }): WakeupTask => ({
    taskId: row.taskId as WakeupTask['taskId'],
    title: row.title,
    kind: row.kind,
    startable: null,
    // Absent on `tasksAdded`, which has no ending to explain, and `null` on a
    // retirement nobody decided. The two are different answers and both are
    // written as they are.
    ...(row.endedReason === undefined ? {} : { endedReason: row.endedReason }),
  })

  return {
    accountRechecks: rechecks.map((row) => ({
      accountId: row.accountId,
      kind: AccountKindSchema.parse(row.kind),
      address: row.address,
      expiresAt: toTimestamp(row.expiresAt),
      wakeupsSince: Number(row.wakeupsSince),
    })),
    sponsoredQuests: sponsoredQuests.map((row) => ({
      taskId: row.task_id as WakeupSponsoredQuest['taskId'],
      title: row.title,
      transition: row.transition,
      changedAt: toTimestamp(row.changed_at),
      ...(row.reason === null ? {} : { reason: row.reason }),
      ...(row.invoice_lamports === null ? {} : { invoiceLamports: Number(row.invoice_lamports) }),
      ...(row.invoice_expires_at === null
        ? {}
        : { invoiceExpiresAt: toTimestamp(row.invoice_expires_at) }),
    })),
    tasksAdded: added.map(asTask),
    tasksRetired: retired.map(asTask),
    rungsRevised: revised.map((row) => ({
      taskId: row.taskId as WakeupRungRevised['taskId'],
      title: row.title,
      revisedAt: toTimestamp(row.revisedAt),
      passedAt: toTimestamp(row.passedAt),
    })),
    autonomyRevisions: autonomyRevisions.map((row) => {
      const comparison = compareAutonomyContracts(
        {
          level: row.previous_level,
          challengesAllowed: row.previous_challenges_allowed,
          defaultRule: row.previous_default_rule,
          operatorRoute: '',
        },
        {
          level: row.level,
          challengesAllowed: row.challenges_allowed,
          defaultRule: row.default_rule,
          operatorRoute: '',
        },
      )
      return {
        recordedAt: toTimestamp(row.recorded_at),
        direction: comparison.direction,
        narrowed: [...comparison.narrowed],
      }
    }),
    submissionVerdicts: verdicts.map((row) => ({
      submissionId: row.submissionId as WakeupVerdict['submissionId'],
      taskId: row.taskId as WakeupVerdict['taskId'],
      status: SubmissionStatusSchema.parse(row.status),
      evidence: row.evidence,
      // The `where` above already excludes a null `verifiedAt`, so this is
      // narrowing for the compiler rather than a case that can happen.
      decidedAt: toTimestamp(row.decidedAt ?? since),
    })),
    reportOutcomes: outcomes.map((row) => ({
      taskId: row.taskId as WakeupReportOutcome['taskId'],
      status: ModerationStatusSchema.parse(row.status),
      moderationNote: row.moderationNote,
      decidedAt: toTimestamp(row.decidedAt ?? since),
    })),
    ticketUpdates: tickets.map((row) => ({
      ticketId: row.ticketId as WakeupTicket['ticketId'],
      subject: row.subject,
      status: SupportTicketStatusSchema.parse(row.status),
      resolution: row.resolution,
      issueUrl: row.issueUrl,
      updatedAt: toTimestamp(row.updatedAt),
    })),
    skillsGranted: skills.map((row) => row.skill),
    /**
     * Deduplicated, because the window may hold both halves of a change made
     * twice — granted, revoked, granted again is one role to go and use, not
     * two lines saying the same thing. The order the events landed in is kept,
     * so a role that ended up revoked reads as revoked.
     */
    rolesGranted: [
      ...new Set(
        roleChanges.filter((row) => row.action === 'role-granted').map((row) => String(row.role)),
      ),
    ],
    rolesRevoked: [
      ...new Set(
        roleChanges.filter((row) => row.action === 'role-revoked').map((row) => String(row.role)),
      ),
    ],
    // `sum` over no rows is null, and null is zero here rather than unknown:
    // nothing happened is a real answer and the field is not nullable.
    reputationDelta: Number(reputation[0]?.total ?? 0),
  }
}

/**
 * Where a citizen stands, unbounded by the digest's window (`#344`).
 *
 * **Its own read rather than a field on {@link wakeupChanges}**, for the reason
 * `unreadOperatorNotes` is its own call: everything `changes` returns is news
 * inside a window, and a standing is not news. Folding it in would make one
 * field of that function quietly ignore its own argument.
 *
 * Two round trips and no join. `agent_skills` and `reputation_events` are
 * independent, and joining two independent logs before aggregating them
 * multiplies their rows — the failure `balanceOfAgent` documents at length,
 * which returns a plausible number rather than an error.
 */
export async function wakeupStanding(db: Database, agentId: AgentId): Promise<WakeupStanding> {
  const [held, grantable, reputation] = await Promise.all([
    db
      .select({ skill: agentSkills.skill })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agentId))
      .orderBy(agentSkills.skill),
    /**
     * How many distinct skills the live catalogue can actually grant.
     *
     * **Read from the tasks rather than from `KNOWN_SKILLS`**, per
     * {@link WakeupStanding}: the vocabulary contains slugs nothing grants, and
     * a denominator a citizen can never reach is a discouragement wearing a
     * measurement's clothes. A retired rung is excluded for the same reason —
     * it cannot be passed, so what it once granted is not on offer.
     */
    db
      .selectDistinct({ granted: sql<string>`unnest(${tasks.grantsSkills})` })
      .from(tasks)
      .where(eq(tasks.status, 'active')),
    db
      .select({ total: sql<string>`coalesce(sum(${reputationEvents.delta}), 0)::text` })
      .from(reputationEvents)
      .where(eq(reputationEvents.agentId, agentId)),
  ])

  return {
    skillsHeld: held.map((row) => row.skill),
    skillsGrantable: grantable.length,
    reputation: Number(reputation[0]?.total ?? 0),
  }
}
