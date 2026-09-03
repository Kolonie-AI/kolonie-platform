import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm'
import {
  AgentIdSchema,
  DEFAULT_PAGE_SIZE,
  EMPTY_WORKPLACE_LINK_COUNTS,
  MAX_PAGE_SIZE,
  WorkplaceBoardIdSchema,
  WorkplaceBoardSchema,
  WORKPLACE_PRACTICUM_CARD_TITLES,
  WORKPLACE_PRACTICUM_EVENTS,
  WorkplacePracticumEventNameSchema,
  WorkplacePracticumResultSchema,
  WorkplaceCadenceSchema,
  WorkplaceCardIdSchema,
  WorkplaceCardLinkSchema,
  WorkplaceCardSchema,
  WorkplaceChecklistItemSchema,
  WorkplaceChecklistSchema,
  WorkplaceCommentSchema,
  WorkplaceHandoverSchema,
  WorkplaceLabelSchema,
  WorkplaceLaneSchema,
  WorkplaceCardSummarySchema,
  WorkplaceResolvedLinkSchema,
  PlaybookStatusSchema,
  canTransitionWorkplace,
  handoverAllowed,
  mustHaveOwner,
  workplaceNextPeriodStart,
  workplacePeriodStart,
  type AgentId,
  type WorkplaceBoard,
  type WorkplaceCard,
  type WorkplaceCardDetail,
  type WorkplaceCardLink,
  type WorkplaceCardSummary,
  type WorkplaceChecklist,
  type WorkplaceChecklistItem,
  type WorkplaceComment,
  type WorkplaceHandover,
  type WorkplaceLabel,
  type WorkplaceLane,
  type WorkplaceLinkCounts,
  type WorkplacePracticumCycle,
  type WorkplacePracticumEvidenceKind,
  type WorkplaceClosePracticumRequest,
  type WorkplacePracticumEventName,
  type WorkplacePracticumResult,
  type WorkplacePracticumRetrospective,
  type WorkplaceLinkKind,
  type WorkplaceLinkTarget,
  type WorkplaceMembership,
  type WorkplaceResolvedLink,
  type WakeupWorkplace,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import {
  accounts,
  agents,
  playbooks,
  providerRecipes,
  tasks,
  workplaceBoardMemberships,
  workplaceBoards,
  workplaceCardLabels,
  workplaceCardLinks,
  workplaceCards,
  workplaceChecklists,
  workplaceChecklistItems,
  workplaceActivity,
  workplaceComments,
  workplaceHandovers,
  workplaceIdempotency,
  workplaceLabels,
  workplacePracticumEvents,
  workplaceRecurrenceOccurrences,
  workplaceRecurrenceRules,
} from '../schema/index.js'
import { isUniqueViolation, isUuid } from './errors.js'
import { toTimestamp } from './rows.js'
import { provisionDefaultWorkplace } from './workplace-provision.js'
import { vaultHoldsKey } from './vault.js'

/**
 * Reading and writing Workplace boards (`#1757`).
 *
 * **Scoped storage is the V1 ACL.** Every read and write takes a caller and
 * joins membership (or, for a board the caller owns, the owner column). A
 * missing board and a board the caller is not on are the same answer, so a
 * stranger cannot probe for ids. RLS is a later hardening, not this module.
 *
 * Policy lives in `@kolonie-ai/core`. This file persists it: one-statement
 * claims, version bumps, the six-lane checks restated where a repair script
 * would otherwise skip them.
 */

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const RANK_GAP = 1000
const PRACTICUM_PREFIX = 'practicum:'

export type WorkplaceUnknown = { readonly outcome: 'unknown' }
export type WorkplaceMissing = { readonly outcome: 'missing' }
export type WorkplaceForbidden = { readonly outcome: 'forbidden' }
export type WorkplaceEmpty = { readonly outcome: 'empty' }
export type WorkplaceStale = { readonly outcome: 'stale' }
export type WorkplaceConflict = { readonly outcome: 'conflict' }
export type WorkplaceInvalidTransition = { readonly outcome: 'invalid-transition' }
export type WorkplaceHandoverRequired = { readonly outcome: 'handover-required' }
export type WorkplaceDefaultProtected = { readonly outcome: 'default-board-protected' }
export type WorkplaceUnknownCitizen = { readonly outcome: 'unknown-citizen' }

function toBoard(row: typeof workplaceBoards.$inferSelect): WorkplaceBoard {
  return WorkplaceBoardSchema.parse({
    id: row.id,
    ownerId: row.ownerId,
    title: row.title,
    kind: row.kind,
    archivedAt: row.archivedAt === null ? null : toTimestamp(row.archivedAt),
    version: row.version,
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.updatedAt),
  })
}

function toCard(row: typeof workplaceCards.$inferSelect): WorkplaceCard {
  return WorkplaceCardSchema.parse({
    id: row.id,
    boardId: row.boardId,
    status: row.status,
    title: row.title,
    description: row.description,
    ownerId: row.ownerId,
    position: Number(row.position),
    priority: row.priority,
    dueAt: row.dueAt === null ? null : toTimestamp(row.dueAt),
    blockedBy: row.blockedBy,
    unblockWhen: row.unblockWhen,
    outcome: row.outcome,
    version: row.version,
    coverColour: row.coverColour,
    seedKey: row.seedKey,
    archivedAt: row.archivedAt === null ? null : toTimestamp(row.archivedAt),
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.updatedAt),
  })
}

function toSummary(
  card: WorkplaceCard,
  counts: {
    readonly labels: number
    readonly checklists: number
    readonly comments: number
    readonly links: WorkplaceLinkCounts
  },
): WorkplaceCardSummary {
  return WorkplaceCardSummarySchema.parse({
    id: card.id,
    boardId: card.boardId,
    status: card.status,
    title: card.title,
    ownerId: card.ownerId,
    position: card.position,
    priority: card.priority,
    dueAt: card.dueAt,
    version: card.version,
    coverColour: card.coverColour ?? null,
    labelCount: counts.labels,
    checklistCount: counts.checklists,
    commentCount: counts.comments,
    linkCount:
      counts.links.account +
      counts.links.provider +
      counts.links.vault +
      counts.links.task +
      counts.links.playbook +
      counts.links.url,
    linkCounts: counts.links,
  })
}

function toCardLink(row: typeof workplaceCardLinks.$inferSelect): WorkplaceCardLink {
  return WorkplaceCardLinkSchema.parse({
    id: row.id,
    cardId: row.cardId,
    kind: row.kind,
    ref: row.ref,
    ...(row.note === null ? {} : { note: row.note }),
  })
}

function unresolvable(kind: WorkplaceLinkKind): WorkplaceLinkTarget {
  return { state: 'unresolvable', kind }
}

async function resolveOneLink(
  db: Database | Transaction,
  callerId: AgentId,
  row: typeof workplaceCardLinks.$inferSelect,
): Promise<WorkplaceResolvedLink> {
  const stored = toCardLink(row)
  const kind = stored.kind
  let target: WorkplaceLinkTarget = unresolvable(kind)

  if (kind === 'account') {
    if (isUuid(stored.ref)) {
      const [own] = await db
        .select({
          provider: accounts.provider,
          identifier: accounts.identifier,
          proved: accounts.proved,
        })
        .from(accounts)
        .where(and(eq(accounts.id, stored.ref), eq(accounts.agentId, callerId)))
        .limit(1)
      if (own !== undefined) {
        target = {
          state: 'resolved',
          kind: 'account',
          provider: own.provider,
          identifier: own.identifier,
          proved: own.proved,
        }
      }
    }
  } else if (kind === 'provider') {
    const [recipe] = await db
      .select({ title: providerRecipes.title, category: providerRecipes.category })
      .from(providerRecipes)
      .where(eq(providerRecipes.provider, stored.ref))
      .limit(1)
    if (recipe !== undefined) {
      target = {
        state: 'resolved',
        kind: 'provider',
        title: recipe.title,
        category: recipe.category,
      }
    }
  } else if (kind === 'vault') {
    target = {
      state: 'resolved',
      kind: 'vault',
      name: stored.ref,
      held: await vaultHoldsKey(db, callerId, stored.ref),
    }
  } else if (kind === 'task') {
    if (isUuid(stored.ref)) {
      const [task] = await db
        .select({ title: tasks.title, status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, stored.ref))
        .limit(1)
      if (task !== undefined) {
        target = { state: 'resolved', kind: 'task', title: task.title, status: task.status }
      }
    }
  } else if (kind === 'playbook') {
    if (isUuid(stored.ref)) {
      const [playbook] = await db
        .select({ title: playbooks.title, status: playbooks.status })
        .from(playbooks)
        .where(eq(playbooks.id, stored.ref))
        .limit(1)
      if (playbook !== undefined) {
        const status = PlaybookStatusSchema.safeParse(playbook.status)
        if (status.success) {
          target = {
            state: 'resolved',
            kind: 'playbook',
            title: playbook.title,
            status: status.data,
          }
        }
      }
    }
  } else {
    target = { state: 'resolved', kind: 'url' }
  }

  return WorkplaceResolvedLinkSchema.parse({ ...stored, target })
}

async function resolveLinks(
  db: Database | Transaction,
  callerId: AgentId,
  rows: readonly (typeof workplaceCardLinks.$inferSelect)[],
): Promise<readonly WorkplaceResolvedLink[]> {
  const resolved: WorkplaceResolvedLink[] = []
  for (const row of rows) {
    resolved.push(await resolveOneLink(db, callerId, row))
  }
  return resolved
}

async function linkTargetExists(
  db: Transaction,
  boardOwnerId: AgentId,
  kind: WorkplaceLinkKind,
  ref: string,
): Promise<boolean> {
  if (kind === 'url') return true
  if (kind === 'vault') return vaultHoldsKey(db, boardOwnerId, ref)
  if (kind === 'provider') {
    const [row] = await db
      .select({ id: providerRecipes.id })
      .from(providerRecipes)
      .where(eq(providerRecipes.provider, ref))
      .limit(1)
    return row !== undefined
  }
  if (!isUuid(ref)) return false
  if (kind === 'account') {
    const [row] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, ref), eq(accounts.agentId, boardOwnerId)))
      .limit(1)
    return row !== undefined
  }
  if (kind === 'task') {
    const [row] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, ref)).limit(1)
    return row !== undefined
  }
  const [row] = await db
    .select({ id: playbooks.id })
    .from(playbooks)
    .where(eq(playbooks.id, ref))
    .limit(1)
  return row !== undefined
}

function mayWriteLink(
  membership: WorkplaceMembership,
  card: typeof workplaceCards.$inferSelect,
  callerId: AgentId,
): boolean {
  return membership.role === 'owner' || card.ownerId === callerId
}

function toHandover(row: typeof workplaceHandovers.$inferSelect): WorkplaceHandover {
  return WorkplaceHandoverSchema.parse({
    id: row.id,
    cardId: row.cardId,
    from: row.fromId,
    to: row.toId,
    done: row.done,
    learned: row.learned,
    next: row.next,
    blocked: row.blocked,
    evidenceLinks: row.evidenceLinks,
    isCurrent: row.isCurrent,
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.updatedAt),
  })
}

function toMembership(row: typeof workplaceBoardMemberships.$inferSelect): WorkplaceMembership {
  return {
    boardId: WorkplaceBoardIdSchema.parse(row.boardId),
    citizenId: AgentIdSchema.parse(row.citizenId),
    role: row.role === 'owner' ? 'owner' : 'member',
  }
}

async function membershipOf(
  db: Database | Transaction,
  callerId: AgentId,
  boardId: string,
): Promise<WorkplaceMembership | null> {
  const [row] = await db
    .select()
    .from(workplaceBoardMemberships)
    .where(
      and(
        eq(workplaceBoardMemberships.boardId, boardId),
        eq(workplaceBoardMemberships.citizenId, callerId),
      ),
    )
    .limit(1)
  return row === undefined ? null : toMembership(row)
}

