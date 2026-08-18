import { and, eq, inArray } from 'drizzle-orm'
import type { AgentId, PlaybookStatus, Task, TaskId, Timestamp } from '@kolonie-ai/core'
import type { Database, Transaction } from '../../client.js'
import { playbooks, tasks } from '../../schema/index.js'

/** What a sponsor's own quest looks like to it: the task, plus why it was refused. */
export interface OwnQuest {
  readonly task: Task
  /** The steward's reason, on a refused quest and nowhere else. */
  readonly rejectionReason: string | null
  /** Whether this quest is still waiting for the moderation stage (`#176`). */
  readonly awaitingModeration: boolean
  /**
   * When the Colony stopped short of publishing a quest it had cleared, or
   * `null` while nothing is holding it (`#759`).
   *
   * **The third answer `pending_review` used to give.** *Being read*, *read and
   * refused* and *read, cleared, and held by us* were one status and one
   * `awaitingModeration: false`, so a sponsor whose quest sat on the audit brake
   * for fourteen hours was shown exactly what a sponsor whose quest arrived a
   * minute ago was shown.
   *
   * A timestamp rather than a boolean, because *how long* is the question a
   * sponsor asks second and the Colony can answer without being asked. What is
   * holding it stays the Colony's business — see the sentence composed in the
   * API, which names no mechanism.
   */
  readonly heldSince: Timestamp | null
  /**
   * The invoice, on a quest waiting to be paid for and nowhere else — D-106
   * (`#504`).
   *
   * **On `OwnQuest` rather than on `Task`, because it is the sponsor's business
   * and nobody else's.** A citizen reading a quest sees what it pays; what the
   * sponsor still owes is a fact about the sponsor. `Task` is the shape both
   * read, so an amount outstanding on it would leak from the one surface to the
   * other by construction.
   */
  readonly invoice?: OwnQuestInvoice
  /**
   * The playbook this quest names, resolved, or absent when it names none
   * (`#1182`).
   *
   * **The id and what it is called, because the id alone is unreadable.** A
   * sponsor reading back its own draft asked for a pipeline by name and would
   * otherwise be handed a uuid to look up itself, which is the shape `#561`
   * records going wrong one field over.
   *
   * Absent rather than null on a quest that names no playbook, matching
   * {@link OwnQuest.invoice}: a key that is there and empty invites a reader to
   * render *no playbook*, and that is a sentence about nothing.
   */
  readonly playbook?: OwnQuestPlaybook
}

/** The playbook a quest names, as much of it as a sponsor needs to recognise it. */
export interface OwnQuestPlaybook {
  readonly id: string
  readonly slug: string
  readonly title: string
  /**
   * What the catalogue says about it now — not what it said when the quest was
   * written.
   *
   * A quest may only name an `open` playbook, and nothing rewrites the reference
   * afterwards, so a sponsor reading a retired one here is reading the truth
   * rather than a stale write.
   */
  readonly status: PlaybookStatus
}

/** What the sponsor still owes on a quest, and until when. */
export interface OwnQuestInvoice {
  readonly lamports: number
  readonly paidLamports: number
  /**
   * When this quest stops waiting and returns to draft (`#760`).
   *
   * **A moment, because the seven days on their own were unusable.** The notice
   * stated a duration and the invoice carried nothing to count it from, so an
   * agent waking inside the window could not tell six days from six hours — and
   * the one thing it needed to decide was whether to pay now or on its next
   * waking.
   *
   * Derived rather than stored: `awaiting_payment_since` plus
   * {@link INVOICE_EXPIRY_DAYS}, which is the arithmetic the expiry pass does,
   * so the date a sponsor reads and the date the sweep acts on cannot drift.
   */
  readonly expiresAt: Timestamp | null
}

/**
 * {@link OwnQuest.heldSince} off the row, for every reader that builds one.
 *
 * One expression rather than seven, because the seven are the shape `#561`
 * records going wrong: a field derived at each construction site is a field that
 * means one thing on the list and another on the detail view.
 */
export function heldSinceOf(row: typeof tasks.$inferSelect): Timestamp | null {
  return row.publicationHeldAt === null ? null : new Date(row.publicationHeldAt).toISOString()
}

/**
 * The playbooks these quests name, in one query.
 *
 * Batched for the reason `unmoderatedIds` is: `listOwnQuests` maps its result
 * over every row a sponsor has ever written, and a lookup per row would be an
 * N+1 that only shows itself once somebody has forty quests.
 *
 * Ids that resolve to nothing are simply absent from the map, which is the
 * answer for a playbook whose row has since been deleted — the column goes null
 * on that, so in practice the gap is unreachable and the map is still the right
 * shape for it.
 */
export async function playbooksNamedBy(
  db: Database | Transaction,
  rows: readonly (typeof tasks.$inferSelect)[],
): Promise<ReadonlyMap<string, OwnQuestPlaybook>> {
  const ids = [...new Set(rows.flatMap((row) => (row.playbookId === null ? [] : [row.playbookId])))]
  if (ids.length === 0) return new Map()

  const found = await db
    .select({
      id: playbooks.id,
      slug: playbooks.slug,
      title: playbooks.title,
      status: playbooks.status,
    })
    .from(playbooks)
    .where(inArray(playbooks.id, ids))

  return new Map(found.map((row) => [row.id, { ...row, status: row.status as PlaybookStatus }]))
}

/** {@link OwnQuest.playbook} off the row and the map, for every reader that builds one. */
export function playbookOf(
  row: typeof tasks.$inferSelect,
  named: ReadonlyMap<string, OwnQuestPlaybook>,
): { readonly playbook: OwnQuestPlaybook } | object {
  if (row.playbookId === null) return {}

  const playbook = named.get(row.playbookId)

  return playbook === undefined ? {} : { playbook }
}

/** One of this account's quests, or why it is not. */
export async function ownQuestRow(
  db: Database | Transaction,
  authorId: AgentId,
  taskId: TaskId,
): Promise<
  | { readonly outcome: 'found'; readonly row: typeof tasks.$inferSelect }
  | { readonly outcome: 'unknown-quest' }
  | { readonly outcome: 'not-yours' }
> {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.kind, 'quest')))
    .limit(1)

  if (row === undefined) return { outcome: 'unknown-quest' }
  if (row.createdBy !== authorId) return { outcome: 'not-yours' }

  return { outcome: 'found', row }
}

/** One answer as the scrub left it. */
export interface ScrubbedAnswer {
  readonly questionKey: string
  readonly text: string
}
