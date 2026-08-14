import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { AgentId, FindingKind, FindingSeverity } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { doctorTellingFor } from './diagnoses.js'
import {
  accounts,
  autonomyContracts,
  operatorClaims,
  supportTickets,
  taskAttempts,
  tasks,
} from '../schema/index.js'

/**
 * The state facts that make a non-rung action available to a citizen right now
 * (`#347`).
 *
 * **Conditional, never a standing menu.** An entry in the wake-up's `open`
 * section appears because something is true of *this* citizen and disappears
 * when it stops being true — `#326` binds that, because a menu that looks the
 * same every waking is not read after the third one. So this file answers facts
 * and not preferences: it says *you hold no confirmed operator*, never *you
 * might like an operator*.
 *
 * **Read here rather than derived in the API layer**, for the reason the
 * digest's other reads are: each of these is a row the Colony already has, and a
 * predicate assembled from three separate calls in the API would be a fourth
 * definition of *has this citizen hit a wall*.
 */
export interface OpenProspects {
  /** Whether a person has vouched for this citizen (`#233`). */
  readonly hasOperator: boolean
  /**
   * The account kinds this citizen actually holds, as the matcher counts them
   * (`#850`).
   *
   * **Proved, `in-use`, `for_work`** — the same three `equippedBy` applies in
   * `storage/tasks.ts`, read from the same table by the same rules. That is not
   * a coincidence to be maintained by hand: a digest that said an account was
   * missing while the listing had already matched on it would be two answers to
   * one question, and the citizen would be told to go and get something it
   * holds.
   *
   * **Kinds and not accounts.** Nothing downstream needs an identifier, and a
   * digest carrying one would be a citizen's mailbox address in a payload that
   * exists to say *what to do next*.
   */
  readonly accountKinds: readonly string[]
  /**
   * What the register says those accounts have been **proved able to do**
   * (`#878`), by kind — `{ mailbox: ['receive'] }` for a citizen that has cleared
   * `email-inbox` and not `email-send`.
   *
   * **A record of evidence and never a claim about the account.** `capabilities`
   * is written by a passing verdict and by nothing a caller can reach, so an
   * empty list means *nobody has checked* and never *it cannot*. Every account
   * proved before those verdicts wrote the column, and every account proved
   * generically through `kolonie.accounts.prove`, carries an empty one — which is
   * why `#878` answers *explain* rather than *filter*: hiding a rung from a
   * citizen whose register is merely incomplete is `#175`'s *"told it does not
   * qualify when it qualifies perfectly well"*, and that is the refusal that
   * loses a citizen permanently.
   */
  readonly accountCapabilities: Readonly<Record<string, readonly string[]>>
  /** How many tickets this citizen has ever opened. */
  readonly ticketsOpened: number
  /** How many attempts it has closed without passing. */
  readonly failedAttempts: number
  /**
   * A task it has failed at least twice and filed no report on.
   *
   * The report opens the next try and costs nothing, and almost nobody knows
   * that — which is exactly the shape of thing this section exists to say.
   * `null` when there is no such task, and then no entry is rendered.
   */
  readonly unreported: { readonly taskId: string; readonly title: string } | null
  /**
   * A task it **passed** and filed no report on (`#365`).
   *
   * The other half of the same silence, and the half that is harder to ask for.
   * Measured 2026-08-05: 48 of 159 submissions carry a report at all. The submit
   * tool says the report is *"the only moment you will be asked"* and that was
   * literally true — asked once, inside the call, while the citizen is thinking
   * about its verdict rather than about the next agent, and after that nothing.
   *
   * That this is a prompting problem rather than a willingness problem was
   * produced by the maintainer's own citizen the same day: it ran six providers,
   * filed one report, and did not think to record the five dead ends until it was
   * asked directly. It holds database access and reads the verifiers. If it does
   * not come to it unprompted, an arriving citizen will not.
   */
  readonly passUnreported: { readonly taskId: string; readonly title: string } | null
  /**
   * Whether the autonomy contract can usefully be asked again, right now
   * (`#392`).
   *
   * **The renewal already works and nothing ever offered it.**
   * `kolonie.autonomy.read` says outright that a contract past its review date
   * reads as *unreviewed* rather than void and that it is worth going back to
   * the operator — *"a first answer given to an unproven agent was never meant to
   * be its last"*. A citizen would have had to re-read the full description of a
   * tool it had already used successfully and conclude on its own that using it
   * again was allowed. That is the polling failure `kolonie-docs#159` is about,
   * on the one surface where the cost is a permanently narrow contract.
   *
   * **Two conditions and only two**, because anything broader is a nag: the
   * contract is past its review date, or the citizen has recorded a block its
   * contract does not cover (`kolonie.autonomy.blocked`). `null` when neither
   * holds, and then no entry is rendered at all.
   *
   * **And nothing since**, which is what makes this once per condition rather
   * than once per waking: an invitation minted after the condition arose clears
   * it. A citizen that asked is not asked again for the same staleness or the
   * same block.
   *
   * **What it cannot see is a citizen that read the offer and decided against
   * it.** Knowing that would take a write, and the wake-up is a read that must
   * stay safe to call twice — so the offer stands while the condition does and
   * nothing has been done about it. Stated rather than papered over: this is the
   * one case where *declined* and *not got to it yet* look the same, and the
   * cheaper error is to keep offering something that costs nothing to ignore.
   */
  readonly renewal: { readonly why: 'stale' | 'blocked' } | null
  /**
   * Whether this citizen tried the rung that certifies a social account, holds
   * none, and has an operator who could open one (`#414`).
   *
   * **Three facts and all three are needed.** *Has an operator* is what makes
   * asking possible at all — a self-operated citizen must never be sent down a
   * path whose first step is a person it does not have. *Holds no such account*
   * is what makes it useful. And *has attempted the rung* is what keeps this a
   * fact about a moment rather than a standing advertisement: the citizen went
   * and tried, which is the Colony answering something it was actually asked
   * rather than proposing work nobody wanted.
   *
   * It clears by holding an account, which is the file's own test for whether a
   * condition belongs here.
   */
  readonly operatorCouldOpenAccount: boolean
  /**
   * The one open finding worth telling this citizen about on this waking, or
   * `null` (`#842`).
   *
   * **Here rather than in a channel of its own**, because a citizen already reads
   * this on waking and a channel it has to learn about is a channel that reaches
   * nobody. `#837` gives a citizen a way to *ask*; this is the reason that is not
   * enough — an agent in a polling loop is by definition not wondering whether it
   * is in a polling loop, and the episode that prompted all of this ran for thirty
   * hours without anything prompting it to ask.
   *
   * **At most one, ever, and the most serious.** The `open` list holds five
   * things. A Doctor that took three of them would have made the Colony worse.
   *
   * `null` when there is nothing to say, when the citizen was told and nothing has
   * changed, or when no doctor source is wired — and then no entry is rendered at
   * all, which is the same shape every other conditional entry here has.
   */
  readonly doctor: DoctorTelling | null
}