async function visibleBoard(
  db: Database | Transaction,
  callerId: AgentId,
  boardId: string,
): Promise<typeof workplaceBoards.$inferSelect | null> {
  if (!isUuid(boardId)) return null
  const [row] = await db
    .select({ board: workplaceBoards })
    .from(workplaceBoards)
    .innerJoin(
      workplaceBoardMemberships,
      and(
        eq(workplaceBoardMemberships.boardId, workplaceBoards.id),
        eq(workplaceBoardMemberships.citizenId, callerId),
      ),
    )
    .where(eq(workplaceBoards.id, boardId))
    .limit(1)
  return row?.board ?? null
}

async function visibleCard(
  db: Database | Transaction,
  callerId: AgentId,
  cardId: string,
): Promise<typeof workplaceCards.$inferSelect | null> {
  if (!isUuid(cardId)) return null
  const [row] = await db
    .select({ card: workplaceCards })
    .from(workplaceCards)
    .innerJoin(
      workplaceBoardMemberships,
      and(
        eq(workplaceBoardMemberships.boardId, workplaceCards.boardId),
        eq(workplaceBoardMemberships.citizenId, callerId),
      ),
    )
    .where(eq(workplaceCards.id, cardId))
    .limit(1)
  return row?.card ?? null
}

/**
 * Membership in the write statement, not a pre-read. Under READ COMMITTED a
 * `visibleCard` check can succeed and the membership then vanish before the
 * UPDATE lands; putting the join in `WHERE` is what closes that.
 */
function callerIsMember(callerId: AgentId) {
  return sql`exists (select 1 from workplace_board_memberships m
        where m.board_id = ${workplaceCards.boardId}
          and m.citizen_id = ${callerId})`
}

/**
 * Lock the card, then the caller's membership, then decide. An EXISTS in the
 * UPDATE `WHERE` is not enough: EvalPlanQual rechecks the target row after a
 * wait and does not reliably re-run that subquery, so a membership deleted
 * while we waited would still match. Taking the card lock first means the
 * membership read sees whatever committed during the wait.
 */
async function lockCardForWrite(
  tx: Transaction,
  callerId: AgentId,
  cardId: string,
): Promise<
  | { readonly outcome: 'ok'; readonly card: typeof workplaceCards.$inferSelect }
  | WorkplaceMissing
  | WorkplaceForbidden
> {
  if (!isUuid(cardId)) return { outcome: 'missing' }
  const [card] = await tx
    .select()
    .from(workplaceCards)
    .where(eq(workplaceCards.id, cardId))
    .for('update')
  if (card === undefined) return { outcome: 'missing' }
  const [member] = await tx
    .select({ citizenId: workplaceBoardMemberships.citizenId })
    .from(workplaceBoardMemberships)
    .where(
      and(
        eq(workplaceBoardMemberships.boardId, card.boardId),
        eq(workplaceBoardMemberships.citizenId, callerId),
      ),
    )
    .for('update')
    .limit(1)
  if (member === undefined) return { outcome: 'forbidden' }
  return { outcome: 'ok', card }
}

async function diagnoseCardWrite(
  db: Database | Transaction,
  callerId: AgentId,
  cardId: string,
): Promise<WorkplaceMissing | WorkplaceForbidden | WorkplaceStale> {
  if (!isUuid(cardId)) return { outcome: 'missing' }
  const [card] = await db
    .select({ id: workplaceCards.id, boardId: workplaceCards.boardId })
    .from(workplaceCards)
    .where(eq(workplaceCards.id, cardId))
    .limit(1)
  if (card === undefined) return { outcome: 'missing' }
  if ((await membershipOf(db, callerId, card.boardId)) === null) return { outcome: 'forbidden' }
  return { outcome: 'stale' }
}

async function boardWriteAccess(
  db: Database | Transaction,
  callerId: AgentId,
  boardId: string,
): Promise<
  | {
      readonly outcome: 'ok'
      readonly board: typeof workplaceBoards.$inferSelect
      readonly membership: WorkplaceMembership
    }
  | WorkplaceMissing
  | WorkplaceForbidden
> {
  if (!isUuid(boardId)) return { outcome: 'missing' }
  const [board] = await db
    .select()
    .from(workplaceBoards)
    .where(eq(workplaceBoards.id, boardId))
    .limit(1)
  if (board === undefined) return { outcome: 'missing' }
  const membership = await membershipOf(db, callerId, boardId)
  if (membership === null) return { outcome: 'forbidden' }
  return { outcome: 'ok', board, membership }
}

export async function getBoardFor(
  db: Database,
  callerId: AgentId,
  boardId: string,
): Promise<WorkplaceBoard | null> {
  const row = await visibleBoard(db, callerId, boardId)
  return row === null ? null : toBoard(row)
}

/**
 * The agent behind a handle, or nothing (`#1759`).
 *
 * **`lower(name)`**, matching `agents_name_unique`. HTTP add-member takes a
 * uuid or a handle in one field; this is the handle half. An unknown handle
 * and an erased citizen are the same miss — the row is gone either way.
 */
export async function agentIdByHandle(db: Database, handle: string): Promise<AgentId | undefined> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(sql`lower(${agents.name}) = lower(${handle})`)
    .limit(1)
  return row === undefined ? undefined : AgentIdSchema.parse(row.id)
}

type BoardCursor = { readonly createdAt: string; readonly id: string }

function encodeBoardCursor(row: typeof workplaceBoards.$inferSelect): string {
  return Buffer.from(`${row.createdAt}|${row.id}`, 'utf8').toString('base64url')
}

function decodeBoardCursor(cursor: string | null | undefined): BoardCursor | undefined | 'invalid' {
  if (cursor === undefined || cursor === null || cursor === '') return undefined
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  if (parts.length !== 2) return 'invalid'
  const [createdAt, id] = parts as [string, string]
  if (createdAt === '' || !WorkplaceBoardIdSchema.safeParse(id).success) return 'invalid'
  return { createdAt, id }
}

export type ListBoardsResult =
  | {
      readonly outcome: 'listed'
      readonly items: readonly WorkplaceBoard[]
      readonly nextCursor: string | null
    }
  | { readonly outcome: 'invalid-cursor' }

/**
 * List memberships after planting the subject citizen's default board.
 *
 * The provision and read share one transaction so a successful first list
 * cannot expose the pre-provision empty state. Delegated access passes the
 * subject as `callerId`, and the unique live-default index converges it with
 * a simultaneous list by the citizen.
 */
