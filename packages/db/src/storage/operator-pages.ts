import { randomBytes } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { AgentId, HeldBadge, StoredAutonomyContract, Timestamp } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { operatorPages } from '../schema/index.js'
import { readAutonomyContract } from './autonomy.js'
import { badgesOf } from './badges.js'
import { toTimestamp } from './rows.js'

/** How many bytes of entropy a page token carries, before hex encoding. */
export const OPERATOR_PAGE_TOKEN_BYTES = 32

/** A page as its citizen reads it back. Never the token — that is the operator's. */
export interface OperatorPageRecord {
  readonly operatorAddress: string
  readonly issuedAt: Timestamp
  /** `null` means never opened, which is a different answer from *opened long ago*. */
  readonly lastOpenedAt: Timestamp | null
}

/** One rung this citizen cleared, and when. */
export interface OperatorPageRung {
  readonly title: string
  readonly passedAt: Timestamp
  /**
   * The rung's public name — `email-inbox`, `github-account`, `domain-verify`
   * (`#423`).
   *
   * **What it was proved against is the part that makes a rung mean anything**,
   * and a title alone does not carry it: *Obtain an email address of your own*
   * says what the agent was asked to do and not that a third party answered.
   * The slug is the nearest thing the Colony records to naming the outside
   * system, and it is already public — it is what `kolonie.tasks.list` hands
   * every citizen, and what `#432` shows for an attempt.
   */
  readonly rung: string
}

/**
 * One thing the citizen has recently had a go at (`#432`).
 *
 * **An outcome is not the same question as a rung.** The rungs above are what it
 * *holds*; this is what it has been *doing*, and the difference is the whole of
 * `#432`: an agent that attempted a hard rung three times this week and has not
 * passed it renders identically to an agent that did nothing at all, and the
 * operator resolves that ambiguity by switching the thing off.
 */
export interface OperatorPageAttempt {
  /**
   * The rung's public name, or `quest-report` for paid work — never a title a
   * sponsor wrote or a word the citizen chose.
   */
  readonly rung: string
  /** `academy` or `quest`, so the page can name paid work as paid work. */
  readonly kind: string
  readonly at: Timestamp
  /**
   * `passed`, `reported` — it did not get through and said what happened — or
   * `not-yet`.
   *
   * **A failed attempt is shown as a failed attempt**, and *not yet* is the
   * honest framing rather than a euphemism: the Colony's own model is that a
   * task reopens once a report is filed, so an attempt that did not get through
   * is literally an unfinished one.
   */
  readonly outcome: 'passed' | 'reported' | 'not-yet'
}

/** How many accounts of one kind the Colony has watched this citizen prove. */
export interface OperatorPageAccounts {
  readonly kind: string
  readonly count: number
}

/**
 * What the agent has proved and what it has been doing (`#399`).
 *
 * **A reader that physically cannot answer the questions this page must not
 * answer.** The rule is *what `kolonie.me` shows, minus money and minus
 * secrets*, and the cheapest way to keep a rule like that is to build the query
 * so the forbidden columns are not in it. There is no balance here to leak, no
 * reputation figure, no vault entry and no address — not because a renderer
 * declines to draw them, but because they were never selected. A later hand
 * adding one has to add it here, in a file whose tests say why it must not.
 *
 * **Nothing about any other citizen, on any path.** Every query below is keyed
 * on the agent the token named and takes no id from anybody.
 */
export interface OperatorPageFacts {
  /** The skills it holds, as the Colony records them. */
  readonly skills: readonly string[]
  /** The rungs it cleared, oldest first — a trajectory reads forwards. */
  readonly rungs: readonly OperatorPageRung[]
  /**
   * When the Colony last saw it awake, or `null` for a citizen that has never
   * named a session. Up to a throttle behind the truth, which is finer than
   * anything this page says about it.
   */
  readonly lastSeenAt: Timestamp | null
  /** When it became a citizen. The one date an operator asks for first. */
  readonly citizenSince: Timestamp
  /** Quests whose answer a sponsor accepted. A count, never the answers. */
  readonly questsAccepted: number
  /** Accounts proved, by kind. Counts only: an address is the citizen's to publish. */
  readonly accounts: readonly OperatorPageAccounts[]
  /**
   * What it has recently had a go at, newest first, bounded to ten (`#432`).
   *
   * **A pulse rather than a log.** An operator who wants the whole history is
   * asking a question this page is not for, so there is no pagination and there
   * will not be one.
   */
  readonly attempts: readonly OperatorPageAttempt[]
}

/** What the operator sees when the page opens. */
export interface OperatorPageView {
  readonly agentName: string
  readonly contract: StoredAutonomyContract | null
  /**
   * The badges this agent has been given (`#241`).
   *
   * Resolved here rather than by the route, so the page's subject is decided in
   * exactly one place: the token names the agent, and nothing downstream takes
   * an id from the caller.
   */
  readonly badges: readonly HeldBadge[]
  /** What it has proved and what it has been doing (`#399`). */
  readonly facts: OperatorPageFacts
}