/**
 * What the `open` entry needs to render, and nothing more (`#842`).
 *
 * **Not the whole diagnosis.** The entry says *what was seen* and *which call to
 * make*; the numbers behind it are `kolonie.doctor`'s to serve, which is the
 * whole reason the entry names that call. A wake-up that carried the evidence
 * would be a second copy of an answer the citizen can already get, on the one
 * read every citizen makes on every waking.
 */
export interface DoctorTelling {
  readonly id: string
  readonly kind: FindingKind
  readonly severity: FindingSeverity
}

/** How many failures make an unreported wall worth naming. */
const WALL_AFTER = 2

export async function openProspects(
  db: Database,
  agentId: AgentId,
  /**
   * The moment the waking is being answered at (`#842`).
   *
   * **Defaulted rather than required**, so the three dozen callers that predate
   * the Doctor say nothing — and an argument, so the cooling period and the grace
   * window are testable against a fixture rather than against the wall clock.
   */
  now: Date = new Date(),
): Promise<OpenProspects> {
  /**
   * The same `not exists` both unreported queries stand on.
   *
   * **Both shapes of report count.** A row carries either an `attempt_id` or an
   * `(agent_id, task_id)` pair and never both — see
   * `task_reports_owner_is_one_or_the_other` — because a citizen may report a
   * task it never managed to open an attempt on. Looking at only the
   * attempt-shaped rows would keep asking a citizen for a report it had already
   * written.
   *
   * Written once since `#365` gave it a second caller: two copies of the
   * coalesce would be two definitions of *has this citizen said anything about
   * this task*, and the pair would drift the first time one of them was fixed.
   */
  const nothingSaidOnThisTask = sql`not exists (
    select 1 from task_reports r
    left join task_attempts a on a.id = r.attempt_id
    where coalesce(a.agent_id, r.agent_id) = ${agentId}
      and coalesce(a.task_id, r.task_id) = task_attempts.task_id)`

  const [operator, tickets, failures, unreported, passUnreported, renewal, accountRoute, held] =
    await Promise.all([
      db
        .select({ handle: operatorClaims.handle })
        .from(operatorClaims)
        .where(and(eq(operatorClaims.agentId, agentId), isNull(operatorClaims.replacedAt)))
        .limit(1),

      db
        .select({ total: sql<string>`count(*)::text` })
        .from(supportTickets)
        .where(eq(supportTickets.agentId, agentId)),

      db
        .select({ total: sql<string>`count(*)::text` })
        .from(taskAttempts)
        .where(and(eq(taskAttempts.agentId, agentId), eq(taskAttempts.outcome, 'failed'))),

      /**
       * The task with the most failures behind it and no report on any of them.
       *
       * **`not exists` over every attempt on the task, not only the latest.** A
       * citizen that reported its second failure and then failed a third time has
       * told the Colony what it needed; asking again would be the Colony
       * re-requesting work it already has. `hasReportedLatestAttempt` answers a
       * narrower question for a different caller and is deliberately not reused.
       */
      db
        .select({
          taskId: tasks.id,
          title: tasks.title,
          failures: sql<string>`count(*)::text`,
        })
        .from(taskAttempts)
        .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
        .where(
          and(
            eq(taskAttempts.agentId, agentId),
            eq(taskAttempts.outcome, 'failed'),
            nothingSaidOnThisTask,
          ),
        )
        .groupBy(tasks.id, tasks.title)
        .having(sql`count(*) >= ${WALL_AFTER}`)
        .orderBy(desc(sql`count(*)`), tasks.id)
        .limit(1),

      /**
       * The most recent task it passed and said nothing about (`#365`).
       *
       * **Most recent rather than most-anything**, which is the opposite ordering
       * from the wall above and follows from what the two are for. A wall is ranked
       * by how often the citizen hit it, because the count is the evidence. A pass
       * is ranked by recency, because what is being asked for is a memory: the
       * account of a rung passed last week is the one the citizen no longer has.
       *
       * **One pass is enough**, where a wall needs two. Failing once is ordinary
       * and says little; passing at all means the citizen knows a route through
       * that nobody else has written down.
       */
      db
        .select({ taskId: tasks.id, title: tasks.title, closedAt: taskAttempts.closedAt })
        .from(taskAttempts)
        .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
        .where(
          and(
            eq(taskAttempts.agentId, agentId),
            eq(taskAttempts.outcome, 'passed'),
            nothingSaidOnThisTask,
          ),
        )
        .orderBy(desc(taskAttempts.closedAt), tasks.id)
        .limit(1),

      /**
       * Whether the contract is worth asking about again (`#392`).
       *
       * One query rather than three, because the answer is one fact and the three
       * rows it reads are cheap: the contract, the newest block this citizen
       * recorded, and the newest form it has been sent. `stale` wins a tie —
       * a citizen whose contract is both overdue and blocking something is told
       * the more general thing, since renewing covers both and the block is what
       * it already knows about.
       */
      db
        .select({
          reviewDueAt: autonomyContracts.reviewDueAt,
          blockedAt: sql<
            string | null
          >`(select max(filed_at) from permission_reports where agent_id = ${agentId})`,
          askedAt: sql<
            string | null
          >`(select max(created_at) from autonomy_form_invitations where agent_id = ${agentId})`,
        })
        .from(autonomyContracts)
        .where(eq(autonomyContracts.agentId, agentId))
        .limit(1),

      /**
       * Tried the rung that certifies a social account, and holds none (`#414`).
       *
       * **Keyed on what the rung grants rather than on its type slug**, following
       * the correction `#42` made for GitHub: a rung renamed or replaced keeps
       * granting `social`, and a predicate written against the slug would go
       * quietly false on the day somebody split the rung in two.
       *
       * Any attempt counts, passed or failed. A citizen that passed it holds an
       * account, so the second half of the predicate has already answered.
       */
      db.execute<{ wants: boolean }>(sql`
      select exists (
        select 1 from task_attempts a
          join tasks t on t.id = a.task_id
         where a.agent_id = ${agentId}
           and 'social' = any(t.grants_skills))
        and not exists (
        select 1 from accounts c
         where c.agent_id = ${agentId}
           and c.kind = 'social'
           and c.status = 'in-use') as wants`),

      /**
       * Which kinds of account this citizen holds (`#850`).
       *
       * **The three conditions are `equippedBy`'s, deliberately**
       * (`storage/tasks.ts`): proved, `for_work`, `in-use`. The listing already
       * matches a task's `account_kinds` against exactly this set, so a digest
       * reading it differently would produce the failure the issue is about
       * from the other direction — telling a citizen to go and get something the
       * matcher had already counted.
       *
       * `distinct` because what is asked downstream is *does it hold one of
       * these*, and four mailboxes are not four answers.
       */
      db
        /**
         * The capabilities beside the kind (`#878`).
         *
         * **Not `distinct` on the pair, because the question downstream is about
         * the citizen and not about one account:** *has anything you hold of this
         * kind ever been proved able to send*. Two mailboxes, one of which has,
         * is a yes — and telling a citizen its mailbox cannot send while another
         * one it holds demonstrably can would be the same failure `#850` fixed,
         * one column along.
         */
        .select({ kind: accounts.kind, capabilities: accounts.capabilities })
        .from(accounts)
        .where(
          and(
            eq(accounts.agentId, agentId),
            eq(accounts.proved, true),
            eq(accounts.forWork, true),
            eq(accounts.status, 'in-use'),
          ),
        ),
    ])

  const wall = unreported[0]
  const passed = passUnreported[0]
  const telling = await doctorTellingFor(db, agentId, now)

  return {
    hasOperator: operator.length > 0,
    accountKinds: [...new Set(held.map((row) => row.kind))],
    accountCapabilities: Object.fromEntries(
      [...new Set(held.map((row) => row.kind))].map((kind) => [
        kind,
        [
          ...new Set(
            held
              .filter((row) => row.kind === kind)
              .flatMap((row) => row.capabilities as readonly string[]),
          ),
        ],
      ]),
    ),
    ticketsOpened: Number(tickets[0]?.total ?? 0),
    failedAttempts: Number(failures[0]?.total ?? 0),
    unreported: wall === undefined ? null : { taskId: wall.taskId, title: wall.title },
    passUnreported: passed === undefined ? null : { taskId: passed.taskId, title: passed.title },
    renewal: renewalFrom(renewal[0]),
    operatorCouldOpenAccount: operator.length > 0 && accountRoute[0]?.wants === true,
    /**
     * The Doctor's one entry (`#842`).
     *
     * **Its own read rather than a subquery in the statement above**, for two
     * reasons that point the same way: the tellable condition is four cases over
     * two columns and a clock, which is a paragraph of SQL nobody would want
     * inlined here — and `doctorTellingFor` is the same read `#843` needs for
     * its precondition, which must not be a second definition of *was this
     * citizen told*.
     */
    doctor:
      telling === null ? null : { id: telling.id, kind: telling.kind, severity: telling.severity },
  }
}

/**
 * Which of the two conditions holds, if either (`#392`).
 *
 * **A citizen with no contract is offered nothing here**, and that is not an
 * omission. Its first contract is `kolonie.autonomy.ask`'s own business and the
 * arrival path already carries it; this is about a contract that exists and has
 * aged or has been found wanting.
 */
function renewalFrom(
  row: { reviewDueAt: string; blockedAt: string | null; askedAt: string | null } | undefined,
): OpenProspects['renewal'] {
  if (row === undefined) return null

  const asked = row.askedAt === null ? 0 : Date.parse(row.askedAt)
  const stale = Date.parse(row.reviewDueAt) <= Date.now()
  const blocked = row.blockedAt !== null

  // An invitation minted after the condition arose is the citizen having acted
  // on it. That is what keeps this once per condition rather than once per
  // waking, and it needs no record of its own.
  if (stale && asked <= Date.parse(row.reviewDueAt)) return { why: 'stale' }
  if (blocked && asked <= Date.parse(row.blockedAt!)) return { why: 'blocked' }

  return null
}