export async function listBoardsFor(
  db: Database,
  callerId: AgentId,
  query: { readonly cursor?: string | null; readonly limit?: number } = {},
): Promise<ListBoardsResult> {
  const after = decodeBoardCursor(query.cursor)
  if (after === 'invalid') return { outcome: 'invalid-cursor' }
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)

  return db.transaction(async (tx) => {
    const [caller] = await tx
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, callerId))
      .limit(1)
    if (caller?.status === 'citizen') {
      await provisionDefaultWorkplace(tx, {
        citizenId: callerId,
        now: new Date().toISOString(),
      })
    }

    const rows = await tx
      .select({ board: workplaceBoards })
      .from(workplaceBoards)
      .innerJoin(
        workplaceBoardMemberships,
        and(
          eq(workplaceBoardMemberships.boardId, workplaceBoards.id),
          eq(workplaceBoardMemberships.citizenId, callerId),
        ),
      )
      .where(
        after === undefined
          ? undefined
          : sql`(${workplaceBoards.createdAt}, ${workplaceBoards.id}) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
      )
      .orderBy(workplaceBoards.createdAt, workplaceBoards.id)
      .limit(limit + 1)

    const page = rows.slice(0, limit).map((row) => toBoard(row.board))
    return {
      outcome: 'listed',
      items: page,
      nextCursor: rows.length > limit ? encodeBoardCursor(rows[limit - 1]!.board) : null,
    }
  })
}

export async function workplaceWakeup(
  db: Database,
  callerId: AgentId,
): Promise<WakeupWorkplace | undefined> {
  const [board] = await db
    .select({ id: workplaceBoards.id })
    .from(workplaceBoards)
    .innerJoin(agents, eq(agents.id, workplaceBoards.ownerId))
    .where(
      and(
        eq(agents.status, 'citizen'),
        eq(workplaceBoards.ownerId, callerId),
        eq(workplaceBoards.kind, 'default'),
        isNull(workplaceBoards.archivedAt),
      ),
    )
    .limit(1)
  if (board === undefined) return undefined

  const [activePracticum] = await db
    .select({ id: workplaceCards.id })
    .from(workplaceCards)
    .where(
      and(
        eq(workplaceCards.boardId, board.id),
        isNull(workplaceCards.archivedAt),
        sql`${workplaceCards.seedKey} like ${`${PRACTICUM_PREFIX}%`}`,
        sql`${workplaceCards.seedKey} not like ${`${PRACTICUM_PREFIX}%${PRACTICUM_CLOSED}%`}`,
      ),
    )
    .limit(1)

  const [terminalPracticum] = await db
    .select({ seedKey: workplaceCards.seedKey })
    .from(workplaceCards)
    .where(
      and(
        eq(workplaceCards.boardId, board.id),
        isNull(workplaceCards.archivedAt),
        sql`${workplaceCards.seedKey} like ${`${PRACTICUM_PREFIX}%${PRACTICUM_CLOSED}%`}`,
        sql`${workplaceCards.seedKey} not like ${`${PRACTICUM_PREFIX}%${PRACTICUM_CLOSED}%#d`}`,
        sql`${workplaceCards.seedKey} not like ${`${PRACTICUM_PREFIX}%${PRACTICUM_CLOSED}%#e`}`,
      ),
    )
    .orderBy(sql`${workplaceCards.updatedAt} desc`)
    .limit(1)

  let practicumRetrospective: WorkplacePracticumRetrospective | undefined
  if (terminalPracticum?.seedKey !== null && terminalPracticum?.seedKey !== undefined) {
    const [cycleId, tail] = terminalPracticum.seedKey.split(PRACTICUM_CLOSED)
    const result = tail === undefined ? undefined : PRACTICUM_RESULT_BY_CODE.get(tail.slice(0, 1))
    if (cycleId !== undefined && result !== undefined) {
      practicumRetrospective = practicumRetrospectiveFor(cycleId, result)
    }
  }

  const rank = sql<number>`case
    when ${workplaceCards.status} = 'in_progress' and ${workplaceCards.ownerId} = ${callerId} then 0
    when ${workplaceCards.status} = 'ready' then 1
    when ${workplaceCards.status} = 'blocked' and ${workplaceCards.ownerId} = ${callerId} then 2
    when ${workplaceCards.status} = 'inbox' and ${workplaceCards.seedKey} like ${`${PRACTICUM_PREFIX}%`} then 3
    else 4
  end`
  const cards = await db
    .select({
      id: workplaceCards.id,
      title: workplaceCards.title,
      status: workplaceCards.status,
      ownerId: workplaceCards.ownerId,
      seedKey: workplaceCards.seedKey,
      position: workplaceCards.position,
      createdAt: workplaceCards.createdAt,
    })
    .from(workplaceCards)
    .where(
      and(
        eq(workplaceCards.boardId, board.id),
        isNull(workplaceCards.archivedAt),
        or(
          and(eq(workplaceCards.status, 'in_progress'), eq(workplaceCards.ownerId, callerId)),
          eq(workplaceCards.status, 'ready'),
          and(eq(workplaceCards.status, 'blocked'), eq(workplaceCards.ownerId, callerId)),
          and(eq(workplaceCards.status, 'inbox'), sql`${workplaceCards.seedKey} is not null`),
        ),
      ),
    )
    .orderBy(rank, workplaceCards.createdAt, workplaceCards.position, workplaceCards.id)
    .limit(5)

  const first = cards[0]
  return {
    boardId: WorkplaceBoardIdSchema.parse(board.id),
    practicumActive: activePracticum !== undefined,
    ...(practicumRetrospective === undefined || activePracticum !== undefined
      ? {}
      : { practicumRetrospective }),
    recommendation:
      first === undefined
        ? null
        : {
            cardId: WorkplaceCardIdSchema.parse(first.id),
            title: first.title,
            status: WorkplaceLaneSchema.parse(first.status),
            next: {
              tool: 'kolonie.workplace',
              arguments: { act: 'get', subject: 'card', id: first.id },
            },
          },
    more: cards
      .slice(1, 5)
      .filter(
        (card) =>
          card.status === 'ready' || card.status === 'in_progress' || card.status === 'blocked',
      )
      .map((card) => ({
        cardId: WorkplaceCardIdSchema.parse(card.id),
        status: WorkplaceLaneSchema.parse(card.status),
      })),
  }
}

export async function createBoard(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly title: string
    readonly idempotencyKey?: string
  },
): Promise<WorkplaceBoard> {
  return db.transaction(async (tx) => {
    const stored = await replayOrStore(tx, {
      callerId: input.callerId,
      idempotencyKey: input.idempotencyKey,
      run: async () => {
        const [board] = await tx
          .insert(workplaceBoards)
          .values({ ownerId: input.callerId, title: input.title, kind: 'additional' })
          .returning()
        if (board === undefined) throw new Error('workplace board insert returned no row')
        await tx.insert(workplaceBoardMemberships).values({
          boardId: board.id,
          citizenId: input.callerId,
          role: 'owner',
        })
        return toBoard(board)
      },
    })
    if (typeof stored === 'object' && stored !== null && 'replayed' in stored) {
      return WorkplaceBoardSchema.parse(stored.value)
    }
    return stored
  })
}

/**
 * Plant a default board. `#1758` is the provisioner; this is the write it
 * needs, kept here so the unique partial index is the only special case and
 * HTTP never talks to the table.
 */
export async function createDefaultBoard(
  db: Database,
  input: { readonly callerId: AgentId; readonly title: string },
): Promise<WorkplaceBoard> {
  return db.transaction(async (tx) => {
    const [board] = await tx
      .insert(workplaceBoards)
      .values({ ownerId: input.callerId, title: input.title, kind: 'default' })
      .returning()
    if (board === undefined) throw new Error('workplace default board insert returned no row')
    await tx.insert(workplaceBoardMemberships).values({
      boardId: board.id,
      citizenId: input.callerId,
      role: 'owner',
    })
    return toBoard(board)
  })
}

export type RenameBoardResult =
  | { readonly outcome: 'renamed'; readonly board: WorkplaceBoard }
  | WorkplaceMissing
  | WorkplaceForbidden
  | WorkplaceStale

export async function renameBoard(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly boardId: string
    readonly title: string
    readonly expectedVersion: number
  },
): Promise<RenameBoardResult> {
  const access = await boardWriteAccess(db, input.callerId, input.boardId)
  if (access.outcome !== 'ok') return access
  if (access.membership.role !== 'owner') return { outcome: 'forbidden' }

  const [row] = await db
    .update(workplaceBoards)
    .set({
      title: input.title,
      version: sql`${workplaceBoards.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(workplaceBoards.id, input.boardId),
        eq(workplaceBoards.version, input.expectedVersion),
      ),
    )
    .returning()
  if (row === undefined) return { outcome: 'stale' }
  return { outcome: 'renamed', board: toBoard(row) }
}

export type ListMembersResult =
  | { readonly outcome: 'listed'; readonly members: readonly WorkplaceMembership[] }
  | WorkplaceUnknown

export async function listMembers(
  db: Database,
  callerId: AgentId,
  boardId: string,
): Promise<ListMembersResult> {
  const board = await visibleBoard(db, callerId, boardId)
  if (board === null) return { outcome: 'unknown' }
  const rows = await db
    .select()
    .from(workplaceBoardMemberships)
    .where(eq(workplaceBoardMemberships.boardId, boardId))
    .orderBy(workplaceBoardMemberships.role, workplaceBoardMemberships.citizenId)
  return { outcome: 'listed', members: rows.map(toMembership) }
}

export type ArchiveBoardResult =
  | { readonly outcome: 'archived'; readonly board: WorkplaceBoard }
  | WorkplaceMissing
  | WorkplaceForbidden
  | WorkplaceDefaultProtected
  | WorkplaceStale

export async function archiveBoard(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly boardId: string
    readonly expectedVersion: number
  },
): Promise<ArchiveBoardResult> {
  const access = await boardWriteAccess(db, input.callerId, input.boardId)
  if (access.outcome !== 'ok') return access
  if (access.membership.role !== 'owner') return { outcome: 'forbidden' }
  if (access.board.kind === 'default') return { outcome: 'default-board-protected' }

  const [row] = await db
    .update(workplaceBoards)
    .set({
      archivedAt: sql`now()`,
      version: sql`${workplaceBoards.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(workplaceBoards.id, input.boardId),
        eq(workplaceBoards.version, input.expectedVersion),
      ),
    )
    .returning()
  if (row === undefined) return { outcome: 'stale' }
  return { outcome: 'archived', board: toBoard(row) }
}

export type AddMemberResult =
  | { readonly outcome: 'added'; readonly membership: WorkplaceMembership }
  | WorkplaceMissing
  | WorkplaceForbidden
  | WorkplaceUnknownCitizen

export async function addMember(
  db: Database,
  input: { readonly callerId: AgentId; readonly boardId: string; readonly citizenId: string },
): Promise<AddMemberResult> {
  const access = await boardWriteAccess(db, input.callerId, input.boardId)
  if (access.outcome !== 'ok') return access
  if (access.membership.role !== 'owner') return { outcome: 'forbidden' }
  if (!isUuid(input.citizenId)) return { outcome: 'unknown-citizen' }
  const citizenId = AgentIdSchema.safeParse(input.citizenId)
  if (!citizenId.success) return { outcome: 'unknown-citizen' }

  const [exists] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, citizenId.data))
    .limit(1)
  if (exists === undefined) return { outcome: 'unknown-citizen' }

  const [row] = await db
    .insert(workplaceBoardMemberships)
    .values({ boardId: input.boardId, citizenId: citizenId.data, role: 'member' })
    .onConflictDoNothing()
    .returning()
  if (row === undefined) {
    const already = await membershipOf(db, citizenId.data, input.boardId)
    if (already === null) return { outcome: 'missing' }
    return { outcome: 'added', membership: already }
  }
  return { outcome: 'added', membership: toMembership(row) }
}

export type RemoveMemberResult =
  | { readonly outcome: 'removed' }
  | WorkplaceMissing
  | WorkplaceForbidden
  | WorkplaceDefaultProtected
  | WorkplaceHandoverRequired

export async function removeMember(
  db: Database,
  input: { readonly callerId: AgentId; readonly boardId: string; readonly citizenId: string },
): Promise<RemoveMemberResult> {
  const access = await boardWriteAccess(db, input.callerId, input.boardId)
  if (access.outcome !== 'ok') return access
  if (access.membership.role !== 'owner') return { outcome: 'forbidden' }
  if (!isUuid(input.citizenId)) return { outcome: 'missing' }

  const target = await membershipOf(db, AgentIdSchema.parse(input.citizenId), input.boardId)
  if (target === null) return { outcome: 'missing' }
  if (target.role === 'owner') return { outcome: 'default-board-protected' }

  const held = await db
    .select({ id: workplaceCards.id })
    .from(workplaceCards)
    .where(
      and(
        eq(workplaceCards.boardId, input.boardId),
        eq(workplaceCards.ownerId, input.citizenId),
        inArray(workplaceCards.status, ['in_progress', 'blocked', 'review']),
        isNull(workplaceCards.archivedAt),
      ),
    )
    .limit(1)
  if (held.length > 0) return { outcome: 'handover-required' }

  await db
    .delete(workplaceBoardMemberships)
    .where(
      and(
        eq(workplaceBoardMemberships.boardId, input.boardId),
        eq(workplaceBoardMemberships.citizenId, input.citizenId),
      ),
    )
  return { outcome: 'removed' }
}

type CardCursor = { readonly status: string; readonly position: number; readonly id: string }

function encodeCardCursor(row: typeof workplaceCards.$inferSelect): string {
  return Buffer.from(`${row.status}|${row.position}|${row.id}`, 'utf8').toString('base64url')
}

function decodeCardCursor(cursor: string | null | undefined): CardCursor | undefined | 'invalid' {
  if (cursor === undefined || cursor === null || cursor === '') return undefined
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  if (parts.length !== 3) return 'invalid'
  const [status, rawPosition, id] = parts as [string, string, string]
  if (!WorkplaceLaneSchema.safeParse(status).success) return 'invalid'
  const position = Number(rawPosition)
  if (!Number.isFinite(position)) return 'invalid'
  if (!WorkplaceCardIdSchema.safeParse(id).success) return 'invalid'
  return { status, position, id }
}

export type ListCardsResult =
  | {
      readonly outcome: 'listed'
      readonly items: readonly WorkplaceCardSummary[]
      readonly nextCursor: string | null
    }
  | WorkplaceEmpty
  | { readonly outcome: 'invalid-cursor' }
  | WorkplaceUnknown

export async function listCards(
  db: Database,
  callerId: AgentId,
  boardId: string,
  query: {
    readonly status?: WorkplaceLane
    readonly cursor?: string | null
    readonly limit?: number
  } = {},
): Promise<ListCardsResult> {
  const board = await visibleBoard(db, callerId, boardId)
  if (board === null) return { outcome: 'unknown' }
  const after = decodeCardCursor(query.cursor)
  if (after === 'invalid') return { outcome: 'invalid-cursor' }
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)

  const conditions = [
    eq(workplaceCards.boardId, boardId),
    isNull(workplaceCards.archivedAt),
    ...(query.status === undefined ? [] : [eq(workplaceCards.status, query.status)]),
    ...(after === undefined
      ? []
      : [
          sql`(${workplaceCards.status}, ${workplaceCards.position}, ${workplaceCards.id}) > (${after.status}, ${after.position}::double precision, ${after.id}::uuid)`,
        ]),
  ]

  const rows = await db
    .select()
    .from(workplaceCards)
    .where(and(...conditions))
    .orderBy(workplaceCards.status, workplaceCards.position, workplaceCards.id)
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const ids = page.map((row) => row.id)
  const counts =
    ids.length === 0
      ? []
      : await db.execute<{
          card_id: string
          labels: string
          checklists: string
          comments: string
          links_account: string
          links_provider: string
          links_vault: string
          links_task: string
          links_playbook: string
          links_url: string
        }>(sql`
          select c.id as card_id,
                 (select count(*)::text from workplace_card_labels l where l.card_id = c.id) as labels,
                 (select count(*)::text from workplace_checklists k where k.card_id = c.id) as checklists,
                 (select count(*)::text from workplace_comments m where m.card_id = c.id) as comments,
                 (select count(*)::text from workplace_card_links x where x.card_id = c.id and x.kind = 'account') as links_account,
                 (select count(*)::text from workplace_card_links x where x.card_id = c.id and x.kind = 'provider') as links_provider,
                 (select count(*)::text from workplace_card_links x where x.card_id = c.id and x.kind = 'vault') as links_vault,
                 (select count(*)::text from workplace_card_links x where x.card_id = c.id and x.kind = 'task') as links_task,
                 (select count(*)::text from workplace_card_links x where x.card_id = c.id and x.kind = 'playbook') as links_playbook,
                 (select count(*)::text from workplace_card_links x where x.card_id = c.id and x.kind = 'url') as links_url
            from workplace_cards c
           where c.id in (${sql.join(
             ids.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})
        `)
  const byId = new Map(counts.map((row) => [row.card_id, row]))

  if (page.length === 0 && after === undefined) return { outcome: 'empty' }

  return {
    outcome: 'listed',
    items: page.map((row) => {
      const extra = byId.get(row.id)
      return toSummary(toCard(row), {
        labels: Number(extra?.labels ?? 0),
        checklists: Number(extra?.checklists ?? 0),
        comments: Number(extra?.comments ?? 0),
        links:
          extra === undefined
            ? EMPTY_WORKPLACE_LINK_COUNTS
            : {
                account: Number(extra.links_account),
                provider: Number(extra.links_provider),
                vault: Number(extra.links_vault),
                task: Number(extra.links_task),
                playbook: Number(extra.links_playbook),
                url: Number(extra.links_url),
              },
      })
    }),
    nextCursor: rows.length > limit ? encodeCardCursor(page[page.length - 1]!) : null,
  }
}

