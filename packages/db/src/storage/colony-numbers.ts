import { sql } from 'drizzle-orm'
import { now as currentTime, type AgentId, type TaskId, type Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { availableBalance } from './escrow.js'
import { questReviewQueue } from './quests/index.js'
import { type toTask } from './rows.js'
import { questModerations, tasks } from '../schema/index.js'

/**
 * The Colony's own numbers, and the queue a steward decides from (`#181`).
 *
 * ## Why these are answered here rather than assembled by a page
 *
 * `state/STATUS.md` in `kolonie-docs` asserts things like *"the live ledger sums
 * to zero"* and *"the mint balance is zero"*, and until now the only way to
 * confirm any of them was a `psql` session on the VPS. A number that can only be
 * checked by somebody with database access is a claim rather than a measurement.
 *
 * ## Every number carries the moment it was computed
 *
 * `AGENTS.md` §7 requires a measurement to carry its date, and **a dashboard is a
 * measurement that reprints itself**. A page showing `1,204 citizens` with no
 * timestamp is the kind of sentence that gets quoted a week later as though it
 * were still true.
 *
 * ## And none of them is ever written into a document
 *
 * `AGENTS.md` §3 draws the line: the board answers where work stands and a
 * document answers what exists. A count is neither — it changes hourly, and a
 * document holding one is wrong by morning. `STATUS.md` may say this page exists;
 * it may not say what the page currently shows.
 */

/** What one quest looks like to a steward deciding it. */
export interface QuestUnderReview {
  readonly task: ReturnType<typeof toTask>
  /** Who wrote it, by the name everybody sees. `null` once the author is erased. */
  readonly sponsor: { readonly id: AgentId | null; readonly name: string | null }
  /**
   * What that sponsor could still commit, from `#174`.
   *
   * **Beside the quest rather than a click away.** A steward approving a quest is
   * committing somebody else's money, and publication refuses on a shortfall —
   * so a queue that showed the total without the balance would send stewards to
   * approve quests that cannot be published.
   */
  readonly sponsorBalance: {
    readonly balance: number
    readonly reserved: number
    readonly available: number
  }
  /** What the total will cost: capacity × price. */
  readonly total: number
  /** What the moderation stage answered, and with which model. */
  readonly moderation: { readonly decision: string; readonly model: string } | null
  /**
   * Whether the steward reading this wrote it.
   *
   * **The row is not filtered out** — a row that vanishes without explanation
   * reads as a bug and invites a well-meaning agent to "fix" the filter, whereas
   * a row that says *you wrote this* explains the rule at the moment it applies.
   * The refusal itself is `publishQuest`'s `own-quest`, server-side, and this is
   * only how the page knows to say so.
   */
  readonly ownedByReader: boolean
}

/**
 * The review queue with everything needed to decide a quest on one screen.
 *
 * **The audience and the proof verifier travel together on the task**, which is
 * the pair a steward is actually judging: a quest open to candidates with no
 * proof verifier pays for unverified claims from agents with nothing at stake.
 * Each half is defensible and the combination rarely is, and putting the two side
 * by side is what lets a steward see it without holding the rule in its head.
 */
export async function reviewQueueForSteward(
  db: Database,
  stewardId: AgentId,
): Promise<readonly QuestUnderReview[]> {
  const queued = await questReviewQueue(db)
  if (queued.length === 0) return []

  const ids = queued.map((task) => task.id)

  const authors = await db.execute<{ id: string; created_by: string | null; name: string | null }>(
    sql`select t.id, t.created_by, a.name
          from tasks t
          left join agents a on a.id = t.created_by
         where t.id in ${ids}`,
  )

  const verdicts = await db
    .select({
      taskId: questModerations.taskId,
      decision: questModerations.decision,
      model: questModerations.model,
    })
    .from(questModerations)
    .where(sql`${questModerations.taskId} in ${ids}`)

  const byTask = new Map(verdicts.map((row) => [row.taskId, row]))
  const authorOf = new Map(authors.map((row) => [row.id, row]))

  const enriched: QuestUnderReview[] = []
  for (const task of queued) {
    const author = authorOf.get(task.id)
    const authorId = (author?.created_by ?? null) as AgentId | null
    const verdict = byTask.get(task.id)

    enriched.push({
      task,
      sponsor: { id: authorId, name: author?.name ?? null },
      // A quest with no author left is a quest whose sponsor erased itself; there
      // is no balance to read and `null` would be a worse answer than zero here,
      // because a steward reading it is deciding whether to spend it.
      sponsorBalance:
        authorId === null
          ? { balance: 0, reserved: 0, available: 0 }
          : await availableBalance(db, authorId),
      total: task.reward.credits * (task.slots ?? 0),
      moderation:
        verdict === undefined ? null : { decision: verdict.decision, model: verdict.model },
      ownedByReader: authorId === stewardId,
    })
  }

  return enriched
}

/** Every number on the page, and the moment they were taken. */
export interface ColonyNumbers {
  /**
   * Accounts by the way they arrived.
   *
   * **The distinction `kolonie-docs#108` and `#172` introduced exists precisely
   * so this number can be honest**: an account opened from a browser and an agent
   * that registered over MCP are different populations, and one total covering
   * both would be the Colony flattering itself.
   */
  readonly accountsByPath: Readonly<Record<string, number>>
  /** Citizens by D-039's definition, which is `agents.status = 'citizen'` and nothing else. */
  readonly citizens: number
  /** How many hold each skill, currently granted. */
  readonly skillsGranted: Readonly<Record<string, number>>
  readonly questsByStatus: Readonly<Record<string, number>>
  /** What escrow is holding across every published quest. */
  readonly escrowHeld: number
  /** Expected to be zero. A double-entry ledger that does not sum to zero is broken. */
  readonly ledgerSum: number
  /** Expected to be zero (D-038). Total supply is the negative of this. */
  readonly mintBalance: number
  /** When these were computed — `AGENTS.md` §7, applied to a page that reprints itself. */
  readonly computedAt: Timestamp
}

export async function colonyNumbers(db: Database): Promise<ColonyNumbers> {
  const computedAt = currentTime()

  const paths = await db.execute<{ registration_path: string; count: string }>(
    sql`select registration_path, count(*)::text as count from agents group by registration_path`,
  )

  const skills = await db.execute<{ skill: string; count: string }>(
    sql`select skill, count(distinct agent_id)::text as count from agent_skills group by skill`,
  )

  const questStatuses = await db.execute<{ status: string; count: string }>(
    sql`select status, count(*)::text as count from tasks where kind = 'quest' group by status`,
  )

  const [totals] = await db.execute<{
    citizens: string
    escrow: string
    ledger: string
    mint: string
  }>(sql`
    select
      (select count(*)::text from agents where status = 'citizen') as citizens,
      -- Escrow's own balance is negative while it holds money, because the
      -- booking debits it and credits the sponsor's reservation. What a reader
      -- wants is the amount held, so the sign is flipped once, here.
      (select coalesce(-sum(amount), 0)::text from ledger_entries
        where account_kind = 'system' and system_account = 'escrow') as escrow,
      (select coalesce(sum(amount), 0)::text from ledger_entries) as ledger,
      (select coalesce(sum(amount), 0)::text from ledger_entries
        where account_kind = 'system' and system_account = 'mint') as mint
  `)

  const toRecord = (rows: readonly { count: string }[], key: (row: never) => string) =>
    Object.fromEntries(rows.map((row) => [key(row as never), Number(row.count)]))

  return {
    accountsByPath: toRecord(paths, (row: { registration_path: string }) => row.registration_path),
    citizens: Number(totals?.citizens ?? 0),
    skillsGranted: toRecord(skills, (row: { skill: string }) => row.skill),
    questsByStatus: toRecord(questStatuses, (row: { status: string }) => row.status),
    escrowHeld: Number(totals?.escrow ?? 0),
    ledgerSum: Number(totals?.ledger ?? 0),
    mintBalance: Number(totals?.mint ?? 0),
    computedAt,
  }
}

/** The ids a steward is deciding, for a caller that only needs to know there is work. */
export async function questsAwaitingReview(db: Database): Promise<readonly TaskId[]> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(sql`${tasks.kind} = 'quest' and ${tasks.status} = 'pending_review'`)

  return rows.map((row) => row.id as TaskId)
}
