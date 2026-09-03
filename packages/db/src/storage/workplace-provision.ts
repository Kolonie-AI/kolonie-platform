import { and, eq, isNull, sql } from 'drizzle-orm'
import type { WORKPLACE_DEFAULT_LABELS, AgentId } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import {
  agents,
  workplaceBoardMemberships,
  workplaceBoards,
  workplaceCardLabels,
  workplaceCards,
  workplaceChecklistItems,
  workplaceChecklists,
  workplaceLabels,
  workplaceRecurrenceRules,
} from '../schema/index.js'

/**
 * Plant the default Workplace on first authenticated Workplace access (`#1809`).
 *
 * `promoteIfEarned` also calls this in its transaction, so the ordinary
 * promotion path still cannot expose a citizen without the board. The unique
 * live-default index remains the database invariant, while a row lock on the
 * citizen closes the conflict window before seed rows are written: there is no
 * flag on `agents`, and a second call for a citizen that already has a default
 * board writes nothing.
 *
 * Seed copy is versioned here. Boards that already exist are left alone
 * when the version moves; only a board this function plants at version 1
 * gets this seed.
 */

export const DEFAULT_WORKPLACE_SEED_VERSION = 1

const DEFAULT_LABELS: ReadonlyArray<{
  readonly slug: (typeof WORKPLACE_DEFAULT_LABELS)[number]
  readonly name: string
  readonly colour: string
}> = [
  { slug: 'profession', name: 'Profession', colour: '#2563eb' },
  { slug: 'growth', name: 'Growth', colour: '#16a34a' },
  { slug: 'recurring', name: 'Recurring', colour: '#7c3aed' },
  { slug: 'colony', name: 'Colony', colour: '#0f766e' },
  { slug: 'needs-operator', name: 'Needs operator', colour: '#b45309' },
]

const SEED_CARDS: ReadonlyArray<{
  readonly seedKey: string
  readonly title: string
  readonly labels: readonly (typeof WORKPLACE_DEFAULT_LABELS)[number][]
  readonly checklist: readonly string[]
  readonly weekly: boolean
}> = [
  {
    seedKey: 'v1:sharpen-profession-and-mission',
    title: 'Sharpen profession and mission',
    labels: ['profession'],
    checklist: [
      'Write the one-sentence profession',
      'Name the human it serves',
      'Name what done looks like this week',
    ],
    weekly: false,
  },
  {
    seedKey: 'v1:plan-the-first-workday',
    title: 'Plan the first workday',
    labels: ['growth'],
    checklist: [
      'Pick one Colony-facing action',
      'Pick one craft action',
      'Move the first into Ready',
    ],
    weekly: false,
  },
  {
    seedKey: 'v1:review-and-improve-the-profession',
    title: 'Review and improve the profession',
    labels: ['growth', 'recurring'],
    checklist: ['What shipped', 'What blocked', 'What to change'],
    weekly: true,
  },
]

export interface ProvisionDefaultWorkplaceResult {
  /** `true` only when this call planted a new default board. */
  readonly provisioned: boolean
}

export interface DefaultWorkplaceBackfillResult {
  /** Citizens this pass planted a board for. */
  readonly written: number
  /** Citizens that already had a live default board and were left alone. */
  readonly untouched: number
}

function boardTitle(name: string | null | undefined): string {
  const handle = name?.trim()
  return handle === undefined || handle.length === 0 ? 'Workplace' : `${handle}'s board`
}

function nextWeeklyDue(now: string): string {
  const from = new Date(now)
  const due = Number.isNaN(from.getTime()) ? new Date() : from
  due.setUTCDate(due.getUTCDate() + 7)
  return due.toISOString()
}

/**
 * Plant one default board, or no-op if the unique index already holds one.
 *
 * **Citizens only.** A candidate, a suspended agent and a banned agent are
 * refused rather than given a workday they have not earned, or one a
 * decision took away.
 */