export async function getCard(
  db: Database,
  callerId: AgentId,
  cardId: string,
): Promise<WorkplaceCardDetail | null> {
  const row = await visibleCard(db, callerId, cardId)
  if (row === null) return null

  const [labelRows, checklistRows, commentRows, handoverRows, linkRows] = await Promise.all([
    db
      .select({ label: workplaceLabels })
      .from(workplaceLabels)
      .innerJoin(workplaceCardLabels, eq(workplaceCardLabels.labelId, workplaceLabels.id))
      .where(eq(workplaceCardLabels.cardId, row.id)),
    db.select().from(workplaceChecklists).where(eq(workplaceChecklists.cardId, row.id)),
    db
      .select()
      .from(workplaceComments)
      .where(eq(workplaceComments.cardId, row.id))
      .orderBy(workplaceComments.createdAt),
    db
      .select()
      .from(workplaceHandovers)
      .where(and(eq(workplaceHandovers.cardId, row.id), eq(workplaceHandovers.isCurrent, true)))
      .limit(1),
    db
      .select()
      .from(workplaceCardLinks)
      .where(eq(workplaceCardLinks.cardId, row.id))
      .orderBy(workplaceCardLinks.createdAt, workplaceCardLinks.id),
  ])

  const checklistIds = checklistRows.map((one) => one.id)
  const itemRows =
    checklistIds.length === 0
      ? []
      : await db
          .select()
          .from(workplaceChecklistItems)
          .where(inArray(workplaceChecklistItems.checklistId, checklistIds))

  return {
    card: toCard(row),
    labels: labelRows.map((one) =>
      WorkplaceLabelSchema.parse({
        id: one.label.id,
        boardId: one.label.boardId,
        name: one.label.name,
        colour: one.label.colour,
      }),
    ),
    checklists: checklistRows.map((checklist) => ({
      checklist: WorkplaceChecklistSchema.parse({
        id: checklist.id,
        cardId: checklist.cardId,
        title: checklist.title,
        position: checklist.position,
      }),
      items: itemRows
        .filter((item) => item.checklistId === checklist.id)
        .map((item) =>
          WorkplaceChecklistItemSchema.parse({
            id: item.id,
            checklistId: item.checklistId,
            title: item.title,
            doneAt: item.doneAt === null ? null : toTimestamp(item.doneAt),
            position: item.position,
          }),
        ),
    })),
    comments: commentRows.map((comment) =>
      WorkplaceCommentSchema.parse({
        id: comment.id,
        cardId: comment.cardId,
        authorId: comment.authorId,
        body: comment.body,
        createdAt: toTimestamp(comment.createdAt),
        updatedAt: toTimestamp(comment.updatedAt),
      }),
    ),
    links: [...(await resolveLinks(db, callerId, linkRows))],
    handover: handoverRows[0] === undefined ? null : toHandover(handoverRows[0]),
  }
}

async function nextPosition(
  db: Database | Transaction,
  boardId: string,
  status: WorkplaceLane,
): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${workplaceCards.position}), 0)` })
    .from(workplaceCards)
    .where(
      and(
        eq(workplaceCards.boardId, boardId),
        eq(workplaceCards.status, status),
        isNull(workplaceCards.archivedAt),
      ),
    )
  return Number(row?.max ?? 0) + RANK_GAP
}

async function replayOrStore<T>(
  tx: Transaction,
  input: {
    readonly callerId: AgentId
    readonly idempotencyKey: string | undefined
    readonly run: () => Promise<T>
    readonly keep?: (value: T) => boolean
  },
): Promise<T | { readonly replayed: true; readonly value: T }> {
  if (input.idempotencyKey === undefined) {
    return input.run()
  }
  const [existing] = await tx
    .select()
    .from(workplaceIdempotency)
    .where(
      and(
        eq(workplaceIdempotency.actorKind, 'citizen'),
        eq(workplaceIdempotency.actorId, input.callerId),
        eq(workplaceIdempotency.key, input.idempotencyKey),
      ),
    )
    .limit(1)
  if (existing !== undefined) {
    return { replayed: true, value: existing.body as T }
  }
  const value = await input.run()
  if (input.keep !== undefined && !input.keep(value)) return value
  await tx.insert(workplaceIdempotency).values({
    actorKind: 'citizen',
    actorId: input.callerId,
    key: input.idempotencyKey,
    status: 200,
    body: value as Record<string, unknown>,
    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
  })
  return value
}

export type StartProfessionPracticumResult =
  | { readonly outcome: 'started'; readonly cycle: WorkplacePracticumCycle }
  | { readonly outcome: 'citizen-required' }

/**
 * Start one practicum cycle, on explicit citizen acceptance (`#1835`).
 *
 * **Only this call creates a cycle.** Declaring what you work as creates
 * nothing, and neither does waking up: the outcome argument is the citizen's
 * own sentence and its arrival here is the consent.
 *
 * **The cycle identifier rides on `seedKey`, which already exists**, so no
 * progress table shadows the cards. It is one non-secret string, it grants no
 * permission, and it is what makes a retry converge and a later read able to
 * tell these five cards from every other card on the board.
 *
 * **Concurrent acceptance converges on one cycle.** The citizen row is locked
 * first, exactly as the default-board provisioner locks it, so the second
 * caller reads the cards the first wrote instead of writing five more.
 */
export async function startProfessionPracticum(
  db: Database,
  input: { readonly callerId: AgentId; readonly outcome: string },
): Promise<StartProfessionPracticumResult> {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, input.callerId))
      .for('update')
      .limit(1)
    if (agent?.status !== 'citizen') return { outcome: 'citizen-required' }

    await provisionDefaultWorkplace(tx, {
      citizenId: input.callerId,
      now: new Date().toISOString(),
    })
    const [board] = await tx
      .select({ id: workplaceBoards.id })
      .from(workplaceBoards)
      .where(
        and(
          eq(workplaceBoards.ownerId, input.callerId),
          eq(workplaceBoards.kind, 'default'),
          isNull(workplaceBoards.archivedAt),
        ),
      )
      .limit(1)
    if (board === undefined) throw new Error('default workplace provision returned no board')

    const existing = await tx
      .select()
      .from(workplaceCards)
      .where(
        and(
          eq(workplaceCards.boardId, board.id),
          sql`${workplaceCards.seedKey} like ${`${PRACTICUM_PREFIX}%`}`,
          sql`${workplaceCards.seedKey} not like ${`${PRACTICUM_PREFIX}%${PRACTICUM_CLOSED}%`}`,
        ),
      )
      .orderBy(workplaceCards.position, workplaceCards.id)
    if (existing.length > 0) {
      const cycleId = existing[0]?.seedKey?.split(':card:')[0]
      if (cycleId === undefined) throw new Error('practicum card has no cycle identifier')
      return {
        outcome: 'started',
        cycle: {
          id: cycleId,
          boardId: WorkplaceBoardIdSchema.parse(board.id),
          cards: existing.map(toCard),
        },
      }
    }

    const cycleId = `${PRACTICUM_PREFIX}${randomUUID()}`
    let position = await nextPosition(tx, board.id, 'inbox')
    const inserted: WorkplaceCard[] = []
    for (const [index, title] of WORKPLACE_PRACTICUM_CARD_TITLES.entries()) {
      const [row] = await tx
        .insert(workplaceCards)
        .values({
          boardId: board.id,
          status: 'inbox',
          title,
          description: input.outcome,
          position,
          seedKey: `${cycleId}:card:${index + 1}`,
        })
        .returning()
      if (row === undefined) throw new Error('practicum card insert returned no row')
      inserted.push(toCard(row))
      position += RANK_GAP
    }
    // Counted here rather than at the surface, so an acceptance that arrives
    // over HTTP, MCP or a delegation is one acceptance in the aggregate.
    await tx.insert(workplacePracticumEvents).values({ event: 'accepted' })
    return {
      outcome: 'started',
      cycle: { id: cycleId, boardId: WorkplaceBoardIdSchema.parse(board.id), cards: inserted },
    }
  })
}
/**
 * Where a closed cycle records its ending, on the cards themselves (`#1836`).
 *
 * **The seed key carries it, exactly as the cycle id does.** A closed cycle is
 * one whose cards' `seedKey` carries this marker, so there is no second table
 * shadowing the board and no progress score anywhere: the cards remain the
 * source of truth, and *terminal* is a property a reader derives from them.
 *
 * **The codes are one character because the column is 64 and the budget is
 * spent.** `practicum:` plus a uuid plus `:card:N` is already 53 of it, so
 * `#shipped` does not fit and `#failed_experiment` is not close. The map is
 * explicit and total rather than an abbreviation somebody has to guess at, and
 * the enum it is keyed by is the one `packages/core` publishes — so a third
 * result cannot be added without this failing to compile.
 */
const PRACTICUM_CLOSED = '#'
const PRACTICUM_RESULT_CODES: Record<WorkplacePracticumResult, string> = {
  shipped: 's',
  failed_experiment: 'f',
}
const PRACTICUM_RESULT_BY_CODE = new Map<string, WorkplacePracticumResult>(
  Object.entries(PRACTICUM_RESULT_CODES).map(([result, code]) => [
    code,
    WorkplacePracticumResultSchema.parse(result),
  ]),
)

const PRACTICUM_EVIDENCE_LINK_KINDS: Record<WorkplacePracticumEvidenceKind, WorkplaceLinkKind> = {
  url: 'url',
  repository: 'url',
  artifact: 'url',
}

const practicumRetrospectiveFor = (
  cycleId: string,
  result: WorkplacePracticumResult,
): WorkplacePracticumRetrospective => ({
  cycleId,
  result,
  choices: {
    startRevised: {
      tool: 'kolonie.workplace',
      arguments: {
        act: 'accept-practicum',
        subject: 'card',
        fields: { outcome: '<your revised outcome>' },
      },
    },
    replaceOutcome: {
      tool: 'kolonie.workplace',
      arguments: {
        act: 'accept-practicum',
        subject: 'card',
        fields: { outcome: '<a different outcome>' },
      },
    },
    defer: {
      tool: 'kolonie.workplace',
      arguments: { act: 'defer-practicum', subject: 'card', id: cycleId },
    },
    end: {
      tool: 'kolonie.workplace',
      arguments: { act: 'end-practicum', subject: 'card', id: cycleId },
    },
  },
})

export type CloseProfessionPracticumResult =
  | {
      readonly outcome: 'closed'
      readonly retrospective: WorkplacePracticumRetrospective
    }
  | { readonly outcome: 'unknown-cycle' }

/**
 * End one practicum cycle, on evidence the citizen supplies (`#1836`).
 *
 * **What closes a cycle is this call and nothing else.** Moving five cards to
 * Done does not, however they are titled, because the rejection case the issue
 * names is precisely a card called *document progress* reaching that lane. The
 * evidence is validated in `packages/core` before it arrives here, so what this
 * function defends is ownership, idempotency and the promise that nothing is
 * started on the citizen's behalf.
 *
 * **Terminal is recorded on the cards' own `seedKey`**, so the board stays the
 * only state. A repeated close finds the cycle already terminal and hands back
 * the same retrospective without counting a second event — which is why the
 * count and the update happen under one lock rather than in two statements.
 *
 * **The successor is offered and never opened.** The returned choices are
 * callable arguments for `accept-practicum`, which is the same explicit consent
 * `#1835` requires; `defer` and `end` write nothing at all.
 */
