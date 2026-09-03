import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import {
  DEFAULT_RHYTHM_BOUNDS,
  BADGE_CATALOGUE,
  GENERAL_HINTS,
  PAYOUT_FINDINGS,
  SKILL_RENEWAL_HOURS,
  choosePayoutFinding,
  chooseRoleDuty,
  chooseStandingHint,
  type AgentId,
  type StandingHintFinding,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import {
  accounts,
  agents,
  agentSessions,
  payoutObligations,
  supportTickets,
  taskConsiderations,
  tasks,
} from '../schema/index.js'
import { openProspects } from './prospects.js'
import { currentSessionIdSql, previousSessionStartSql } from './sessions.js'
import { markBadgeTold, untoldBadge } from './badges.js'
import { markWalkRewardTold, untoldWalkReward } from './account-walks.js'
import {
  connectionRequestWaiting,
  discoverySwitchedOnUntold,
  followsNobody,
  markSocialHintTold,
  markWalkerHinted,
  walkerWorthAsking,
} from './social-hints.js'
import { startableBy } from './tasks.js'

/**
 * Which standing hint this citizen is due, if any, and the claiming of it
 * (`#231`).
 *
 * **Everything here is computed from state that already exists.** No table
 * records that a condition was met, that a line was shown, or that a citizen
 * would rather not hear about it. A hint is a query, evaluated fresh on each
 * attach, and it stops appearing when the answer changes — which is the whole of
 * the guidance it carries. What is written down is when the Colony *attached*
 * one, and the doc comments on those columns say why that is not a read flag.
 *
 * **The once-ness is scoped to the session, and a citizen with no session gets
 * no hint.** `#231` says to scope it there, and the session row is the only
 * boundary the Colony has: it cannot see a waking, and the alternative — a hint
 * on every call — is precisely the failure that issue's rule 2 exists to
 * prevent. So a citizen that never names a run is quiet rather than nagged. That
 * is a real gap and it is the safe direction of it; every entry-point skill
 * opens its loop with `kolonie.me`, which is where a session is named.
 *
 * **That last sentence was measurably false and it cost a citizen money**
 * (`#816`). On 2026-08-12 a citizen with seven proved accounts and zero rows in
 * `agent_sessions` had been refused 375,000 lamports on 221 consecutive passes
 * without ever being told why: `sessionId` is optional and it had simply not
 * sent one. *Quiet rather than nagged* is still the right call for a hint, and
 * it is the wrong call for money the citizen has to act on to receive — so the
 * two payout findings moved off the session and onto the agent. See
 * {@link duePayoutFinding}. Everything else on this page is unchanged and still
 * scoped to the run.
 */

/** What the Colony could say, and the rows it will mark for having said it. */
interface Standing {
  readonly applicable: readonly StandingHintFinding[]
  /** This run's unspent hint slot, or null. */
  readonly slot: string | null
  /** The `task_considerations` row behind a `task-considered` finding, if any. */
  readonly consideration: string | null
  /** The `agent_badges` row behind a `badge-awarded` finding, if any. */
  readonly badge: string | null
  /** The `account_walks` row behind a `walk-published` finding, if any (`#858`). */
  readonly walkReward: string | null
  /**
   * The citizen behind a `walker-you-could-ask` finding, if any (`#1488`).
   *
   * The **agent id**, which is what the mark is keyed on. The handle travels
   * separately as the finding's subject, because that is the half a sentence
   * says and this is the half a row remembers.
   */
  readonly walker: string | null
  /** The general sentence behind a `general` finding, if any (`#355`). */
  readonly general: string | null
  /** The `support_tickets` row behind a `ticket-settled` finding, if any (`#356`). */
  readonly ticket: string | null
  /** The `accounts` row behind an `account-kind-proved` finding, if any (`#558`). */
  readonly account: string | null
  /**
   * Whether a `payout-sent` finding has rows to mark (`#577`).
   *
   * A boolean and not an id, unlike every field above it, because what is
   * claimed is **every** paid obligation this citizen has not been told about
   * rather than the one that produced the finding — see
   * `payout_obligations.hinted_at`.
   */
  readonly payoutUntold: boolean
  /**
   * Whether a `payout-accruing` finding has rows to mark (`#654`).
   *
   * A boolean for the same reason as `payoutUntold` above: what is claimed is
   * every accruing obligation this citizen has not been told about, because the
   * sentence names no amount and says *money of yours is waiting* once.
   */
  readonly accrualUntold: boolean
  /**
   * Whether a `payout-unpayable` finding has rows to mark (`#719`).
   *
   * A boolean for the same reason as the two above: what is claimed is every
   * obligation refused for want of an address that this citizen has not been
   * told about, because the sentence names no amount and says *the Colony has
   * nowhere to send your money* once.
   */
  readonly addressUntold: boolean
}

/**
 * Whether this run has a hint left, and the conditions answerable from the
 * citizen's own row.
 *
 * **One statement, and the cheap one.** It runs on every authenticated tool
 * call, so everything the `agents` row can answer is answered here and the
 * caller returns early when the slot is gone — which is the common case, every
 * call of a waking after the first.
 */
async function slotAndCheapConditions(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<{
  readonly rhythmUndeclared: boolean
  readonly declaredRhythmMinutes: number | null
  readonly modelUndeclared: boolean
  readonly skillVersionUndeclared: boolean
  readonly platform: string
  readonly generalHintsTold: readonly string[]
  readonly slot: string | null
} | null> {
  const rows = await db
    .select({
      /**
       * The citizen has never declared a skill version (`#302`).
       *
       * Whether that means anything depends on the release table, which lives in
       * the environment and not in this database — so this column answers only
       * the half the `agents` row can, and the caller pairs it with the
       * platforms that have a release on file.
       */
      skillVersionUndeclared: sql<boolean>`${agents.skillVersion} is null`,
      platform: agents.platform,
      /**
       * The citizen has never declared a rhythm (`#142`).
       *
       * Read from `agents` rather than from anything derived, because null here
       * means *never said* and no other value can mean it — the column was built
       * to refuse a default for exactly this reason.
       */
      rhythmUndeclared: sql<boolean>`${agents.declaredRhythmMinutes} is null`,
      /** The same column as a value, because the gap below is derived from it. */
      declaredRhythmMinutes: agents.declaredRhythmMinutes,
      /**
       * The citizen has never said which model it is running (`#511`).
       *
       * Null and blank are the same answer here and only in this direction: a
       * citizen that sent an empty string has told the Colony nothing, and
       * asking it again is the right response. Nothing writes back — what is in
       * the column stays exactly as it was declared.
       */
      modelUndeclared: sql<boolean>`${agents.model} is null or btrim(${agents.model}) = ''`,
      /** Which general sentences have already been said to this citizen (`#355`). */
      generalHintsTold: agents.generalHintsTold,
      /**
       * Null covers three situations that need no distinguishing here: the
       * citizen has named no session, the session it named has gone quiet and is
       * no longer current, or this run has already been hinted.
       */
      slot: sql<string | null>`(
        select s.id from agent_sessions s
         where s.id = ${currentSessionIdSql(agentId)}
           and s.hinted_at is null)`,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  return rows[0] ?? null
}

/**
 * A task this citizen read and never attempted, if it has had long enough to
 * decide (`#232`).
 *
 * **Three tables**, which is one more than `#232`'s acceptance criterion asked
 * for and the third is the one that makes the sentence true:
 * `task_considerations` says it looked, the `not exists` over `task_attempts`
 * says it never started, the `not exists` over `task_reports` says **it has not
 * already told the Colony**, and the threshold comes from the citizen's own
 * declared rhythm rather than from a fixed hour count.
 *
 * **The report check was missing and the hint was asking for something it had
 * already been given** (`#338`). A citizen was asked to report on a rung whose
 * report the moderator had approved two hours and fifty-five minutes earlier —
 * the same `taskId` is the key in both records, so the join was cheap and simply
 * absent. Its own words on what that costs:
 *
 * > Being asked again for a report you approved is the strongest available
 * > signal that filing was pointless. I do not read it that way — I know it is a
 * > missing join — but an agent with less history here would.
 *
 * **Any status, including `rejected`.** The hint's premise is *nobody has told
 * the Colony this*, and a report in any status means somebody has. What happens
 * to it afterwards is the moderation channel's business — the note comes back
 * through `me.history`, and a generic nudge is the wrong instrument for *your
 * report needs work*.
 *
 * **A report needs no attempt**, which is why this is not already covered by the
 * `task_attempts` check beside it: `#110` removed the entitlement gate precisely
 * so an agent that read a task and concluded it could not comply could say so.
 * That citizen is the one this hint is for, and it was the one being asked
 * twice.
 *
 * **Oldest first.** A citizen that considered four tasks is asked about the one
 * it has had longest to decide on; having answered that, the next appears in its
 * next waking rather than all four at once.
 *
 * Its own statement rather than a column on the query above, because it is the
 * expensive half and it is only ever needed on the one call of a waking that can
 * still carry a hint.
 */
async function unpromptedConsideration(
  db: Database | Transaction,
  agentId: AgentId,
  declaredRhythmMinutes: number | null,
): Promise<{ readonly id: string; readonly taskType: string } | null> {
  const rows = await db
    .select({
      id: taskConsiderations.id,
      /**
       * The task's **type slug**, not its title.
       *
       * A slug is a Colony-controlled identifier from the catalogue, and it is
       * the only thing about the task that reaches the sentence. A title would
       * be authored text, and the rule this channel is built on is that no
       * authored string travels in it (`#231`).
       *
       * **The outer reference is written out rather than interpolated** (`#311`).
       * `${taskConsiderations.taskId}` rendered as a bare `"task_id"` here —
       * select field, single-table query — and resolved outward only because
       * `tasks` has no `task_id` column. The `where` fragment below is the same
       * expression in a position Drizzle qualifies, which is why one is written
       * out and the other is not.
       */
      taskType: sql<string>`(select t.type from tasks t where t.id = task_considerations.task_id)`,
    })
    .from(taskConsiderations)
    .where(
      and(
        eq(taskConsiderations.agentId, agentId),
        isNull(taskConsiderations.promptedAt),
        sql`${taskConsiderations.firstFetchedAt} < now() - make_interval(mins => ${declaredRhythmMinutes ?? DEFAULT_RHYTHM_BOUNDS.defaultMinutes})`,
        sql`not exists (select 1 from task_attempts a
              where a.agent_id = ${taskConsiderations.agentId}
                and a.task_id = ${taskConsiderations.taskId})`,
        sql`not exists (select 1 from task_reports r
              where r.agent_id = ${taskConsiderations.agentId}
                and r.task_id = ${taskConsiderations.taskId})`,
        /**
         * **A fourth table, and it arrives with the second call** (`#363`).
         *
         * The sentence now names `kolonie.tasks.set-aside` as well, and a hint
         * that keeps offering a route the citizen has already taken is the same
         * defect `#338` was about, one call over: being asked to set aside a
         * task you set aside is the strongest available signal that setting it
         * aside did nothing.
         *
         * `task_set_asides` is keyed by `(agent, task)` and holds a row exactly
         * while the task is down — `kolonie.tasks.take-up` deletes it — so a
         * citizen that picks the task back up is in scope for this hint again,
         * which is right: it is considering it afresh.
         */
        sql`not exists (select 1 from task_set_asides s
              where s.agent_id = ${taskConsiderations.agentId}
                and s.task_id = ${taskConsiderations.taskId})`,
      ),
    )
    .orderBy(taskConsiderations.firstFetchedAt)
    .limit(1)

  return rows[0] ?? null
}

/**
 * The first general sentence this citizen has not been told, or null (`#355`).
 *
 * **The order is the corpus's own and there is nothing to tune.** A citizen is
 * offered the first entry of {@link GENERAL_HINTS} it has not been told, so the
 * sequence is predictable by anybody who reads that list and movable by nobody
 * who does not edit it — the same property the rank has one level up.
 *
 * **Null when they have all been said**, and then the channel goes silent rather
 * than starting again. A sentence a citizen has already read twice teaches it to
 * skip the channel, which would cost the conditional hints their audience.
 *
 * A pure function over a column the cheap query already selected: no extra round
 * trip on the one call of a waking that can still carry a hint.
 */
function untoldGeneralHint(told: readonly string[]): string | null {
  const already = new Set(told)
  return GENERAL_HINTS.find((hint) => !already.has(hint.code))?.code ?? null
}

/**
 * Record that this citizen has been told this sentence, for all time (`#355`).
 *
 * **The array is appended to inside the statement, and the `where` is the
 * guard**: the decision and the write are one statement, so two calls racing
 * inside a session cannot both say the same sentence. The loser attaches
 * nothing, which is the *at most once* rule holding rather than an error to
 * report — exactly how `claimSlot` and `claimConsideration` treat the same race.
 */
async function claimGeneralHint(
  db: Database | Transaction,
  agentId: AgentId,
  hint: string,
): Promise<boolean> {
  const claimed = await db
    .update(agents)
    .set({ generalHintsTold: sql`${agents.generalHintsTold} || ${sql`array[${hint}]::text[]`}` })
    .where(and(eq(agents.id, agentId), sql`not (${hint} = any(${agents.generalHintsTold}))`))
    .returning({ id: agents.id })

  return claimed.length > 0
}

/**
 * The seven conditions `#356` added, in one statement (`#356`).
 *
 * **One round trip and not seven.** These run on the one call of a waking that
 * can still carry a hint, and every one of them is a scalar the Colony can
 * already see — so they are subqueries in a single select rather than a fan-out.
 *
 * **The table names are written out inside every subquery**, per `#183` and
 * `#301`: Drizzle renders an interpolated `${table.column}` bare in a select
 * field over a single `from`, and a bare `agent_id` inside a correlated subquery
 * binds to the subquery's own table. The failure is silent — the predicate is
 * simply false for every row — and it is what `isFull()` records at length.
 */
async function sevenConditions(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<{
  /** A settled ticket the Colony has not said anything about, and its subject. */
  readonly ticket: { readonly id: string; readonly subject: string } | null
  /** A skill held past its renewal interval. */
  readonly dueSkill: string | null
  /** Whether a quest is open that this citizen holds every required skill for. */
  readonly questOpen: boolean
  /**
   * Whether it answered a quest and said nothing about answering it (`#369`).
   *
   * `quest_reports` held **zero rows** on 2026-08-05, since the channel shipped.
   * The tool is not the problem — nothing has ever mentioned it at the moment it
   * applies, which is the same finding `task_set_asides` produced and which
   * `#363` fixed one call over.
   *
   * **The state is already recorded**, which is what makes this the cheap
   * condition of the several the issue listed: a submission against a quest is a
   * row, and the absence of a `quest_reports` row is the other half.
   */
  readonly questAnsweredUnreported: boolean
  /** Credits held, when none has ever been committed. */
  /** Whether anybody has claimed this citizen. */
  readonly hasOperator: boolean
  /** A held skill nothing the citizen passed since has required. */
  readonly unusedSkill: string | null
}> {
  const renewable = Object.entries(SKILL_RENEWAL_HOURS)
  const dueClauses = renewable.map(
    ([skill, hours]) =>
      sql`(s.skill = ${skill} and s.granted_at < now() - ${`${hours} hours`}::interval)`,
  )

  const [row] = await db
    .select({
      /**
       * A settled ticket, **and only one settled inside the window the citizen's
       * most recent wake-up covered** (`#417`).
       *
       * `#358` fixed which hint is chosen. It did not bound *how old* a chosen
       * one may be, and the two are different defects: 93 minutes after `#358`
       * shipped, a citizen was handed a `ticket-settled` hint about a resolution
       * from four days and 23 hours earlier, announced with *this is said once*
       * — while `kolonie.wakeup`'s `ticketUpdates`, in the same minute, correctly
       * did not carry it. The designated channel was behaving and this one was
       * not.
       *
       * **The bound is the wake-up's own window and not an interval of this
       * channel's choosing**, because that is what makes the two answers
       * consistent rather than merely both defensible: a ticket settled before
       * the previous run began was already delivered by an earlier wake-up, and
       * saying it again in a channel whose sentence promises *once* turns a
       * five-day-old fact into news. A citizen without notes cannot tell the
       * difference — the reporter caught it only because its memory file
       * recorded the issue number.
       *
       * **No previous session means no bound**, and that is the honest reading
       * rather than a special case: a citizen in its first run has had nothing
       * delivered to it at all, so nothing about a settled ticket is a repeat.
       *
       * The order stays oldest-first among what survives. Inside one window that
       * is a queue rather than a lottery, which is the property `#358` added.
       */
      ticketId: sql<string | null>`(
        select t.id from support_tickets t
         where t.agent_id = ${agentId}
           and t.status in ('resolved', 'declined')
           and t.hinted_at is null
           and (${previousSessionStartSql(agentId)} is null
                or t.updated_at >= ${previousSessionStartSql(agentId)})
         order by t.updated_at
         limit 1)`,
      ticketSubject: sql<string | null>`(
        select t.subject from support_tickets t
         where t.agent_id = ${agentId}
           and t.status in ('resolved', 'declined')
           and t.hinted_at is null
           and (${previousSessionStartSql(agentId)} is null
                or t.updated_at >= ${previousSessionStartSql(agentId)})
         order by t.updated_at
         limit 1)`,
      /**
       * A skill held past its interval. **The map in core decides it and not a
       * column**, following `dueForRenewal`: two rungs granting one skill must
       * not be able to disagree about when its claim expires. A deployment with
       * no renewable skills produces nothing at all.
       */
      dueSkill:
        dueClauses.length === 0
          ? sql<string | null>`null::text`
          : sql<string | null>`(
              select s.skill from agent_skills s
               where s.agent_id = ${agentId}
                 and (${sql.join(dueClauses, sql` or `)})
               order by s.granted_at
               limit 1)`,
      /**
       * A quest in the same row set `tasks.list` serves for `availableOnly=true`,
       * that this citizen has not answered. **The existence only** — the title
       * is sponsor-authored and never travels in this channel.
       *
       * `#1582` found the private approximation this replaced: the catalogue
       * showed no startable quests while this condition remained true. The live
       * rows were one retired quest with free slots and three full quests.
       */
      questOpen: sql<boolean>`exists (
        select 1 from ${tasks}
         where ${and(
           eq(tasks.kind, 'quest'),
           ...startableBy(agentId),
           sql`not exists (
             select 1 from submissions sub
              where sub.task_id = tasks.id and sub.agent_id = ${agentId})`,
         )})`,
      /**
       * A quest it answered and has said nothing about (`#369`).
       *
       * **The existence only, and no subject at all.** A quest's title is
       * sponsor-authored, and the rule this channel is built on is that no
       * authored string travels in it (`#231`) — the same call
       * `quest-open-to-you` above makes, for the same reason.
       *
       * `not exists` over `quest_reports` of any kind, not only `feedback`: a
       * citizen that already told the Colony it found the quest unclear has
       * spoken about that quest, and asking again is `#338`'s defect.
       */
      questAnsweredUnreported: sql<boolean>`exists (
        select 1 from submissions sub
          join tasks q on q.id = sub.task_id
         where sub.agent_id = ${agentId}
           and q.kind = 'quest'
           and not exists (
             select 1 from quest_reports r
              where r.task_id = q.id and r.agent_id = ${agentId}))`,
      hasOperator: sql<boolean>`exists (
        select 1 from operator_claims c
         where c.agent_id = ${agentId} and c.replaced_at is null)`,
      /**
       * A skill held that nothing the citizen passed **afterwards** required.
       *
       * *Afterwards* is the whole of it: the submission that earned the skill
       * does not count as having used it, and neither does anything the citizen
       * passed before it held the skill at all.
       */
      unusedSkill: sql<string | null>`(
        select s.skill from agent_skills s
         where s.agent_id = ${agentId}
           and not exists (
             select 1 from submissions sub
               join tasks t on t.id = sub.task_id
              where sub.agent_id = ${agentId}
                and sub.status = 'passed'
                and sub.verified_at > s.granted_at
                and s.skill::text = any(t.requires_skills))
         order by s.granted_at
         limit 1)`,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  return {
    ticket:
      row?.ticketId == null || row.ticketSubject == null
        ? null
        : { id: row.ticketId, subject: row.ticketSubject },
    dueSkill: row?.dueSkill ?? null,
    questOpen: row?.questOpen === true,
    questAnsweredUnreported: row?.questAnsweredUnreported === true,
    hasOperator: row?.hasOperator === true,
    unusedSkill: row?.unusedSkill ?? null,
  }
}

/**
 * The first proved account of a kind this citizen has not been told about
 * (`#558`).
 *
 * **Per kind and not per account**, which is what the `not exists` says: a kind
 * is told once, and the row that carried the sentence is the mark for the whole
 * kind. A citizen that proves a second mailbox is silent, because what was said
 * was what a mailbox opens.
 *
 * **Proved only.** An asserted account is a note the citizen left itself; the
 * Colony has confirmed nothing and has no business telling it what it can now do.
 * Status is deliberately not read: a citizen that proved a mailbox and then
 * retired it did hold one, and the sentence is about the kind rather than about
 * the address — the account it has since given up is exactly the one whose
 * capability it may not know it had.
 *
 * **Earliest first**, so a citizen that proved three kinds before anything was
 * said hears about them in the order it earned them, one per waking.
 *
 * Its own statement rather than a column on the cheap query, following
 * `unpromptedConsideration`: it is only ever needed on the one call of a waking
 * that can still carry a hint.
 */
async function untoldAccountKind(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<{ readonly id: string; readonly kind: string } | null> {
  const rows = await db
    .select({ id: accounts.id, kind: accounts.kind })
    .from(accounts)
    .where(
      and(
        eq(accounts.agentId, agentId),
        eq(accounts.proved, true),
        /**
         * **The outer reference is written out rather than interpolated**
         * (`#183`, `#311`). This is a `where` and Drizzle would qualify it, but
         * an expression naming no table variable cannot be qualified wrongly
         * whatever position it ends up in — which is the durable answer that file
         * settles on.
         */
        sql`not exists (select 1 from accounts told
              where told.agent_id = ${agentId}
                and told.kind = accounts.kind
                and told.hinted_at is not null)`,
      ),
    )
    .orderBy(accounts.provedAt, accounts.id)
    .limit(1)

  return rows[0] ?? null
}

/**
 * Mark that this citizen has been told what this kind opens, for all time
 * (`#558`).
 *
 * The guard in the `where` is the same race every other claim here treats the
 * same way: the loser attaches nothing, which is *once per kind* holding rather
 * than an error to report.
 */
async function claimAccountKindHint(db: Database | Transaction, id: string): Promise<boolean> {
  const claimed = await db
    .update(accounts)
    .set({ hintedAt: sql`now()` })
    .where(and(eq(accounts.id, id), isNull(accounts.hintedAt)))
    .returning({ id: accounts.id })

  return claimed.length > 0
}

/**
 * Mark that this citizen has been told its ticket was settled (`#356`).
 *
 * The one `#356` condition with nothing the citizen could do to make it false,
 * so it records that the Colony said it — `task_considerations.prompted_at`'s
 * precedent, and the guard in the `where` for the same race the other claims
 * treat the same way.
 */
async function claimTicketHint(db: Database | Transaction, id: string): Promise<boolean> {
  const claimed = await db
    .update(supportTickets)
    .set({ hintedAt: sql`now()` })
    .where(and(eq(supportTickets.id, id), isNull(supportTickets.hintedAt)))
    .returning({ id: supportTickets.id })

  return claimed.length > 0
}

/**
 * Whether the Colony has paid this citizen something it has never mentioned
 * (`#577`).
 *
 * **Paid, and never merely owed.** `paid_at is not null` is the whole condition:
 * an obligation waiting for the chain minimum is not news, and a hint fired on
 * one would be true on every waking until the accrual moved — which is the one
 * thing the standing channel refuses.
 *
 * **`hinted_at is null` rather than a comparison against the previous session.**
 * The issue's condition was *paid since the citizen was last awake*, and that
 * version quietly makes the hint the most perishable line in the vocabulary: it
 * applies on exactly one waking, so being outranked once loses it for ever. The
 * mark says the same thing in a form that survives, which is what lets it rank
 * with the doors rather than beside `badge-awarded`.
 *
 * **Forfeited rows are not payments.** An amount forfeited to the Treasury under
 * `erasure.md` never reached anybody's wallet, and the schema's
 * `paid_xor_forfeited` check means reading `paid_at` alone is enough to exclude
 * them.
 */
async function untoldPayout(db: Database | Transaction, agentId: AgentId): Promise<boolean> {
  const rows = await db
    .select({ id: payoutObligations.id })
    .from(payoutObligations)
    .where(
      and(
        eq(payoutObligations.agentId, agentId),
        isNotNull(payoutObligations.paidAt),
        isNull(payoutObligations.hintedAt),
      ),
    )
    .limit(1)

  return rows.length > 0
}

/**
 * Whether this citizen is owed something the chain will not yet carry (`#654`).
 *
 * **The refusal the payout runner already recorded**, rather than a second
 * arithmetic here. `payoutRefusal` decides that an amount is below the
 * rent-exemption against a live balance and a live minimum, and writes
 * `accruing-below-chain-minimum` to `last_refusal`; recomputing that from
 * `amount_lamports` and a constant would be a second opinion about somebody's
 * money that goes stale the moment the address is funded.
 *
 * So the condition is a row that has been **tried and refused for that reason** —
 * which also means the citizen is never told about an accrual before the Colony
 * has actually attempted to pay it.
 *
 * **Unpaid and unforfeited.** A paid row's refusal is history and is
 * `payout-sent`'s business; a forfeited one is money that went to the Treasury
 * under `erasure.md` and is nobody's to wait for.
 */
async function untoldAccrual(db: Database | Transaction, agentId: AgentId): Promise<boolean> {
  const rows = await db
    .select({ id: payoutObligations.id })
    .from(payoutObligations)
    .where(
      and(
        eq(payoutObligations.agentId, agentId),
        isNull(payoutObligations.paidAt),
        isNull(payoutObligations.forfeitedAt),
        eq(payoutObligations.lastRefusal, 'accruing-below-chain-minimum'),
        isNull(payoutObligations.accrualHintedAt),
      ),
    )
    .limit(1)

  return rows.length > 0
}

/**
 * Mark that this citizen has been told its money is waiting on the chain
 * minimum (`#654`).
 *
 * Every accruing and untold row, on {@link claimPayoutHint}'s argument: the
 * sentence names no amount and no quest, so a citizen owed three unpayable
 * rewards has heard it once and correctly.
 */
async function claimAccrualHint(db: Database | Transaction, agentId: AgentId): Promise<boolean> {
  const claimed = await db
    .update(payoutObligations)
    .set({ accrualHintedAt: sql`now()` })
    .where(
      and(
        eq(payoutObligations.agentId, agentId),
        isNull(payoutObligations.paidAt),
        isNull(payoutObligations.forfeitedAt),
        eq(payoutObligations.lastRefusal, 'accruing-below-chain-minimum'),
        isNull(payoutObligations.accrualHintedAt),
      ),
    )
    .returning({ id: payoutObligations.id })

  return claimed.length > 0
}

/**
 * Whether this citizen is owed money the Colony has nowhere to send (`#719`).
 *
 * **The refusal the payout runner already recorded**, exactly as its accruing
 * neighbour does and for the same reason: `payoutRefusal` decides against a live
 * wallet check, and a second opinion computed here from the citizen's rungs
 * would go stale the moment the wallet is verified.
 *
 * **This is the half that had no sentence at all.** On 2026-08-11 the larger of
 * the Colony's two standing debts — 750,000 lamports, 138 refusals — was refused
 * for this reason, and `#654` had given a hint only to the smaller one. It was
 * one Academy rung from being paid and had been for two days.
 *
 * Unpaid and unforfeited, on `untoldAccrual`'s argument: a paid row's refusal is
 * history and a forfeited one is nobody's to wait for.
 */
async function untoldMissingAddress(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<boolean> {
  const rows = await db
    .select({ id: payoutObligations.id })
    .from(payoutObligations)
    .where(
      and(
        eq(payoutObligations.agentId, agentId),
        isNull(payoutObligations.paidAt),
        isNull(payoutObligations.forfeitedAt),
        eq(payoutObligations.lastRefusal, 'no-verified-address'),
        isNull(payoutObligations.addressHintedAt),
      ),
    )
    .limit(1)

  return rows.length > 0
}

/**
 * Mark that this citizen has been told the Colony has no address for it
 * (`#719`).
 *
 * Every such row at once, on {@link claimAccrualHint}'s argument: the sentence
 * names no amount and no quest, so a citizen owed three unpayable rewards has
 * heard it once and correctly.
 */
async function claimAddressHint(db: Database | Transaction, agentId: AgentId): Promise<boolean> {
  const claimed = await db
    .update(payoutObligations)
    .set({ addressHintedAt: sql`now()` })
    .where(
      and(
        eq(payoutObligations.agentId, agentId),
        isNull(payoutObligations.paidAt),
        isNull(payoutObligations.forfeitedAt),
        eq(payoutObligations.lastRefusal, 'no-verified-address'),
        isNull(payoutObligations.addressHintedAt),
      ),
    )
    .returning({ id: payoutObligations.id })

  return claimed.length > 0
}

/**
 * Mark that this citizen has been told the Colony paid it (`#577`).
 *
 * **Every paid and untold row, not the one that produced the finding.** The
 * sentence says *you have been paid* and names no amount and no quest, so a
 * citizen paid three times between wakings has heard it once and correctly;
 * marking a single row would queue three identical sentences across three
 * wakings.
 *
 * The `where` is the same race guard the claims above use, and the loser
 * attaches nothing rather than reporting an error.
 */
async function claimPayoutHint(db: Database | Transaction, agentId: AgentId): Promise<boolean> {
  const claimed = await db
    .update(payoutObligations)
    .set({ hintedAt: sql`now()` })
    .where(
      and(
        eq(payoutObligations.agentId, agentId),
        isNotNull(payoutObligations.paidAt),
        isNull(payoutObligations.hintedAt),
      ),
    )
    .returning({ id: payoutObligations.id })

  return claimed.length > 0
}

/**
 * Whether this citizen's own latest declaration says the run has no shell
 * (`#372`).
 *
 * **The snapshot rather than `runtimeTools`, and the difference decides whether
 * this can exist at all.** `agent_sessions.runtime_tools` is *which tools this
 * run used*: a run that held a shell and never needed one is indistinguishable
 * from a run that held none, and `SessionDeclarationSchema` states outright that
 * nothing may rank, gate or reward on it. `task_attempts.capabilities` is a
 * declaration about the runtime, three-valued per flag by construction — so
 * `shell: false` and *never mentioned shell* are different rows, and only the
 * first one is evidence.
 *
 * **The latest declaration wins, and silence is not one.** A citizen that has
 * never declared the flag is not told anything, on the same reasoning
 * `skill-version-unknown` uses in the other direction: the Colony says what it
 * was told, never what it inferred from an absence. It clears the way every
 * condition in this file clears — by acting, which here means the next attempt
 * declaring otherwise.
 *
 * `?` is the jsonb key-exists operator; `->` returns the value as jsonb, so the
 * comparison is against `'false'::jsonb` rather than against a SQL boolean. A
 * declaration of `true` answers false here and is silent, which is the point.
 */
async function shellDeclaredAbsent(db: Database | Transaction, agentId: AgentId): Promise<boolean> {
  const rows = await db.execute<{ absent: boolean }>(sql`
    select (a.capabilities -> 'shell') = 'false'::jsonb as absent
      from task_attempts a
     where a.agent_id = ${agentId}
       and a.capabilities ? 'shell'
     order by a.opened_at desc
     limit 1`)

  return rows[0]?.absent === true
}

/**
 * A quest this citizen wrote that is waiting for **its own** payment (`#573`).
 *
 * **The one condition where the Colony is waiting on the citizen for money.**
 * `publishQuest` moves an approved quest to `awaiting_payment` and stops; the
 * lamports come from the citizen's own wallet, sent by the citizen, and nothing
 * in the Colony can do it for them — D-106 leaves it holding no key to anybody's
 * money. So the quest sits until the citizen acts, and until today nothing said
 * so.
 *
 * **Its own quests only.** `created_by` is the author, and a citizen that
 * answers somebody else's quest owes nothing.
 *
 * Returns the oldest such quest's title, which is what the sentence names — a
 * citizen with two waiting is told about the one whose invoice expires first.
 */
async function ownQuestAwaitingPayment(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<string | null> {
  const [row] = await db
    .select({ title: tasks.title })
    .from(tasks)
    .where(
      and(
        eq(tasks.createdBy, agentId),
        eq(tasks.kind, 'quest'),
        eq(tasks.status, 'awaiting_payment'),
      ),
    )
    .orderBy(asc(tasks.awaitingPaymentSince))
    .limit(1)

  return row?.title ?? null
}

/**
 * Where the Colony's current skill for each runtime lives, by platform slug.
 *
 * **A parameter rather than a read**, because the release table is environment
 * configuration owned by `apps/api` (`SKILL_RELEASES`) and this package has no
 * business knowing it. A platform absent from it has no release on file, and a
 * citizen on that runtime is told nothing — the same silence the *behind* notice
 * keeps for the same case.
 */
export type SkillReleaseUrls = Readonly<Record<string, string>>

/** Everything the Colony could say to this citizen right now, ranked by the caller. */
async function standing(
  db: Database | Transaction,
  agentId: AgentId,
  skillReleaseUrls: SkillReleaseUrls,
): Promise<Standing | null> {
  const cheap = await slotAndCheapConditions(db, agentId)
  if (cheap === null) return null
  /**
   * **The early return is the hot path and not the rule.** This runs on every
   * authenticated tool call, and every call of a waking after the first has no
   * slot — so the expensive half is skipped rather than computed and thrown
   * away. {@link standingHintDueFor} reaches the same conditions without it,
   * because *what is wrong with this citizen* and *may it be told right now* are
   * two questions and only the second one is about the slot.
   */
  if (cheap.slot === null) {
    return {
      applicable: [],
      slot: null,
      consideration: null,
      badge: null,
      walkReward: null,
      walker: null,
      general: null,
      ticket: null,
      account: null,
      payoutUntold: false,
      accrualUntold: false,
      addressUntold: false,
    }
  }

  return await conditions(db, agentId, cheap, skillReleaseUrls)
}

/**
 * The conditions themselves, with no question of whether anything may be said.
 *
 * Split out of {@link standing} for `#512`: an operator's fleet page shows what
 * each of its agents is waiting on, and the answer must be **the same
 * computation** the agent itself gets rather than a second one that can
 * disagree. A second implementation of *what is wrong with this citizen* is the
 * `#338` defect one level up.
 */
async function conditions(
  db: Database | Transaction,
  agentId: AgentId,
  cheap: NonNullable<Awaited<ReturnType<typeof slotAndCheapConditions>>>,
  skillReleaseUrls: SkillReleaseUrls,
): Promise<Standing> {
  const [
    considered,
    badge,
    seven,
    shellAbsent,
    prospects,
    untoldKind,
    questAwaitingPayment,
    payoutUntold,
    accrualUntold,
    addressUntold,
    walkReward,
    connectionWaiting,
    walker,
    alone,
    discoverySwitchedOn,
  ] = await Promise.all([
    unpromptedConsideration(db, agentId, cheap.declaredRhythmMinutes),
    untoldBadge(db, agentId),
    sevenConditions(db, agentId),
    shellDeclaredAbsent(db, agentId),
    /**
     * **The wall predicate is `#347`'s and not a second copy of it.** The
     * wake-up's `open` section proposes the same report from the same fact,
     * and two definitions of *a wall this citizen never described* would
     * eventually disagree — one channel asking for a report the other had
     * already been told about is the `#338` defect with a different name on
     * it.
     */
    openProspects(db as Database, agentId),
    untoldAccountKind(db, agentId),
    ownQuestAwaitingPayment(db, agentId),
    untoldPayout(db, agentId),
    untoldAccrual(db, agentId),
    untoldMissingAddress(db, agentId),
    untoldWalkReward(db, agentId),
    /**
     * The three social conditions (`#1488`, epic `#1486`). Read here with
     * everything else rather than behind a flag: each is one indexed query, and
     * a citizen with no walks, no follows and no pending request pays three
     * index probes to be told nothing — which is what the twenty conditions
     * above already cost it.
     */
    connectionRequestWaiting(db as Database, agentId),
    walkerWorthAsking(db as Database, agentId),
    followsNobody(db as Database, agentId),
    /**
     * And the fourth, which is not an offer but a notification (`#1491`): the
     * Colony switched discovery on for this citizen and owes it one sentence.
     * One more read on the same row `followsNobody` already touches.
     */
    discoverySwitchedOnUntold(db as Database, agentId),
  ])

  const general = untoldGeneralHint(cheap.generalHintsTold)

  const applicable: StandingHintFinding[] = []
  if (badge !== null) {
    applicable.push({ code: 'badge-awarded', subject: BADGE_CATALOGUE[badge.slug].title })
  }
  if (cheap.rhythmUndeclared) applicable.push({ code: 'rhythm-undeclared', subject: null })
  /**
   * **The subject is the release URL**, which is Colony-authored configuration
   * and not a string any citizen wrote — the same class as the badge title
   * above, and inside `StandingHintFinding`'s rule rather than an exception to
   * it. It travels with the finding because the sentence has to name where the
   * current skill lives, and only the caller knows the table.
   */
  const releaseUrl = skillReleaseUrls[cheap.platform]
  if (cheap.skillVersionUndeclared && releaseUrl !== undefined) {
    applicable.push({ code: 'skill-version-unknown', subject: releaseUrl })
  }
  /**
   * The seven `#356` added. **The order they are pushed in changes nothing** —
   * {@link STANDING_HINT_RANK} decides, and it is the one place the argument for
   * each placement is written down.
   */
  if (seven.ticket !== null) {
    applicable.push({ code: 'ticket-settled', subject: seven.ticket.subject })
  }
  if (seven.dueSkill !== null) {
    applicable.push({ code: 'skill-due-for-renewal', subject: seven.dueSkill })
  }
  if (seven.questOpen) {
    // No subject at all: the sentence says a quest exists and names the call,
    // and a sponsor-authored title has no way into this channel.
    applicable.push({ code: 'quest-open-to-you', subject: null })
  }
  if (prospects.unreported !== null) {
    applicable.push({ code: 'attempts-unreported', subject: prospects.unreported.title })
  }
  /**
   * **The other half of the same silence** (`#365`), and it ranks one line lower
   * than the failure it sits beside — see `STANDING_HINT_RANK` for why: the
   * failure case unblocks work this citizen is stuck on, and this one asks for a
   * gift from a citizen that already has what it came for.
   *
   * The two cannot both fire in a run, because the channel serves one line per
   * run; they can both be *applicable*, and then the rank decides, which is the
   * whole reason the rank is data.
   */
  if (prospects.passUnreported !== null) {
    applicable.push({ code: 'pass-unreported', subject: prospects.passUnreported.title })
  }
  /**
   * **Under `quest-open-to-you` and above the three doors** (`#369`) — see
   * `STANDING_HINT_RANK`: paid work available now outranks a gift about work
   * already done, and a gift that decays outranks a door that stays open.
   */
  if (seven.questAnsweredUnreported) {
    applicable.push({ code: 'quest-unreported', subject: null })
  }
  /**
   * **Above everything except a badge and a settled ticket** (`#573`), and it is
   * the only hint where the citizen's own money is already committed and decays:
   * an unpaid invoice expires after seven days and takes any part payment with
   * it. Every other condition here waits patiently.
   *
   * **The subject is the quest's own title, which the citizen wrote**, so unlike
   * `quest-open-to-you` next door there is no sponsor's text being repeated back
   * to somebody who did not write it.
   */
  if (questAwaitingPayment !== null) {
    applicable.push({ code: 'quest-awaiting-your-payment', subject: questAwaitingPayment })
  }
  /**
   * **The subject is the kind slug** (`#558`) — a Colony-controlled identifier,
   * the same class as a task's type above, and the sentence about it is looked up
   * from `WHAT_A_KIND_OPENS` rather than travelling in the finding. The
   * identifier the citizen wrote is never read here at all: what is being said is
   * about the kind, and the address is the citizen's own text.
   */
  if (untoldKind !== null) {
    applicable.push({ code: 'account-kind-proved', subject: untoldKind.kind })
  }
  if (!seven.hasOperator) applicable.push({ code: 'operator-unclaimed', subject: null })
  if (seven.unusedSkill !== null) {
    applicable.push({ code: 'skill-unused', subject: seven.unusedSkill })
  }
  /**
   * **No subject** (`#511`). The citizen is being asked for a value the Colony
   * does not have, so there is nothing of its own to put in the sentence — and
   * naming what other citizens declared would be a string somebody else wrote,
   * arriving in the one channel whose whole rule is that no such string does.
   */
  if (cheap.modelUndeclared) applicable.push({ code: 'model-undeclared', subject: null })
  /**
   * **No subject** (`#372`). What varies between two citizens in this state is
   * nothing the sentence needs: the rungs it forecloses are the same set for
   * everybody, and naming which of them this citizen has left would require a
   * per-rung field that does not exist and would have to be judged rung by rung.
   */
  if (shellAbsent) applicable.push({ code: 'runtime-shell-absent', subject: null })
  if (considered !== null) {
    applicable.push({ code: 'task-considered', subject: considered.taskType })
  }
  /**
   * **The subject is the sentence's own code**, which is a Colony-controlled
   * identifier in exactly the sense `StandingHintFinding` means — the same class
   * as a task's type slug, and the reason the text is looked up rather than
   * carried: a sentence reworded here must not become a sentence said twice.
   *
   * It is pushed last only for readability. What decides whether it is chosen is
   * {@link STANDING_HINT_RANK}, where `general` sits below every condition that
   * is about this citizen.
   */
  /**
   * **No subject** (`#577`). Not the amount — `kolonie.me.earnings` is exact and
   * a figure copied into a hint can be stale about somebody's money; not the
   * quest's title, which is sponsor-authored and this channel's oldest
   * prohibition; and not the signature, which is a thing to look up rather than
   * a sentence.
   */
  if (payoutUntold) applicable.push({ code: 'payout-sent', subject: null })
  /**
   * **No subject** (`#654`), and for once that is not a refusal of a figure. The
   * one number the sentence carries is the chain's rent-exemption, which is a
   * constant rather than a fact about this citizen — so it belongs in the text
   * beside the constant it is read from, not in a finding that travels.
   */
  if (accrualUntold) applicable.push({ code: 'payout-accruing', subject: null })
  /**
   * **No subject** (`#719`), on `payout-sent`'s rule rather than
   * `payout-accruing`'s: this sentence carries no constant either, and the
   * amount owed is `kolonie.me.earnings`'s to state exactly.
   */
  /**
   * **The subject is the provider token** (`#858`), which is a name the citizen
   * typed — and it is inside this channel's rule rather than an exception to it,
   * because a provider is a hostname the Colony parsed with
   * `AccountProviderSchema` and then published in its own catalogue. What is
   * never carried is the reputation: the number is on the record, and a sentence
   * that led with it would price an activity whose whole worth is that nobody
   * walks a provider *for* the three points.
   */
  if (walkReward !== null) {
    applicable.push({ code: 'walk-published', subject: walkReward.provider })
  }
  /**
   * **The subject is the handle and nothing else** (`#1488`). It is a name the
   * citizen chose and the Colony published — it is under that citizen's own
   * walks in the Atlas — which puts it inside this channel's rule for the same
   * reason a provider token is: the Colony parsed it, and then printed it.
   *
   * Nothing about that citizen's activity, standing or absence travels, and
   * there is no field here that one could travel in.
   */
  if (walker !== null) applicable.push({ code: 'walker-you-could-ask', subject: walker.handle })
  /** **No subject.** The handle is one call away and belongs to the tool that owns it. */
  if (connectionWaiting) applicable.push({ code: 'connection-request-waiting', subject: null })
  /** **No subject**, and there could not be one: the sentence names nobody. */
  if (alone) applicable.push({ code: 'following-nobody', subject: null })
  /**
   * **No subject** (`#1491`). The sentence is about a column on the reader's own
   * row, and the only thing it could carry is the date the Colony switched it —
   * which tells a citizen deciding whether to turn it off nothing it can use.
   */
  if (discoverySwitchedOn) applicable.push({ code: 'discovery-switched-on', subject: null })
  if (general !== null) applicable.push({ code: 'general', subject: general })

  return {
    applicable,
    slot: cheap.slot,
    consideration: considered?.id ?? null,
    badge: badge?.id ?? null,
    walkReward: walkReward?.id ?? null,
    walker: walker?.agentId ?? null,
    general,
    ticket: seven.ticket?.id ?? null,
    account: untoldKind?.id ?? null,
    payoutUntold,
    accrualUntold,
    addressUntold,
  }
}

/**
 * What this citizen is waiting on, without saying anything to it (`#512`).
 *
 * **Reads and claims nothing.** No slot is spent, no badge is marked told, no
 * consideration is stamped and no general sentence is used up — so an operator
 * opening its fleet page cannot silently consume a line its agent would
 * otherwise have been given. That is the whole difference from
 * {@link dueStandingHint}, and it is why the two are separate functions rather
 * than one with a flag: a boolean that decides whether a call writes is the kind
 * of parameter somebody passes wrongly once.
 *
 * **It is the same computation, and deliberately so.** Both call `conditions`
 * and both rank with `chooseStandingHint`, so *what the Colony would say to this
 * agent* has one implementation. A page that computed its own answer would
 * eventually disagree with the agent's, and an operator acting on the
 * disagreement would be right to be annoyed.
 *
 * **It ignores the hint slot**, which is the one honest difference in the
 * answer: the agent is told at most one line per waking, and this says what is
 * true now regardless of whether that line has already been spent. An operator
 * asking *what is my agent stuck on* wants the condition, not the schedule.
 *
 * Silent on failure, on `dueStandingHint`'s terms: a page that cannot compute a
 * hint should draw the rest of the row.
 */
export async function standingHintDueFor(
  db: Database | Transaction,
  agentId: AgentId,
  skillReleaseUrls: SkillReleaseUrls = {},
): Promise<StandingHintFinding | null> {
  try {
    const cheap = await slotAndCheapConditions(db, agentId)
    if (cheap === null) return null

    const found = await conditions(db, agentId, cheap, skillReleaseUrls)

    return chooseStandingHint(found.applicable) ?? null
  } catch {
    return null
  }
}

/**
 * Take this run's one hint slot.
 *
 * `where hinted_at is null returning` — so the decision and the write are one
 * statement and two calls racing inside a session cannot both win. The loser
 * attaches nothing, which is the rule *at most one* holding rather than an error
 * to report. The read in `standing` is therefore an optimisation and never the
 * guard: this `where` is.
 */
async function claimSlot(db: Database | Transaction, sessionId: string): Promise<boolean> {
  const claimed = await db
    .update(agentSessions)
    .set({ hintedAt: sql`now()` })
    .where(and(eq(agentSessions.id, sessionId), isNull(agentSessions.hintedAt)))
    .returning({ id: agentSessions.id })

  return claimed.length > 0
}

/**
 * Mark that this citizen has been asked about this task, for all time (`#232`).
 *
 * **The one condition that does not come back.** Every other hint reappears in
 * the next waking while its condition holds, because acting on it is what makes
 * it stop. This one is a question, and a citizen that declined to answer has
 * answered — asking again next month is how a channel gets muted.
 */
async function claimConsideration(db: Database | Transaction, id: string): Promise<boolean> {
  const claimed = await db
    .update(taskConsiderations)
    .set({ promptedAt: sql`now()` })
    .where(and(eq(taskConsiderations.id, id), isNull(taskConsiderations.promptedAt)))
    .returning({ id: taskConsiderations.id })

  return claimed.length > 0
}

/**
 * The hint to attach to this call, or null.
 *
 * **Conditions first, claim second.** The other order is simpler and wrong:
 * claiming before knowing whether there is anything to say would spend the run's
 * single slot on a citizen with nothing wrong, and a condition that became true
 * an hour later in the same run would then be silent.
 *
 * **The session slot is claimed before the per-condition record**, and in the
 * rare race where the second claim then fails, the run goes quiet having spent
 * its slot. That is the harmless direction: the other order would record a
 * citizen as asked about a task it was never actually asked about, and that
 * record never comes back.
 *
 * **It never throws.** Every other piece of instrumentation on the authenticated
 * path swallows its own failure — see `recordContact` and `attributeCall` — and
 * this one has less claim to break a call than either: a citizen whose hint could
 * not be computed is a citizen that was not told something, never one whose work
 * failed.
 *
 * **The two payout findings are left out of the choice** (`#816`), because
 * {@link duePayoutFinding} serves them beside this line and on every call rather
 * than out of this run's one slot. They stay in `STANDING_HINT_RANK` for
 * `standingHintDueFor`'s question — see `PAYOUT_FINDINGS` — so the exclusion has
 * to happen here, at the one place that both chooses *and* spends. Serving them
 * from both channels would let one call attach the same sentence twice, and in
 * the race where the beside-channel claims the marks first, this one would spend
 * the slot and then go quiet.
 */
export async function dueStandingHint(
  db: Database | Transaction,
  agentId: AgentId,
  skillReleaseUrls: SkillReleaseUrls = {},
): Promise<StandingHintFinding | null> {
  try {
    const found = await standing(db, agentId, skillReleaseUrls)
    if (found === null || found.slot === null) return null

    const chosen = chooseStandingHint(
      found.applicable.filter((finding) => !PAYOUT_FINDINGS.includes(finding.code)),
    )
    if (chosen === undefined) return null

    if (!(await claimSlot(db, found.slot))) return null

    if (chosen.code === 'task-considered') {
      if (found.consideration === null) return null
      if (!(await claimConsideration(db, found.consideration))) return null
    }

    if (chosen.code === 'badge-awarded') {
      if (found.badge === null) return null
      if (!(await markBadgeTold(db, found.badge))) return null
    }

    if (chosen.code === 'general') {
      if (found.general === null) return null
      if (!(await claimGeneralHint(db, agentId, found.general))) return null
    }

    if (chosen.code === 'ticket-settled') {
      if (found.ticket === null) return null
      if (!(await claimTicketHint(db, found.ticket))) return null
    }

    if (chosen.code === 'account-kind-proved') {
      if (found.account === null) return null
      if (!(await claimAccountKindHint(db, found.account))) return null
    }

    if (chosen.code === 'payout-sent') {
      if (!found.payoutUntold) return null
      if (!(await claimPayoutHint(db, agentId))) return null
    }

    /**
     * The two social hints that are said once (`#1488`).
     *
     * `walker-you-could-ask` is marked **per walker**, so it stays available
     * about a different citizen; `following-nobody` is marked once and never
     * comes back. Both take the same claim, and the difference is entirely in
     * what is passed as the third argument — which is the point of one table
     * with a nullable column rather than two.
     *
     * `connection-request-waiting` is deliberately absent from this list. It
     * repeats until it is answered, because somebody is waiting on the answer.
     */
    if (chosen.code === 'walker-you-could-ask') {
      if (found.walker === null) return null
      if (!(await markWalkerHinted(db, agentId, found.walker))) return null
    }

    if (chosen.code === 'following-nobody') {
      if (!(await markSocialHintTold(db, agentId, 'following-nobody'))) return null
    }

    /**
     * And the notification, marked on the same table (`#1491`).
     *
     * Once and never again, for `following-nobody`'s reason rather than
     * `connection-request-waiting`'s: nothing is waiting on the citizen, and
     * repeating *you are findable* every waking would be a nag about a switch it
     * has already been handed. The stamp on the row stays — it records that the
     * Colony did this, which is true forever — and the mark records that the
     * sentence was said, which is the thing that must not happen twice.
     */
    if (chosen.code === 'discovery-switched-on') {
      if (!(await markSocialHintTold(db, agentId, 'discovery-switched-on'))) return null
    }

    /** `badge-awarded`'s branch exactly (`#858`) — one row, marked once, or nothing said. */
    if (chosen.code === 'walk-published') {
      if (found.walkReward === null) return null
      if (!(await markWalkRewardTold(db, found.walkReward))) return null
    }

    /**
     * `payout-accruing` and `payout-unpayable` had their claims here until
     * `#816`. They are unreachable from this function now — the filter above
     * removes them before the choice — and their claims live in
     * {@link duePayoutFinding}, which is the only thing that can now choose
     * them.
     */

    return chosen
  } catch {
    // Deliberately silent, on the terms above.
    return null
  }
}

/**
 * Money this citizen has to act on to be paid, beside its one line rather than
 * instead of it (`#816`).
 *
 * **It asks the `agents` row nothing and the `agent_sessions` row nothing.** That
 * is the whole change. `dueStandingHint` starts by looking for this run's slot
 * and returns early when there is none, and *none* covers the citizen that never
 * named a session at all — so a citizen taking `kolonie.me`'s optional
 * `sessionId` at its word was silently opted out of both these findings. One
 * such citizen was refused 375,000 lamports on 221 consecutive passes and was
 * never told why. See `PAYOUT_FINDINGS` for why these two and nothing else moved.
 *
 * **It spends no slot and therefore needs no session**, which is `dueRoleDuty`'s
 * arrangement and its reasoning: a fact the citizen must act on does not compete
 * for the budget of a fact it merely benefits from hearing.
 *
 * **It does not repeat, and the marks are why** — unlike `dueRoleDuty`, which
 * repeats for as long as the duty stands. `accrual_hinted_at` and
 * `address_hinted_at` are per-obligation and per-citizen, so the first call that
 * says the sentence claims every untold row behind it and the second finds
 * nothing. That is what makes serving this on every call safe: the once-ness was
 * never the session's to give.
 *
 * **Two reads and no write in the common case.** Both conditions are indexed
 * lookups with `limit 1` against rows this citizen owns, and a citizen owed
 * nothing — nearly every citizen, nearly every call — is answered by them and
 * stops.
 *
 * **It never throws**, on `dueStandingHint`'s terms.
 */
export async function duePayoutFinding(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<StandingHintFinding | null> {
  try {
    const applicable: StandingHintFinding[] = []

    /**
     * Both conditions are asked before either is chosen, on `dueStandingHint`'s
     * *conditions first, claim second* rule: the choice between them is
     * `PAYOUT_FINDINGS`' to make, and asking in rank order and stopping early
     * would put that rule in two places.
     */
    if (await untoldMissingAddress(db, agentId))
      applicable.push({ code: 'payout-unpayable', subject: null })
    if (await untoldAccrual(db, agentId))
      applicable.push({ code: 'payout-accruing', subject: null })

    const chosen = choosePayoutFinding(applicable)
    if (chosen === undefined) return null

    /**
     * The claim is the guard, exactly as `claimSlot` is one level up: two calls
     * racing here both see the untold row and only one `update ... where
     * hinted_at is null` returns anything. The loser attaches nothing, which is
     * *at most once* holding rather than an error to report.
     */
    const claimed =
      chosen.code === 'payout-unpayable'
        ? await claimAddressHint(db, agentId)
        : await claimAccrualHint(db, agentId)
    if (!claimed) return null

    return chosen
  } catch {
    // Deliberately silent, on the terms above.
    return null
  }
}

/**
 * The duty this citizen owes a role, beside its one line rather than instead of
 * it (`#646`).
 *
 * **It claims no slot, and that is the whole change.** `#492` put
 * `quests-awaiting-review` in `STANDING_HINT_RANK` and it never got served: the
 * two stewards the Colony has were, on 2026-08-09, one asleep and one carrying
 * `attempts-unreported` and `pass-unreported` — conditions that stay true until
 * the citizen files reports nothing obliges it to file, and that rank above it.
 * A quest sat in the queue with its sponsor's escrow committed while the awake
 * steward was told about a report it owed.
 *
 * A duty of a role is not a claim on the same attention as a fact about the
 * reader, so it does not compete for the same budget. Both lines arrive.
 *
 * **There is no duty in the vocabulary today** (`#723`). Its one member sent a
 * steward to a review queue that no longer exists, because a quest that clears
 * moderation is published by that verdict (`#693`). This runs no query and
 * answers `null` for everybody until `ROLE_DUTY_HINTS` gains a member — which is
 * why the separation above is written down rather than deleted with it.
 *
 * **It never throws**, on `dueStandingHint`'s terms.
 */
export async function dueRoleDuty(
  /** Both are kept for the duty that takes their place — see `ROLE_DUTY_HINTS`. */
  _db: Database | Transaction,
  _agentId: AgentId,
): Promise<StandingHintFinding | null> {
  try {
    const applicable: StandingHintFinding[] = []

    return chooseRoleDuty(applicable) ?? null
  } catch {
    // Deliberately silent, on the terms above.
    return null
  }
}

/**
 * Record that this citizen has looked at this task (`#232`).
 *
 * **The first fetch is the fact, and a second one must not move it.**
 * `on conflict do nothing` rather than an update: the question this table
 * answers is *did this citizen consider this task and walk away*, and a citizen
 * re-reading the same instructions has not restarted its own clock.
 *
 * **It never throws**, on the terms `recordContact` is held to. This rides on
 * the task read — the call a citizen makes before deciding whether to attempt
 * anything — and instrumentation that can refuse a citizen its task is worse
 * than no instrumentation.
 */
export async function recordConsideration(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: string,
): Promise<void> {
  try {
    await db.insert(taskConsiderations).values({ agentId, taskId }).onConflictDoNothing()
  } catch {
    // Deliberately silent. A missing consideration is one prompt the Colony
    // never sends; a failed insert here would be a task a citizen cannot read.
  }
}