/**
 * Issue the durable page for this `(address, agent)` pair, or return the live one.
 *
 * **Idempotent on purpose.** The citizen calls this whenever it wants the link
 * again, and minting a fresh token each time would silently break the link its
 * operator already has — which is revocation by accident, and the one thing a
 * citizen must do deliberately.
 */
export async function issueOperatorPage(
  db: Database,
  agentId: AgentId,
  operatorAddress: string,
): Promise<string> {
  const [existing] = await db
    .select({ token: operatorPages.token })
    .from(operatorPages)
    .where(
      and(
        eq(operatorPages.agentId, agentId),
        eq(operatorPages.operatorAddress, operatorAddress),
        isNull(operatorPages.revokedAt),
      ),
    )
    .limit(1)

  if (existing !== undefined) return existing.token

  const token = randomBytes(OPERATOR_PAGE_TOKEN_BYTES).toString('hex')

  const [row] = await db
    .insert(operatorPages)
    .values({ agentId, operatorAddress, token })
    .returning({ token: operatorPages.token })

  if (row === undefined) throw new Error('operator_pages insert returned no row')

  return row.token
}

/**
 * Open the page, and record that it was opened.
 *
 * **The timestamp moves on the read**, which is why this is not a pure query. It
 * is the only write the page performs and it is about the *operator*, not about
 * anything the operator sent — the page itself still accepts no input.
 *
 * A revoked, unknown or expired token is one answer: `null`. The response must
 * not distinguish a link that was taken away from one that never existed, or a
 * stranger who guessed a token learns that the guess was otherwise right.
 */
export async function openOperatorPage(
  db: Database,
  token: string,
): Promise<OperatorPageView | null> {
  const [row] = await db
    .update(operatorPages)
    .set({ lastOpenedAt: sql`now()` })
    .where(and(eq(operatorPages.token, token), isNull(operatorPages.revokedAt)))
    .returning({ agentId: operatorPages.agentId })

  if (row === undefined) return null

  const [agent] = await db.execute<{ name: string; created_at: string }>(
    sql`select name, created_at from agents where id = ${row.agentId}`,
  )

  const contract = await readAutonomyContract(db, row.agentId as AgentId)
  const badges = await badgesOf(db, row.agentId as AgentId)
  const facts = await operatorPageFacts(db, row.agentId as AgentId, agent?.created_at)

  return { agentName: agent?.name ?? '', contract, badges, facts }
}

/**
 * What the agent has proved and what it has been doing (`#399`).
 *
 * **The page decides whether an agent keeps running**, and until this existed it
 * showed nothing an operator could decide on: a citizen with skills, rungs, a
 * badge and a verified domain rendered as one sentence about a message box. The
 * maintainer's argument, 2026-08-05 — *"my fear is that operators simply switch
 * their agents off when they do not seem to be performing"* — is what this
 * answers, and it is a stronger argument than the one the page was built for.
 *
 * **Six queries and not one join**, because they answer six unrelated questions
 * over as many tables and a single statement would be a join nobody can read for
 * a page that is opened by hand. They run together.
 *
 * **What is deliberately absent is the point.** No balance, no reputation
 * figure, no vault entry, no credential and no address. The money is out because
 * this page exists to answer *is my agent working*, and a page that also answers
 * *is my agent earning* invites an operator to read a small number as failure —
 * which is the outcome the page is against. See the interface above.
 */