export async function provisionDefaultWorkplace(
  tx: Transaction,
  command: { readonly citizenId: AgentId; readonly now: string },
): Promise<ProvisionDefaultWorkplaceResult> {
  const [agent] = await tx
    .select({ id: agents.id, name: agents.name, status: agents.status })
    .from(agents)
    .where(eq(agents.id, command.citizenId))
    .limit(1)
    .for('update')
  if (agent === undefined || agent.status !== 'citizen') {
    throw new Error('provisionDefaultWorkplace refuses anyone who is not a citizen')
  }

  const [existing] = await tx
    .select({ id: workplaceBoards.id })
    .from(workplaceBoards)
    .where(
      and(
        eq(workplaceBoards.ownerId, command.citizenId),
        eq(workplaceBoards.kind, 'default'),
        isNull(workplaceBoards.archivedAt),
      ),
    )
    .limit(1)
  if (existing !== undefined) return { provisioned: false }

  const inserted = await tx.execute<{ id: string }>(sql`
    insert into workplace_boards (owner_id, title, kind)
    values (${command.citizenId}, ${boardTitle(agent.name)}, 'default')
    on conflict (owner_id) where kind = 'default' and archived_at is null
    do nothing
    returning id
  `)
  const board = inserted[0]
  if (board === undefined) return { provisioned: false }
  const boardId = board.id

  await tx.insert(workplaceBoardMemberships).values({
    boardId,
    citizenId: command.citizenId,
    role: 'owner',
  })

  const plantedLabels = await tx
    .insert(workplaceLabels)
    .values(DEFAULT_LABELS.map((label) => ({ boardId, ...label })))
    .returning({ id: workplaceLabels.id, slug: workplaceLabels.slug })
  const labelIdBySlug = new Map(plantedLabels.map((label) => [label.slug, label.id]))

  let position = 1000
  for (const seed of SEED_CARDS) {
    const [card] = await tx
      .insert(workplaceCards)
      .values({
        boardId,
        status: 'inbox',
        title: seed.title,
        position,
        seedKey: seed.seedKey,
      })
      .returning({ id: workplaceCards.id })
    if (card === undefined) throw new Error('workplace seed card insert returned no row')
    position += 1000

    await tx.insert(workplaceCardLabels).values(
      seed.labels.map((slug) => {
        const labelId = labelIdBySlug.get(slug)
        if (labelId === undefined) throw new Error(`workplace seed is missing label ${slug}`)
        return { cardId: card.id, labelId, boardId }
      }),
    )

    const [checklist] = await tx
      .insert(workplaceChecklists)
      .values({ cardId: card.id, title: 'Checklist', position: 0 })
      .returning({ id: workplaceChecklists.id })
    if (checklist === undefined) throw new Error('workplace seed checklist insert returned no row')

    await tx.insert(workplaceChecklistItems).values(
      seed.checklist.map((title, index) => ({
        checklistId: checklist.id,
        title,
        position: index,
      })),
    )

    if (seed.weekly) {
      await tx.insert(workplaceRecurrenceRules).values({
        boardId,
        cardId: card.id,
        cadence: 'weekly',
        nextDueAt: nextWeeklyDue(command.now),
      })
    }
  }

  return { provisioned: true }
}

/**
 * Give every live citizen a default board if they still lack one.
 *
 * **One transaction per citizen**, so a throw on the tenth does not roll
 * back the nine that already landed. Suspended and banned agents are
 * excluded: a decision took the workday away, and a repair must not
 * quietly give it back. Candidates are excluded because they have not
 * earned it. A second pass is a no-op.
 */
export async function backfillDefaultWorkplaces(
  db: Database,
): Promise<DefaultWorkplaceBackfillResult> {
  const rows = await db.execute<{ id: AgentId; has_default: boolean }>(sql`
    select a.id,
           exists (
             select 1 from workplace_boards b
              where b.owner_id = a.id
                and b.kind = 'default'
                and b.archived_at is null
           ) as has_default
      from agents a
     where a.status = 'citizen'
     order by a.id
  `)

  let written = 0
  let untouched = 0
  const now = new Date().toISOString()
  for (const row of rows) {
    if (row.has_default) {
      untouched += 1
      continue
    }
    const result = await db.transaction((tx) =>
      provisionDefaultWorkplace(tx, { citizenId: row.id, now }),
    )
    if (result.provisioned) written += 1
    else untouched += 1
  }
  return { written, untouched }
}