export async function closeProfessionPracticum(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly cycleId: string
    readonly close: WorkplaceClosePracticumRequest
  },
): Promise<CloseProfessionPracticumResult> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, input.callerId))
      .for('update')
      .limit(1)

    const cards = await tx
      .select({ id: workplaceCards.id, seedKey: workplaceCards.seedKey })
      .from(workplaceCards)
      .innerJoin(workplaceBoards, eq(workplaceBoards.id, workplaceCards.boardId))
      .where(
        and(
          eq(workplaceBoards.ownerId, input.callerId),
          or(
            sql`${workplaceCards.seedKey} like ${`${input.cycleId}:card:%`}`,
            sql`${workplaceCards.seedKey} like ${`${input.cycleId}${PRACTICUM_CLOSED}%`}`,
          ),
        ),
      )
    if (cards.length === 0) return { outcome: 'unknown-cycle' }

    const already = cards.find((card) =>
      card.seedKey?.startsWith(`${input.cycleId}${PRACTICUM_CLOSED}`),
    )
    if (already !== undefined) {
      const marker = already.seedKey?.slice(
        input.cycleId.length + PRACTICUM_CLOSED.length,
        input.cycleId.length + PRACTICUM_CLOSED.length + 1,
      )
      const result = marker === undefined ? undefined : PRACTICUM_RESULT_BY_CODE.get(marker)
      if (result === undefined) throw new Error('practicum card has an unknown terminal result')
      return {
        outcome: 'closed',
        retrospective: practicumRetrospectiveFor(input.cycleId, result),
      }
    }

    if (input.close.result === 'shipped') {
      const evidenceCard = cards.at(-1)
      if (evidenceCard === undefined) throw new Error('practicum cycle has no evidence card')
      await tx
        .insert(workplaceCardLinks)
        .values({
          cardId: evidenceCard.id,
          kind: PRACTICUM_EVIDENCE_LINK_KINDS[input.close.evidence.kind],
          ref: input.close.evidence.ref,
        })
        .onConflictDoNothing()
    }

    for (const card of cards) {
      const suffix = card.seedKey?.split(':card:')[1] ?? '1'
      await tx
        .update(workplaceCards)
        .set({
          seedKey: `${input.cycleId}${PRACTICUM_CLOSED}${PRACTICUM_RESULT_CODES[input.close.result]}:card:${suffix}`,
          updatedAt: sql`now()`,
        })
        .where(eq(workplaceCards.id, card.id))
    }
    await tx.insert(workplacePracticumEvents).values({ event: input.close.result })

    return {
      outcome: 'closed',
      retrospective: practicumRetrospectiveFor(input.cycleId, input.close.result),
    }
  })
}

/** The two terminal retrospective choices that create no successor (`#1836`). */
export type ResolveProfessionPracticumResult =
  | { readonly outcome: 'resolved'; readonly choice: 'deferred' | 'ended' }
  | { readonly outcome: 'unknown-cycle' }

export async function resolveProfessionPracticum(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly cycleId: string
    readonly choice: 'deferred' | 'ended'
  },
): Promise<ResolveProfessionPracticumResult> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, input.callerId))
      .for('update')
      .limit(1)
    const [terminal] = await tx
      .select({ id: workplaceCards.id, seedKey: workplaceCards.seedKey })
      .from(workplaceCards)
      .innerJoin(workplaceBoards, eq(workplaceBoards.id, workplaceCards.boardId))
      .where(
        and(
          eq(workplaceBoards.ownerId, input.callerId),
          sql`${workplaceCards.seedKey} like ${`${input.cycleId}${PRACTICUM_CLOSED}%`}`,
        ),
      )
      .limit(1)
    if (terminal === undefined) return { outcome: 'unknown-cycle' }
    if (terminal.seedKey?.endsWith('#d') === true)
      return { outcome: 'resolved', choice: 'deferred' }
    if (terminal.seedKey?.endsWith('#e') === true) return { outcome: 'resolved', choice: 'ended' }
    const marker = input.choice === 'deferred' ? '#d' : '#e'
    await tx
      .update(workplaceCards)
      .set({ seedKey: sql`${workplaceCards.seedKey} || ${marker}`, updatedAt: sql`now()` })
      .where(
        and(
          sql`${workplaceCards.seedKey} like ${`${input.cycleId}${PRACTICUM_CLOSED}%`}`,
          sql`${workplaceCards.seedKey} not like ${`${input.cycleId}${PRACTICUM_CLOSED}%#d`}`,
          sql`${workplaceCards.seedKey} not like ${`${input.cycleId}${PRACTICUM_CLOSED}%#e`}`,
        ),
      )
    await tx.insert(workplacePracticumEvents).values({ event: input.choice })
    return { outcome: 'resolved', choice: input.choice }
  })
}

/** The aggregate `#1836` publishes: one count per event slug, and nothing else. */
export async function practicumEventCounts(
  db: Database,
): Promise<Record<WorkplacePracticumEventName, number>> {
  const rows = await db
    .select({ event: workplacePracticumEvents.event, count: sql<number>`count(*)::int` })
    .from(workplacePracticumEvents)
    .groupBy(workplacePracticumEvents.event)

  const counts = Object.fromEntries(
    WORKPLACE_PRACTICUM_EVENTS.map((event) => [event, 0]),
  ) as Record<WorkplacePracticumEventName, number>
  for (const row of rows) {
    const event = WorkplacePracticumEventNameSchema.safeParse(row.event)
    if (event.success) counts[event.data] = row.count
  }
  return counts
}

export type CreateCardResult =
  | { readonly outcome: 'created'; readonly card: WorkplaceCard }
  | WorkplaceMissing
  | WorkplaceForbidden
  | WorkplaceInvalidTransition

export async function createCard(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly boardId: string
    readonly title: string
    readonly description?: string | null
    readonly status?: WorkplaceLane
    readonly priority?: string
    readonly dueAt?: string | null
    readonly coverColour?: string | null
    readonly idempotencyKey?: string
  },
): Promise<CreateCardResult> {
  return db.transaction(async (tx) => {
    const access = await boardWriteAccess(tx, input.callerId, input.boardId)
    if (access.outcome !== 'ok') return access
    const status = input.status ?? 'inbox'
    if (status !== 'inbox' && status !== 'ready') return { outcome: 'invalid-transition' }

    const stored = await replayOrStore(tx, {
      callerId: input.callerId,
      idempotencyKey: input.idempotencyKey,
      run: async () => {
        const position = await nextPosition(tx, input.boardId, status)
        const [row] = await tx
          .insert(workplaceCards)
          .values({
            boardId: input.boardId,
            status,
            title: input.title,
            description: input.description ?? null,
            position,
            priority: input.priority ?? 'unset',
            dueAt: input.dueAt ?? null,
            coverColour: input.coverColour ?? null,
          })
          .returning()
        if (row === undefined) throw new Error('workplace card insert returned no row')
        return toCard(row)
      },
    })
    if (typeof stored === 'object' && stored !== null && 'replayed' in stored) {
      return { outcome: 'created', card: stored.value }
    }
    return { outcome: 'created', card: stored }
  })
}

export type UpdateCardResult =
  | { readonly outcome: 'updated'; readonly card: WorkplaceCard }
  | WorkplaceMissing
  | WorkplaceForbidden
  | WorkplaceStale