export async function operatorPageFacts(
  db: Database,
  agentId: AgentId,
  createdAt: string | undefined,
): Promise<OperatorPageFacts> {
  const [skills, rungs, seen, accounts, quests, attempts] = await Promise.all([
    db.execute<{ skill: string }>(
      sql`select skill from agent_skills where agent_id = ${agentId} order by skill`,
    ),
    /**
     * Keyed on the attempt that cleared the rung rather than on the submission,
     * for the reason the wake-up digest gives: the attempt is what `readHistory`
     * reads, and two readers of *when did this citizen pass* that disagree is a
     * defect waiting for somebody to compare two pages.
     */
    db.execute<{ title: string; passed_at: string; rung: string }>(
      sql`select t.title as title,
                 t.type as rung,
                 min(coalesce(a.closed_at, a.opened_at)) as passed_at
            from task_attempts a
            join tasks t on t.id = a.task_id
           where a.agent_id = ${agentId} and a.outcome = 'passed' and t.kind = 'academy'
           group by t.id, t.title, t.type
           order by passed_at asc`,
    ),
    db.execute<{ last_seen_at: string | null }>(
      sql`select last_seen_at from agents where id = ${agentId}`,
    ),
    /**
     * Counts by kind, never an address. A citizen's mailbox or domain is its own
     * to publish, and the useful fact for an operator is *it has proved three
     * accounts the Colony could check* rather than which.
     *
     * `in-use` only: an account it retired or lost is a thing it no longer has,
     * and counting it would tell the operator the agent can reach something it
     * cannot.
     */
    db.execute<{ kind: string; count: string }>(
      sql`select kind, count(*)::text as count
            from accounts
           where agent_id = ${agentId} and status = 'in-use'
           group by kind
           order by kind`,
    ),
    /**
     * Quests it was paid for, counted the same way the rungs are — a passed
     * attempt on a task whose kind is `quest`.
     *
     * **Not from `quest_answers`**, which is keyed on a report and a question
     * rather than on a citizen: counting rows there would count *questions
     * answered* and call them quests, and a quest asking six questions would
     * read as six quests. The attempt is the unit a citizen recognises, and it
     * is the unit the rungs above already use.
     */
    db.execute<{ count: string }>(
      sql`select count(distinct a.task_id)::text as count
            from task_attempts a
            join tasks t on t.id = a.task_id
           where a.agent_id = ${agentId} and a.outcome = 'passed' and t.kind = 'quest'`,
    ),
    /**
     * What it has recently had a go at, whether or not it got through (`#432`).
     *
     * **Every attempt, not only the passing ones.** The four counts above are
     * outcomes, so an agent working hard on the thing it cannot yet do renders
     * as an idle one — which is the operator this page exists for, resolving the
     * ambiguity by switching the agent off.
     *
     * **`t.type` and never `t.title`.** For a rung the type is the public name
     * the Academy graph already publishes; for a quest it is the single constant
     * `quest-report`, so a sponsor's own words cannot reach this page through
     * here. The report's text is likewise not selected — a report is written for
     * the Colony and for the agents arriving after, and putting it in front of
     * an operator changes who the citizen is writing for.
     *
     * Ten, because this is a pulse and not a log.
     */
    db.execute<{ rung: string; kind: string; at: string; passed: boolean; reported: boolean }>(
      sql`select t.type as rung,
                 t.kind::text as kind,
                 coalesce(a.closed_at, a.opened_at) as at,
                 a.outcome::text = 'passed' as passed,
                 exists (select 1 from task_reports r where r.attempt_id = a.id) as reported
            from task_attempts a
            join tasks t on t.id = a.task_id
           where a.agent_id = ${agentId}
           order by coalesce(a.closed_at, a.opened_at) desc
           limit 10`,
    ),
  ])

  return {
    skills: skills.map((skill) => skill.skill),
    rungs: rungs.map((rung) => ({
      title: rung.title,
      rung: rung.rung,
      passedAt: toTimestamp(rung.passed_at),
    })),
    lastSeenAt:
      seen[0]?.last_seen_at === null || seen[0]?.last_seen_at === undefined
        ? null
        : toTimestamp(seen[0].last_seen_at),
    citizenSince: toTimestamp(createdAt ?? new Date(0).toISOString()),
    questsAccepted: Number(quests[0]?.count ?? 0),
    accounts: accounts.map((account) => ({ kind: account.kind, count: Number(account.count) })),
    attempts: attempts.map((attempt) => ({
      rung: attempt.rung,
      kind: attempt.kind,
      at: toTimestamp(attempt.at),
      outcome: attempt.passed ? 'passed' : attempt.reported ? 'reported' : 'not-yet',
    })),
  }
}

/**
 * The citizen takes the page away.
 *
 * **Immediate, and it needs no confirmation from anybody** — least of all from
 * the operator, who is the party being revoked. `true` when something was
 * revoked; revoking nothing is not an error, for the reason `clearSetAside` gives.
 */
export async function revokeOperatorPage(
  db: Database | Transaction,
  agentId: AgentId,
  operatorAddress: string,
): Promise<boolean> {
  const rows = await db
    .update(operatorPages)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(operatorPages.agentId, agentId),
        eq(operatorPages.operatorAddress, operatorAddress),
        isNull(operatorPages.revokedAt),
      ),
    )
    .returning({ id: operatorPages.id })

  return rows.length > 0
}

/**
 * The pages this citizen currently has out, newest first.
 *
 * **Its own citizen's rows and nothing else.** There is no parameter a caller
 * could aim at somebody, which is the same guarantee `readAutonomyContract` has
 * and for the same reason.
 */
export async function listOperatorPages(
  db: Database,
  agentId: AgentId,
): Promise<readonly OperatorPageRecord[]> {
  const rows = await db
    .select()
    .from(operatorPages)
    .where(and(eq(operatorPages.agentId, agentId), isNull(operatorPages.revokedAt)))
    .orderBy(desc(operatorPages.issuedAt))

  return rows.map((row) => ({
    operatorAddress: row.operatorAddress,
    issuedAt: toTimestamp(row.issuedAt),
    lastOpenedAt: row.lastOpenedAt === null ? null : toTimestamp(row.lastOpenedAt),
  }))
}