export async function updateCard(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly title?: string
    readonly description?: string | null
    readonly priority?: string
    readonly dueAt?: string | null
    readonly coverColour?: string | null
    readonly position?: number
  },
): Promise<UpdateCardResult> {
  return db.transaction(async (tx) => {
    const locked = await lockCardForWrite(tx, input.callerId, input.cardId)
    if (locked.outcome !== 'ok') return locked
    const [row] = await tx
      .update(workplaceCards)
      .set({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
        ...(input.coverColour === undefined ? {} : { coverColour: input.coverColour }),
        ...(input.position === undefined ? {} : { position: input.position }),
        version: sql`${workplaceCards.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(workplaceCards.id, input.cardId),
          eq(workplaceCards.version, input.expectedVersion),
          callerIsMember(input.callerId),
        ),
      )
      .returning()
    if (row === undefined) return { outcome: 'stale' }
    return { outcome: 'updated', card: toCard(row) }
  })
}

export type MoveCardResult =
  | { readonly outcome: 'moved'; readonly card: WorkplaceCard }
  | WorkplaceMissing
  | WorkplaceForbidden
  | WorkplaceStale
  | WorkplaceInvalidTransition
  | WorkplaceHandoverRequired
  | WorkplaceConflict

export async function moveCard(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly status: WorkplaceLane
    readonly position?: number
  },
): Promise<MoveCardResult> {
  return db.transaction(async (tx) => {
    const locked = await lockCardForWrite(tx, input.callerId, input.cardId)
    if (locked.outcome !== 'ok') return locked
    const existing = locked.card
    const from = WorkplaceLaneSchema.parse(existing.status)
    if (!canTransitionWorkplace(from, input.status)) return { outcome: 'invalid-transition' }
    /**
     * Entering `in_progress` claims if the card is ownerless. A live owner
     * who is not the caller is a handover, not a steal (D-146, `#1760`).
     */
    let ownerId = existing.ownerId
    if (input.status === 'in_progress' && existing.ownerId === null) {
      ownerId = input.callerId
    } else if (input.status === 'in_progress' && existing.ownerId !== input.callerId) {
      return { outcome: 'handover-required' }
    } else if (mustHaveOwner(input.status) && existing.ownerId === null) {
      return { outcome: 'invalid-transition' }
    }
    if (
      input.status === 'blocked' &&
      (existing.blockedBy === null || existing.unblockWhen === null)
    ) {
      return { outcome: 'invalid-transition' }
    }
    if (input.status === 'done' && existing.outcome === null) {
      return { outcome: 'invalid-transition' }
    }

    const position = input.position ?? (await nextPosition(tx, existing.boardId, input.status))
    const unclaim = from === 'in_progress' && input.status === 'ready'
    const [row] = await tx
      .update(workplaceCards)
      .set({
        status: input.status,
        position,
        ...(unclaim ? { ownerId: null } : ownerId !== existing.ownerId ? { ownerId } : {}),
        version: sql`${workplaceCards.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(workplaceCards.id, input.cardId),
          eq(workplaceCards.version, input.expectedVersion),
          callerIsMember(input.callerId),
        ),
      )
      .returning()
    if (row === undefined) return { outcome: 'stale' }
    return { outcome: 'moved', card: toCard(row) }
  })
}

export type ClaimCardResult =
  | { readonly outcome: 'claimed'; readonly card: WorkplaceCard }
  | WorkplaceMissing
  | WorkplaceForbidden
  | WorkplaceConflict
  | WorkplaceInvalidTransition

export async function claimCard(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly idempotencyKey?: string
  },
): Promise<ClaimCardResult> {
  /**
   * A unique-rank collision on `in_progress` aborts the transaction; retry
   * the whole write rather than catch inside it. Same-card races never
   * reach the index — the `owner_id is null` predicate already serialises
   * them.
   */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await claimCardOnce(db, input)
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 2) throw error
    }
  }
  throw new Error('workplace claim retry exhausted')
}

async function claimCardOnce(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly idempotencyKey?: string
  },
): Promise<ClaimCardResult> {
  return db.transaction(async (tx) => {
    const locked = await lockCardForWrite(tx, input.callerId, input.cardId)
    if (locked.outcome !== 'ok') return locked
    const stored = await replayOrStore(tx, {
      callerId: input.callerId,
      idempotencyKey: input.idempotencyKey,
      run: async () => {
        /**
         * One statement after the lock. `owner_id is null` serialises two
         * claimants; membership was re-read after the wait so a concurrent
         * removal is `forbidden` rather than a successful claim.
         */
        const [row] = await tx
          .update(workplaceCards)
          .set({
            ownerId: input.callerId,
            status: 'in_progress',
            position: sql`(select coalesce(max(c2.position), 0) + ${RANK_GAP}
              from workplace_cards c2
             where c2.board_id = ${workplaceCards.boardId}
               and c2.status = 'in_progress'
               and c2.archived_at is null)`,
            version: sql`${workplaceCards.version} + 1`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(workplaceCards.id, input.cardId),
              eq(workplaceCards.version, input.expectedVersion),
              isNull(workplaceCards.ownerId),
              eq(workplaceCards.status, 'ready'),
              isNull(workplaceCards.archivedAt),
              callerIsMember(input.callerId),
            ),
          )
          .returning()
        return row === undefined ? null : toCard(row)
      },
      keep: (value) => value !== null,
    })

    if (typeof stored === 'object' && stored !== null && 'replayed' in stored) {
      return { outcome: 'claimed', card: stored.value as WorkplaceCard }
    }
    if (stored !== null) return { outcome: 'claimed', card: stored }

    const visible = await visibleCard(tx, input.callerId, input.cardId)
    if (visible === null) {
      const diagnosed = await diagnoseCardWrite(tx, input.callerId, input.cardId)
      return diagnosed.outcome === 'stale' ? { outcome: 'conflict' } : diagnosed
    }
    if (visible.ownerId !== null) return { outcome: 'conflict' }
    if (visible.status !== 'ready' || visible.archivedAt !== null) {
      return { outcome: 'invalid-transition' }
    }
    return { outcome: 'conflict' }
  })
}

export type HandoverCardResult =
  | {
      readonly outcome: 'handed-over'
      readonly card: WorkplaceCard
      readonly handover: WorkplaceHandover
    }
  | WorkplaceMissing
  | WorkplaceForbidden
  | WorkplaceStale
  | WorkplaceUnknownCitizen
  | WorkplaceHandoverRequired

export async function handoverCard(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly to: string
    readonly done: string
    readonly learned: string
    readonly next: string
    readonly blocked?: string | null
    readonly evidenceLinks?: readonly string[]
    readonly idempotencyKey?: string
  },
): Promise<HandoverCardResult> {
  return db.transaction(async (tx) => {
    const locked = await lockCardForWrite(tx, input.callerId, input.cardId)
    if (locked.outcome !== 'ok') return locked
    const existing = locked.card
    if (!isUuid(input.to)) return { outcome: 'unknown-citizen' }
    const to = AgentIdSchema.parse(input.to)
    const callerMembership = await membershipOf(tx, input.callerId, existing.boardId)
    const [targetRow] = await tx
      .select()
      .from(workplaceBoardMemberships)
      .where(
        and(
          eq(workplaceBoardMemberships.boardId, existing.boardId),
          eq(workplaceBoardMemberships.citizenId, to),
        ),
      )
      .for('update')
      .limit(1)
    const targetMembership = targetRow === undefined ? null : toMembership(targetRow)
    if (targetMembership === null) return { outcome: 'unknown-citizen' }
    if (
      !handoverAllowed({
        card: toCard(existing),
        caller: input.callerId,
        callerMembership,
        targetMembership,
      })
    ) {
      return { outcome: 'handover-required' }
    }

    const stored = await replayOrStore(tx, {
      callerId: input.callerId,
      idempotencyKey: input.idempotencyKey,
      keep: (value) => !('stale' in value),
      run: async () => {
        const [card] = await tx
          .update(workplaceCards)
          .set({
            ownerId: to,
            version: sql`${workplaceCards.version} + 1`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(workplaceCards.id, input.cardId),
              eq(workplaceCards.version, input.expectedVersion),
              callerIsMember(input.callerId),
              sql`exists (select 1 from workplace_board_memberships m
                    where m.board_id = ${workplaceCards.boardId}
                      and m.citizen_id = ${to})`,
            ),
          )
          .returning()
        if (card === undefined) return { stale: true as const }

        await tx
          .update(workplaceHandovers)
          .set({ isCurrent: false, updatedAt: sql`now()` })
          .where(
            and(
              eq(workplaceHandovers.cardId, input.cardId),
              eq(workplaceHandovers.isCurrent, true),
            ),
          )

        const [handover] = await tx
          .insert(workplaceHandovers)
          .values({
            cardId: input.cardId,
            fromId: input.callerId,
            toId: to,
            done: input.done,
            learned: input.learned,
            next: input.next,
            blocked: input.blocked ?? null,
            evidenceLinks: [...(input.evidenceLinks ?? [])],
            isCurrent: true,
          })
          .returning()
        if (handover === undefined) throw new Error('workplace handover insert returned no row')
        return { card: toCard(card), handover: toHandover(handover) }
      },
    })

    if (typeof stored === 'object' && stored !== null && 'replayed' in stored) {
      const value = stored.value as { card: WorkplaceCard; handover: WorkplaceHandover }
      return { outcome: 'handed-over', card: value.card, handover: value.handover }
    }
    if ('stale' in stored) return { outcome: 'stale' }
    return { outcome: 'handed-over', card: stored.card, handover: stored.handover }
  })
}

export type CompleteCardResult =
  | { readonly outcome: 'completed'; readonly card: WorkplaceCard }
  | WorkplaceMissing
  | WorkplaceForbidden
  | WorkplaceStale
  | WorkplaceInvalidTransition

export async function completeCard(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly outcome: string
  },
): Promise<CompleteCardResult> {
  return db.transaction(async (tx) => {
    const locked = await lockCardForWrite(tx, input.callerId, input.cardId)
    if (locked.outcome !== 'ok') return locked
    const existing = locked.card
    const from = WorkplaceLaneSchema.parse(existing.status)
    if (!canTransitionWorkplace(from, 'done')) return { outcome: 'invalid-transition' }
    if (existing.ownerId === null) return { outcome: 'invalid-transition' }

    const position = await nextPosition(tx, existing.boardId, 'done')
    const [row] = await tx
      .update(workplaceCards)
      .set({
        status: 'done',
        outcome: input.outcome,
        position,
        version: sql`${workplaceCards.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(workplaceCards.id, input.cardId),
          eq(workplaceCards.version, input.expectedVersion),
          callerIsMember(input.callerId),
        ),
      )
      .returning()
    if (row === undefined) return { outcome: 'stale' }
    /**
     * Completing a card of a live cycle is progress on the board and **not** a
     * terminal result (`#1836`).
     *
     * It is counted as a documentation-only update precisely so that the Colony
     * can see a citizen looping without reading what it wrote: the alternative
     * — inferring shipment from cards reaching Done — is the rejection case the
     * issue names by title. Only `closeProfessionPracticum` ends a cycle.
     */
    if (
      row.seedKey?.startsWith(PRACTICUM_PREFIX) === true &&
      !row.seedKey.includes(PRACTICUM_CLOSED)
    ) {
      await tx.insert(workplacePracticumEvents).values({ event: 'documentation_only_update' })
    }
    return { outcome: 'completed', card: toCard(row) }
  })
}

export type BlockCardResult =
  | { readonly outcome: 'blocked'; readonly card: WorkplaceCard }
  | WorkplaceMissing
  | WorkplaceForbidden
  | WorkplaceStale
  | WorkplaceInvalidTransition

export async function blockCard(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly blockedBy: string
    readonly unblockWhen: string
  },
): Promise<BlockCardResult> {
  return db.transaction(async (tx) => {
    const locked = await lockCardForWrite(tx, input.callerId, input.cardId)
    if (locked.outcome !== 'ok') return locked
    const existing = locked.card
    const from = WorkplaceLaneSchema.parse(existing.status)
    if (!canTransitionWorkplace(from, 'blocked')) return { outcome: 'invalid-transition' }
    if (existing.ownerId === null) return { outcome: 'invalid-transition' }

    const position = await nextPosition(tx, existing.boardId, 'blocked')
    const [row] = await tx
      .update(workplaceCards)
      .set({
        status: 'blocked',
        blockedBy: input.blockedBy,
        unblockWhen: input.unblockWhen,
        position,
        version: sql`${workplaceCards.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(workplaceCards.id, input.cardId),
          eq(workplaceCards.version, input.expectedVersion),
          callerIsMember(input.callerId),
        ),
      )
      .returning()
    if (row === undefined) return { outcome: 'stale' }
    return { outcome: 'blocked', card: toCard(row) }
  })
}

export type RequestReviewResult =
  | { readonly outcome: 'reviewed'; readonly card: WorkplaceCard }
  | WorkplaceMissing
  | WorkplaceForbidden
  | WorkplaceStale
  | WorkplaceInvalidTransition

export async function requestReview(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
  },
): Promise<RequestReviewResult> {
  return db.transaction(async (tx) => {
    const locked = await lockCardForWrite(tx, input.callerId, input.cardId)
    if (locked.outcome !== 'ok') return locked
    const existing = locked.card
    const from = WorkplaceLaneSchema.parse(existing.status)
    if (!canTransitionWorkplace(from, 'review')) return { outcome: 'invalid-transition' }
    if (existing.ownerId === null) return { outcome: 'invalid-transition' }

    const position = await nextPosition(tx, existing.boardId, 'review')
    const [row] = await tx
      .update(workplaceCards)
      .set({
        status: 'review',
        position,
        version: sql`${workplaceCards.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(workplaceCards.id, input.cardId),
          eq(workplaceCards.version, input.expectedVersion),
          callerIsMember(input.callerId),
        ),
      )
      .returning()
    if (row === undefined) return { outcome: 'stale' }
    return { outcome: 'reviewed', card: toCard(row) }
  })
}

export type ArchiveCardResult =
  | { readonly outcome: 'archived'; readonly card: WorkplaceCard }
  | WorkplaceMissing
  | WorkplaceForbidden
  | WorkplaceStale
  | WorkplaceInvalidTransition

export async function archiveCard(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
  },
): Promise<ArchiveCardResult> {
  return db.transaction(async (tx) => {
    const locked = await lockCardForWrite(tx, input.callerId, input.cardId)
    if (locked.outcome !== 'ok') return locked
    const existing = locked.card
    const from = WorkplaceLaneSchema.parse(existing.status)
    if (!canTransitionWorkplace(from, 'archived')) return { outcome: 'invalid-transition' }
    const membership = await membershipOf(tx, input.callerId, existing.boardId)
    if (membership === null) return { outcome: 'forbidden' }
    if (membership.role !== 'owner') return { outcome: 'forbidden' }

    const [row] = await tx
      .update(workplaceCards)
      .set({
        archivedAt: sql`now()`,
        version: sql`${workplaceCards.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(workplaceCards.id, input.cardId),
          eq(workplaceCards.version, input.expectedVersion),
          callerIsMember(input.callerId),
        ),
      )
      .returning()
    if (row === undefined) return { outcome: 'stale' }
    return { outcome: 'archived', card: toCard(row) }
  })
}

export type AttachLabelResult =
  | { readonly outcome: 'attached'; readonly label: WorkplaceLabel }
  | WorkplaceMissing
  | WorkplaceForbidden

export async function attachLabel(
  db: Database,
  input: { readonly callerId: AgentId; readonly cardId: string; readonly labelId: string },
): Promise<AttachLabelResult> {
  return db.transaction(async (tx) => {
    const locked = await lockCardForWrite(tx, input.callerId, input.cardId)
    if (locked.outcome !== 'ok') return locked
    if (!isUuid(input.labelId)) return { outcome: 'missing' }
    const [label] = await tx
      .select()
      .from(workplaceLabels)
      .where(
        and(
          eq(workplaceLabels.id, input.labelId),
          eq(workplaceLabels.boardId, locked.card.boardId),
        ),
      )
      .limit(1)
    if (label === undefined) return { outcome: 'missing' }
    await tx
      .insert(workplaceCardLabels)
      .values({
        cardId: input.cardId,
        labelId: input.labelId,
        boardId: locked.card.boardId,
      })
      .onConflictDoNothing()
    return {
      outcome: 'attached',
      label: WorkplaceLabelSchema.parse({
        id: label.id,
        boardId: label.boardId,
        name: label.name,
        colour: label.colour,
      }),
    }
  })
}

export type DetachLabelResult =
  { readonly outcome: 'detached' } | WorkplaceMissing | WorkplaceForbidden

export async function detachLabel(
  db: Database,
  input: { readonly callerId: AgentId; readonly cardId: string; readonly labelId: string },
): Promise<DetachLabelResult> {
  return db.transaction(async (tx) => {
    const locked = await lockCardForWrite(tx, input.callerId, input.cardId)
    if (locked.outcome !== 'ok') return locked
    if (!isUuid(input.labelId)) return { outcome: 'missing' }
    await tx
      .delete(workplaceCardLabels)
      .where(
        and(
          eq(workplaceCardLabels.cardId, input.cardId),
          eq(workplaceCardLabels.labelId, input.labelId),
        ),
      )
    return { outcome: 'detached' }
  })
}

export type CreateChecklistResult =
  | { readonly outcome: 'created'; readonly checklist: WorkplaceChecklist }
  | WorkplaceMissing
  | WorkplaceForbidden

export async function createChecklist(
  db: Database,
  input: { readonly callerId: AgentId; readonly cardId: string; readonly title: string },
): Promise<CreateChecklistResult> {
  return db.transaction(async (tx) => {
    const locked = await lockCardForWrite(tx, input.callerId, input.cardId)
    if (locked.outcome !== 'ok') return locked
    const [max] = await tx
      .select({ max: sql<number>`coalesce(max(${workplaceChecklists.position}), -1)` })
      .from(workplaceChecklists)
      .where(eq(workplaceChecklists.cardId, input.cardId))
    const [row] = await tx
      .insert(workplaceChecklists)
      .values({
        cardId: input.cardId,
        title: input.title,
        position: Number(max?.max ?? -1) + 1,
      })
      .returning()
    if (row === undefined) throw new Error('workplace checklist insert returned no row')
    return {
      outcome: 'created',
      checklist: WorkplaceChecklistSchema.parse({
        id: row.id,
        cardId: row.cardId,
        title: row.title,
        position: row.position,
      }),
    }
  })
}

export type UpdateChecklistResult =
  | { readonly outcome: 'updated'; readonly checklist: WorkplaceChecklist }
  | WorkplaceMissing
  | WorkplaceForbidden

export async function updateChecklist(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly checklistId: string
    readonly title?: string
    readonly position?: number
  },
): Promise<UpdateChecklistResult> {
  return db.transaction(async (tx) => {
    if (!isUuid(input.checklistId)) return { outcome: 'missing' }
    const [existing] = await tx
      .select()
      .from(workplaceChecklists)
      .where(eq(workplaceChecklists.id, input.checklistId))
      .limit(1)
    if (existing === undefined) return { outcome: 'missing' }
    const locked = await lockCardForWrite(tx, input.callerId, existing.cardId)
    if (locked.outcome !== 'ok') return locked
    const [row] = await tx
      .update(workplaceChecklists)
      .set({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.position === undefined ? {} : { position: input.position }),
      })
      .where(eq(workplaceChecklists.id, input.checklistId))
      .returning()
    if (row === undefined) return { outcome: 'missing' }
    return {
      outcome: 'updated',
      checklist: WorkplaceChecklistSchema.parse({
        id: row.id,
        cardId: row.cardId,
        title: row.title,
        position: row.position,
      }),
    }
  })
}

export type DeleteChecklistResult =
  { readonly outcome: 'deleted' } | WorkplaceMissing | WorkplaceForbidden

export async function deleteChecklist(
  db: Database,
  input: { readonly callerId: AgentId; readonly checklistId: string },
): Promise<DeleteChecklistResult> {
  return db.transaction(async (tx) => {
    if (!isUuid(input.checklistId)) return { outcome: 'missing' }
    const [existing] = await tx
      .select()
      .from(workplaceChecklists)
      .where(eq(workplaceChecklists.id, input.checklistId))
      .limit(1)
    if (existing === undefined) return { outcome: 'missing' }
    const locked = await lockCardForWrite(tx, input.callerId, existing.cardId)
    if (locked.outcome !== 'ok') return locked
    await tx.delete(workplaceChecklists).where(eq(workplaceChecklists.id, input.checklistId))
    return { outcome: 'deleted' }
  })
}

export type CreateChecklistItemResult =
  | { readonly outcome: 'created'; readonly item: WorkplaceChecklistItem }
  | WorkplaceMissing
  | WorkplaceForbidden

export async function createChecklistItem(
  db: Database,
  input: { readonly callerId: AgentId; readonly checklistId: string; readonly title: string },
): Promise<CreateChecklistItemResult> {
  return db.transaction(async (tx) => {
    if (!isUuid(input.checklistId)) return { outcome: 'missing' }
    const [list] = await tx
      .select()
      .from(workplaceChecklists)
      .where(eq(workplaceChecklists.id, input.checklistId))
      .limit(1)
    if (list === undefined) return { outcome: 'missing' }
    const locked = await lockCardForWrite(tx, input.callerId, list.cardId)
    if (locked.outcome !== 'ok') return locked
    const [max] = await tx
      .select({ max: sql<number>`coalesce(max(${workplaceChecklistItems.position}), -1)` })
      .from(workplaceChecklistItems)
      .where(eq(workplaceChecklistItems.checklistId, input.checklistId))
    const [row] = await tx
      .insert(workplaceChecklistItems)
      .values({
        checklistId: input.checklistId,
        title: input.title,
        position: Number(max?.max ?? -1) + 1,
      })
      .returning()
    if (row === undefined) throw new Error('workplace checklist item insert returned no row')
    return {
      outcome: 'created',
      item: WorkplaceChecklistItemSchema.parse({
        id: row.id,
        checklistId: row.checklistId,
        title: row.title,
        doneAt: row.doneAt === null ? null : toTimestamp(row.doneAt),
        position: row.position,
      }),
    }
  })
}

export type UpdateChecklistItemResult =
  | { readonly outcome: 'updated'; readonly item: WorkplaceChecklistItem }
  | WorkplaceMissing
  | WorkplaceForbidden

export async function updateChecklistItem(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly itemId: string
    readonly title?: string
    readonly doneAt?: string | null
    readonly position?: number
  },
): Promise<UpdateChecklistItemResult> {
  return db.transaction(async (tx) => {
    if (!isUuid(input.itemId)) return { outcome: 'missing' }
    const [existing] = await tx
      .select({
        item: workplaceChecklistItems,
        cardId: workplaceChecklists.cardId,
      })
      .from(workplaceChecklistItems)
      .innerJoin(
        workplaceChecklists,
        eq(workplaceChecklists.id, workplaceChecklistItems.checklistId),
      )
      .where(eq(workplaceChecklistItems.id, input.itemId))
      .limit(1)
    if (existing === undefined) return { outcome: 'missing' }
    const locked = await lockCardForWrite(tx, input.callerId, existing.cardId)
    if (locked.outcome !== 'ok') return locked
    const [row] = await tx
      .update(workplaceChecklistItems)
      .set({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.doneAt === undefined ? {} : { doneAt: input.doneAt }),
        ...(input.position === undefined ? {} : { position: input.position }),
      })
      .where(eq(workplaceChecklistItems.id, input.itemId))
      .returning()
    if (row === undefined) return { outcome: 'missing' }
    return {
      outcome: 'updated',
      item: WorkplaceChecklistItemSchema.parse({
        id: row.id,
        checklistId: row.checklistId,
        title: row.title,
        doneAt: row.doneAt === null ? null : toTimestamp(row.doneAt),
        position: row.position,
      }),
    }
  })
}

export type DeleteChecklistItemResult =
  { readonly outcome: 'deleted' } | WorkplaceMissing | WorkplaceForbidden

export async function deleteChecklistItem(
  db: Database,
  input: { readonly callerId: AgentId; readonly itemId: string },
): Promise<DeleteChecklistItemResult> {
  return db.transaction(async (tx) => {
    if (!isUuid(input.itemId)) return { outcome: 'missing' }
    const [existing] = await tx
      .select({
        item: workplaceChecklistItems,
        cardId: workplaceChecklists.cardId,
      })
      .from(workplaceChecklistItems)
      .innerJoin(
        workplaceChecklists,
        eq(workplaceChecklists.id, workplaceChecklistItems.checklistId),
      )
      .where(eq(workplaceChecklistItems.id, input.itemId))
      .limit(1)
    if (existing === undefined) return { outcome: 'missing' }
    const locked = await lockCardForWrite(tx, input.callerId, existing.cardId)
    if (locked.outcome !== 'ok') return locked
    await tx.delete(workplaceChecklistItems).where(eq(workplaceChecklistItems.id, input.itemId))
    return { outcome: 'deleted' }
  })
}

export type ListCommentsResult =
  | {
      readonly outcome: 'listed'
      readonly items: readonly WorkplaceComment[]
      readonly nextCursor: string | null
    }
  | WorkplaceEmpty
  | { readonly outcome: 'invalid-cursor' }
  | WorkplaceUnknown

export async function listComments(
  db: Database,
  callerId: AgentId,
  cardId: string,
  query: { readonly cursor?: string | null; readonly limit?: number } = {},
): Promise<ListCommentsResult> {
  const card = await visibleCard(db, callerId, cardId)
  if (card === null) return { outcome: 'unknown' }
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
  const after =
    query.cursor === undefined || query.cursor === null || query.cursor === ''
      ? undefined
      : query.cursor
  if (after !== undefined && !isUuid(after)) return { outcome: 'invalid-cursor' }

  const conditions = [
    eq(workplaceComments.cardId, cardId),
    ...(after === undefined ? [] : [sql`${workplaceComments.id} > ${after}::uuid`]),
  ]
  const rows = await db
    .select()
    .from(workplaceComments)
    .where(and(...conditions))
    .orderBy(workplaceComments.createdAt, workplaceComments.id)
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  if (page.length === 0 && after === undefined) return { outcome: 'empty' }
  return {
    outcome: 'listed',
    items: page.map((comment) =>
      WorkplaceCommentSchema.parse({
        id: comment.id,
        cardId: comment.cardId,
        authorId: comment.authorId,
        body: comment.body,
        createdAt: toTimestamp(comment.createdAt),
        updatedAt: toTimestamp(comment.updatedAt),
      }),
    ),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  }
}

export type CreateCommentResult =
  | { readonly outcome: 'created'; readonly comment: WorkplaceComment }
  | WorkplaceMissing
  | WorkplaceForbidden

export async function createComment(
  db: Database,
  input: { readonly callerId: AgentId; readonly cardId: string; readonly body: string },
): Promise<CreateCommentResult> {
  return db.transaction(async (tx) => {
    const locked = await lockCardForWrite(tx, input.callerId, input.cardId)
    if (locked.outcome !== 'ok') return locked
    const [row] = await tx
      .insert(workplaceComments)
      .values({
        cardId: input.cardId,
        authorId: input.callerId,
        body: input.body,
      })
      .returning()
    if (row === undefined) throw new Error('workplace comment insert returned no row')
    return {
      outcome: 'created',
      comment: WorkplaceCommentSchema.parse({
        id: row.id,
        cardId: row.cardId,
        authorId: row.authorId,
        body: row.body,
        createdAt: toTimestamp(row.createdAt),
        updatedAt: toTimestamp(row.updatedAt),
      }),
    }
  })
}

export type ListLinksResult =
  | { readonly outcome: 'listed'; readonly items: readonly WorkplaceResolvedLink[] }
  | WorkplaceEmpty
  | WorkplaceUnknown

export async function listLinks(
  db: Database,
  callerId: AgentId,
  cardId: string,
): Promise<ListLinksResult> {
  const card = await visibleCard(db, callerId, cardId)
  if (card === null) return { outcome: 'unknown' }
  const rows = await db
    .select()
    .from(workplaceCardLinks)
    .where(eq(workplaceCardLinks.cardId, cardId))
    .orderBy(workplaceCardLinks.createdAt, workplaceCardLinks.id)
  if (rows.length === 0) return { outcome: 'empty' }
  return { outcome: 'listed', items: await resolveLinks(db, callerId, rows) }
}

export type AddLinkResult =
  | { readonly outcome: 'created'; readonly link: WorkplaceResolvedLink }
  | WorkplaceMissing
  | WorkplaceForbidden
  | { readonly outcome: 'unresolvable' }

export async function addLink(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly kind: WorkplaceLinkKind
    readonly ref: string
    readonly note?: string
  },
): Promise<AddLinkResult> {
  return db.transaction(async (tx) => {
    const locked = await lockCardForWrite(tx, input.callerId, input.cardId)
    if (locked.outcome !== 'ok') return locked
    const membership = await membershipOf(tx, input.callerId, locked.card.boardId)
    if (membership === null) return { outcome: 'forbidden' }
    if (!mayWriteLink(membership, locked.card, input.callerId)) return { outcome: 'forbidden' }

    const [board] = await tx
      .select({ ownerId: workplaceBoards.ownerId })
      .from(workplaceBoards)
      .where(eq(workplaceBoards.id, locked.card.boardId))
      .limit(1)
    if (board === undefined) return { outcome: 'missing' }
    if (!(await linkTargetExists(tx, AgentIdSchema.parse(board.ownerId), input.kind, input.ref))) {
      return { outcome: 'unresolvable' }
    }

    const [existing] = await tx
      .select()
      .from(workplaceCardLinks)
      .where(
        and(
          eq(workplaceCardLinks.cardId, input.cardId),
          eq(workplaceCardLinks.kind, input.kind),
          eq(workplaceCardLinks.ref, input.ref),
        ),
      )
      .limit(1)
    if (existing !== undefined) {
      return { outcome: 'created', link: await resolveOneLink(tx, input.callerId, existing) }
    }

    const [row] = await tx
      .insert(workplaceCardLinks)
      .values({
        cardId: input.cardId,
        kind: input.kind,
        ref: input.ref,
        note: input.note,
      })
      .returning()
    if (row === undefined) throw new Error('workplace link insert returned no row')
    return { outcome: 'created', link: await resolveOneLink(tx, input.callerId, row) }
  })
}

export type RemoveLinkResult =
  { readonly outcome: 'removed' } | WorkplaceMissing | WorkplaceForbidden

export async function removeLink(
  db: Database,
  input: { readonly callerId: AgentId; readonly linkId: string },
): Promise<RemoveLinkResult> {
  return db.transaction(async (tx) => {
    if (!isUuid(input.linkId)) return { outcome: 'missing' }
    const [link] = await tx
      .select()
      .from(workplaceCardLinks)
      .where(eq(workplaceCardLinks.id, input.linkId))
      .limit(1)
    if (link === undefined) return { outcome: 'missing' }
    const locked = await lockCardForWrite(tx, input.callerId, link.cardId)
    if (locked.outcome !== 'ok') return { outcome: 'missing' }
    const membership = await membershipOf(tx, input.callerId, locked.card.boardId)
    if (membership === null) return { outcome: 'missing' }
    if (!mayWriteLink(membership, locked.card, input.callerId)) return { outcome: 'forbidden' }
    await tx.delete(workplaceCardLinks).where(eq(workplaceCardLinks.id, input.linkId))
    return { outcome: 'removed' }
  })
}

export type MaterialiseDueResult = {
  readonly created: number
  readonly skipped: number
}

/**
 * Clone due template cards into the current period (`#1762`).
 *
 * **Idempotent on `(ruleId, periodStart)`.** A second tick in the same
 * period is a no-op rather than a second inbox card. An unfinished
 * previous occurrence blocks a new card and is recorded on the activity
 * log with `card_id` null, so it does not stack. Citizens only — a
 * candidate, a suspended agent and a banned agent are a zero. Links are
 * copied as stored `(kind, ref)` and never resolved, so a vault pointer
 * cannot decrypt on the way through.
 */
export async function materialiseDue(
  db: Database,
  citizenId: AgentId,
  now: string,
): Promise<MaterialiseDueResult> {
  const [agent] = await db
    .select({ status: agents.status })
    .from(agents)
    .where(eq(agents.id, citizenId))
    .limit(1)
  if (agent === undefined || agent.status !== 'citizen') {
    return { created: 0, skipped: 0 }
  }

  const due = await db
    .select({
      rule: workplaceRecurrenceRules,
      template: workplaceCards,
    })
    .from(workplaceRecurrenceRules)
    .innerJoin(workplaceBoards, eq(workplaceBoards.id, workplaceRecurrenceRules.boardId))
    .innerJoin(workplaceCards, eq(workplaceCards.id, workplaceRecurrenceRules.cardId))
    .where(
      and(
        eq(workplaceBoards.ownerId, citizenId),
        isNull(workplaceBoards.archivedAt),
        isNull(workplaceCards.archivedAt),
        lte(workplaceRecurrenceRules.nextDueAt, now),
      ),
    )

  let created = 0
  let skipped = 0
  for (const row of due) {
    const result = await materialiseOneRule(db, citizenId, row.rule, row.template, now)
    created += result.created
    skipped += result.skipped
  }
  return { created, skipped }
}

async function materialiseOneRule(
  db: Database,
  citizenId: AgentId,
  rule: typeof workplaceRecurrenceRules.$inferSelect,
  template: typeof workplaceCards.$inferSelect,
  now: string,
): Promise<MaterialiseDueResult> {
  const cadence = WorkplaceCadenceSchema.safeParse(rule.cadence)
  if (!cadence.success) return { created: 0, skipped: 0 }
  const periodStart = workplacePeriodStart(cadence.data, now)
  const nextDueAt = workplaceNextPeriodStart(cadence.data, periodStart)

  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .insert(workplaceRecurrenceOccurrences)
      .values({ ruleId: rule.id, periodStart, cardId: null })
      .onConflictDoNothing({
        target: [workplaceRecurrenceOccurrences.ruleId, workplaceRecurrenceOccurrences.periodStart],
      })
      .returning({ id: workplaceRecurrenceOccurrences.id })
    if (claimed === undefined) return { created: 0, skipped: 0 }

    const live = await tx
      .select({ id: workplaceCards.id })
      .from(workplaceRecurrenceOccurrences)
      .innerJoin(workplaceCards, eq(workplaceCards.id, workplaceRecurrenceOccurrences.cardId))
      .where(
        and(
          eq(workplaceRecurrenceOccurrences.ruleId, rule.id),
          ne(workplaceRecurrenceOccurrences.id, claimed.id),
          ne(workplaceCards.status, 'done'),
          isNull(workplaceCards.archivedAt),
        ),
      )
      .limit(1)

    if (live[0] !== undefined) {
      await tx.insert(workplaceActivity).values({
        boardId: rule.boardId,
        cardId: live[0].id,
        actorId: citizenId,
        verb: 'recurrence.skipped',
        payload: { ruleId: rule.id, periodStart, previousCardId: live[0].id },
      })
      await tx
        .update(workplaceRecurrenceRules)
        .set({ nextDueAt, updatedAt: sql`now()` })
        .where(eq(workplaceRecurrenceRules.id, rule.id))
      return { created: 0, skipped: 1 }
    }

    const card = await cloneTemplateCard(tx, template)
    await tx
      .update(workplaceRecurrenceOccurrences)
      .set({ cardId: card.id })
      .where(eq(workplaceRecurrenceOccurrences.id, claimed.id))
    await tx
      .update(workplaceRecurrenceRules)
      .set({ nextDueAt, updatedAt: sql`now()` })
      .where(eq(workplaceRecurrenceRules.id, rule.id))
    return { created: 1, skipped: 0 }
  })
}

async function cloneTemplateCard(
  tx: Transaction,
  template: typeof workplaceCards.$inferSelect,
): Promise<typeof workplaceCards.$inferSelect> {
  const position = await nextPosition(tx, template.boardId, 'inbox')
  const [row] = await tx
    .insert(workplaceCards)
    .values({
      boardId: template.boardId,
      status: 'inbox',
      title: template.title,
      description: template.description,
      position,
      priority: template.priority,
      coverColour: template.coverColour,
    })
    .returning()
  if (row === undefined) throw new Error('workplace recurrence clone returned no row')

  const labels = await tx
    .select()
    .from(workplaceCardLabels)
    .where(eq(workplaceCardLabels.cardId, template.id))
  if (labels.length > 0) {
    await tx.insert(workplaceCardLabels).values(
      labels.map((one) => ({
        cardId: row.id,
        labelId: one.labelId,
        boardId: one.boardId,
      })),
    )
  }

  const lists = await tx
    .select()
    .from(workplaceChecklists)
    .where(eq(workplaceChecklists.cardId, template.id))
  for (const list of lists) {
    const [cloned] = await tx
      .insert(workplaceChecklists)
      .values({ cardId: row.id, title: list.title, position: list.position })
      .returning({ id: workplaceChecklists.id })
    if (cloned === undefined)
      throw new Error('workplace recurrence checklist clone returned no row')
    const items = await tx
      .select()
      .from(workplaceChecklistItems)
      .where(eq(workplaceChecklistItems.checklistId, list.id))
    if (items.length > 0) {
      await tx.insert(workplaceChecklistItems).values(
        items.map((item) => ({
          checklistId: cloned.id,
          title: item.title,
          position: item.position,
          doneAt: null,
        })),
      )
    }
  }

  const links = await tx
    .select()
    .from(workplaceCardLinks)
    .where(eq(workplaceCardLinks.cardId, template.id))
  if (links.length > 0) {
    await tx.insert(workplaceCardLinks).values(
      links.map((link) => ({
        cardId: row.id,
        kind: link.kind,
        ref: link.ref,
        note: link.note,
      })),
    )
  }

  return row
}

/**
 * Before the agent row goes. Cards on boards this citizen owns cascade with
 * the board. Live work they owned on somebody else's board becomes ownerless
 * Ready in the same transaction; `done` stays `done` with its outcome, and
 * only the owner is dropped. Ownerless `done` is what `active_has_owner`
 * now permits, so the `set null` that follows the delete is not refused.
 */
export async function releaseWorkplaceOwnership(tx: Transaction, agentId: AgentId): Promise<void> {
  await tx.execute(sql`
    with foreign_owned as (
      select c.id, c.board_id, c.status, c.position
        from workplace_cards c
       where c.owner_id = ${agentId}
         and c.board_id not in (
           select b.id from workplace_boards b where b.owner_id = ${agentId}
         )
    ),
    ready_max as (
      select board_id, coalesce(max(position), 0) as max_pos
        from workplace_cards
       where status = 'ready'
         and archived_at is null
       group by board_id
    ),
    ranked as (
      select f.id,
             case
               when f.status in ('in_progress', 'blocked', 'review')
               then coalesce(r.max_pos, 0)
                    + ${RANK_GAP} * row_number() over (
                        partition by f.board_id
                        order by f.position, f.id
                      )
               else f.position
             end as new_position
        from foreign_owned f
        left join ready_max r on r.board_id = f.board_id
    )
    update workplace_cards c
       set owner_id = null,
           status = case
             when c.status in ('in_progress', 'blocked', 'review') then 'ready'
             else c.status
           end,
           blocked_by = case when c.status = 'blocked' then null else c.blocked_by end,
           unblock_when = case when c.status = 'blocked' then null else c.unblock_when end,
           position = ranked.new_position,
           version = c.version + 1,
           updated_at = now()
      from ranked
     where c.id = ranked.id
  `)
}
