import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  AgentIdSchema,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  WorkplaceBoardIdSchema,
  WorkplaceBoardSchema,
  WorkplaceCardIdSchema,
  WorkplaceCardSchema,
  WorkplaceChecklistItemSchema,
  WorkplaceChecklistSchema,
  WorkplaceCommentSchema,
  WorkplaceHandoverSchema,
  WorkplaceLabelSchema,
  WorkplaceLaneSchema,
  canTransitionWorkplace,
  claimAllowed,
  handoverAllowed,
  mustHaveOwner,
  type AgentId,
  type WorkplaceBoard,
  type WorkplaceCard,
  type WorkplaceChecklist,
  type WorkplaceChecklistItem,
  type WorkplaceComment,
  type WorkplaceHandover,
  type WorkplaceLabel,
  type WorkplaceLane,
  type WorkplaceMembership,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import {
  agents,
  workplaceBoardMemberships,
  workplaceBoards,
  workplaceCardLabels,
  workplaceCards,
  workplaceChecklists,
  workplaceChecklistItems,
  workplaceComments,
  workplaceHandovers,
  workplaceIdempotency,
  workplaceLabels,
} from '../schema/index.js'
import { isUniqueViolation, isUuid } from './errors.js'
import { toTimestamp } from './rows.js'

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

export type WorkplaceUnknown = { readonly outcome: 'unknown' }
export type WorkplaceStale = { readonly outcome: 'stale' }
export type WorkplaceConflict = { readonly outcome: 'conflict' }
export type WorkplaceInvalidTransition = { readonly outcome: 'invalid-transition' }
export type WorkplaceHandoverRequired = { readonly outcome: 'handover-required' }
export type WorkplaceDefaultProtected = { readonly outcome: 'default-board-protected' }
export type WorkplaceUnknownCitizen = { readonly outcome: 'unknown-citizen' }

export type WorkplaceCardSummary = WorkplaceCard & {
  readonly labelCount: number
  readonly checklistCount: number
  readonly commentCount: number
}

export type WorkplaceCardDetail = {
  readonly card: WorkplaceCard
  readonly labels: readonly WorkplaceLabel[]
  readonly checklists: readonly {
    readonly checklist: WorkplaceChecklist
    readonly items: readonly WorkplaceChecklistItem[]
  }[]
  readonly comments: readonly WorkplaceComment[]
  readonly handover: WorkplaceHandover | null
}

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

export async function getBoardFor(
  db: Database,
  callerId: AgentId,
  boardId: string,
): Promise<WorkplaceBoard | null> {
  const row = await visibleBoard(db, callerId, boardId)
  return row === null ? null : toBoard(row)
}

export async function listBoardsFor(
  db: Database,
  callerId: AgentId,
): Promise<readonly WorkplaceBoard[]> {
  const rows = await db
    .select({ board: workplaceBoards })
    .from(workplaceBoards)
    .innerJoin(
      workplaceBoardMemberships,
      and(
        eq(workplaceBoardMemberships.boardId, workplaceBoards.id),
        eq(workplaceBoardMemberships.citizenId, callerId),
      ),
    )
    .orderBy(workplaceBoards.createdAt, workplaceBoards.id)
  return rows.map((row) => toBoard(row.board))
}

export async function createBoard(
  db: Database,
  input: { readonly callerId: AgentId; readonly title: string },
): Promise<WorkplaceBoard> {
  return db.transaction(async (tx) => {
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

export type ArchiveBoardResult =
  | { readonly outcome: 'archived'; readonly board: WorkplaceBoard }
  | WorkplaceUnknown
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
  const membership = await membershipOf(db, input.callerId, input.boardId)
  if (membership === null || membership.role !== 'owner') return { outcome: 'unknown' }
  const existing = await visibleBoard(db, input.callerId, input.boardId)
  if (existing === null) return { outcome: 'unknown' }
  if (existing.kind === 'default') return { outcome: 'default-board-protected' }

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
  | WorkplaceUnknown
  | WorkplaceUnknownCitizen

export async function addMember(
  db: Database,
  input: { readonly callerId: AgentId; readonly boardId: string; readonly citizenId: string },
): Promise<AddMemberResult> {
  const membership = await membershipOf(db, input.callerId, input.boardId)
  if (membership === null || membership.role !== 'owner') return { outcome: 'unknown' }
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
    if (already === null) return { outcome: 'unknown' }
    return { outcome: 'added', membership: already }
  }
  return { outcome: 'added', membership: toMembership(row) }
}

export type RemoveMemberResult =
  | { readonly outcome: 'removed' }
  | WorkplaceUnknown
  | WorkplaceDefaultProtected
  | WorkplaceHandoverRequired

export async function removeMember(
  db: Database,
  input: { readonly callerId: AgentId; readonly boardId: string; readonly citizenId: string },
): Promise<RemoveMemberResult> {
  const membership = await membershipOf(db, input.callerId, input.boardId)
  if (membership === null || membership.role !== 'owner') return { outcome: 'unknown' }
  if (!isUuid(input.citizenId)) return { outcome: 'unknown' }

  const target = await membershipOf(db, AgentIdSchema.parse(input.citizenId), input.boardId)
  if (target === null) return { outcome: 'unknown' }
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
        }>(sql`
          select c.id as card_id,
                 (select count(*)::text from workplace_card_labels l where l.card_id = c.id) as labels,
                 (select count(*)::text from workplace_checklists k where k.card_id = c.id) as checklists,
                 (select count(*)::text from workplace_comments m where m.card_id = c.id) as comments
            from workplace_cards c
           where c.id in (${sql.join(
             ids.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})
        `)
  const byId = new Map(counts.map((row) => [row.card_id, row]))

  return {
    outcome: 'listed',
    items: page.map((row) => {
      const extra = byId.get(row.id)
      return {
        ...toCard(row),
        labelCount: Number(extra?.labels ?? 0),
        checklistCount: Number(extra?.checklists ?? 0),
        commentCount: Number(extra?.comments ?? 0),
      }
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

  const [labelRows, checklistRows, commentRows, handoverRows] = await Promise.all([
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

export type CreateCardResult =
  { readonly outcome: 'created'; readonly card: WorkplaceCard } | WorkplaceUnknown

export async function createCard(
  db: Database,
  input: {
    readonly callerId: AgentId
    readonly boardId: string
    readonly title: string
    readonly description?: string | null
    readonly status?: WorkplaceLane
    readonly priority?: string
    readonly idempotencyKey?: string
  },
): Promise<CreateCardResult> {
  return db.transaction(async (tx) => {
    const board = await visibleBoard(tx, input.callerId, input.boardId)
    if (board === null) return { outcome: 'unknown' }
    const status = input.status ?? 'inbox'
    if (mustHaveOwner(status)) return { outcome: 'unknown' }

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
  { readonly outcome: 'updated'; readonly card: WorkplaceCard } | WorkplaceUnknown | WorkplaceStale

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
  },
): Promise<UpdateCardResult> {
  const existing = await visibleCard(db, input.callerId, input.cardId)
  if (existing === null) return { outcome: 'unknown' }

  const [row] = await db
    .update(workplaceCards)
    .set({
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
      ...(input.coverColour === undefined ? {} : { coverColour: input.coverColour }),
      version: sql`${workplaceCards.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(workplaceCards.id, input.cardId), eq(workplaceCards.version, input.expectedVersion)),
    )
    .returning()
  if (row === undefined) return { outcome: 'stale' }
  return { outcome: 'updated', card: toCard(row) }
}

export type MoveCardResult =
  | { readonly outcome: 'moved'; readonly card: WorkplaceCard }
  | WorkplaceUnknown
  | WorkplaceStale
  | WorkplaceInvalidTransition

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
  const existing = await visibleCard(db, input.callerId, input.cardId)
  if (existing === null) return { outcome: 'unknown' }
  const from = WorkplaceLaneSchema.parse(existing.status)
  if (!canTransitionWorkplace(from, input.status)) return { outcome: 'invalid-transition' }
  if (mustHaveOwner(input.status) && existing.ownerId === null) {
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

  const position = input.position ?? (await nextPosition(db, existing.boardId, input.status))
  const [row] = await db
    .update(workplaceCards)
    .set({
      status: input.status,
      position,
      version: sql`${workplaceCards.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(workplaceCards.id, input.cardId), eq(workplaceCards.version, input.expectedVersion)),
    )
    .returning()
  if (row === undefined) return { outcome: 'stale' }
  return { outcome: 'moved', card: toCard(row) }
}

export type ClaimCardResult =
  | { readonly outcome: 'claimed'; readonly card: WorkplaceCard }
  | WorkplaceUnknown
  | WorkplaceConflict

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
    const stored = await replayOrStore(tx, {
      callerId: input.callerId,
      idempotencyKey: input.idempotencyKey,
      run: async () => {
        /**
         * One statement. Membership is in the `WHERE`, so a non-member and a
         * lost race both match zero rows; the follow-up read is only there to
         * name which, never to decide the write.
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
              sql`exists (select 1 from workplace_board_memberships m
                    where m.board_id = ${workplaceCards.boardId}
                      and m.citizen_id = ${input.callerId})`,
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
    if (visible === null) return { outcome: 'unknown' }
    const membership = await membershipOf(tx, input.callerId, visible.boardId)
    if (
      !claimAllowed({
        card: toCard(visible),
        caller: input.callerId,
        membership,
      })
    ) {
      return { outcome: 'conflict' }
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
  | WorkplaceUnknown
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
    const existing = await visibleCard(tx, input.callerId, input.cardId)
    if (existing === null) return { outcome: 'unknown' }
    if (!isUuid(input.to)) return { outcome: 'unknown-citizen' }
    const to = AgentIdSchema.parse(input.to)
    const callerMembership = await membershipOf(tx, input.callerId, existing.boardId)
    const targetMembership = await membershipOf(tx, to, existing.boardId)
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
  | WorkplaceUnknown
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
  const existing = await visibleCard(db, input.callerId, input.cardId)
  if (existing === null) return { outcome: 'unknown' }
  const from = WorkplaceLaneSchema.parse(existing.status)
  if (!canTransitionWorkplace(from, 'done')) return { outcome: 'invalid-transition' }
  if (existing.ownerId === null) return { outcome: 'invalid-transition' }

  const position = await nextPosition(db, existing.boardId, 'done')
  const [row] = await db
    .update(workplaceCards)
    .set({
      status: 'done',
      outcome: input.outcome,
      position,
      version: sql`${workplaceCards.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(workplaceCards.id, input.cardId), eq(workplaceCards.version, input.expectedVersion)),
    )
    .returning()
  if (row === undefined) return { outcome: 'stale' }
  return { outcome: 'completed', card: toCard(row) }
}

export type BlockCardResult =
  | { readonly outcome: 'blocked'; readonly card: WorkplaceCard }
  | WorkplaceUnknown
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
  const existing = await visibleCard(db, input.callerId, input.cardId)
  if (existing === null) return { outcome: 'unknown' }
  const from = WorkplaceLaneSchema.parse(existing.status)
  if (!canTransitionWorkplace(from, 'blocked')) return { outcome: 'invalid-transition' }
  if (existing.ownerId === null) return { outcome: 'invalid-transition' }

  const position = await nextPosition(db, existing.boardId, 'blocked')
  const [row] = await db
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
      and(eq(workplaceCards.id, input.cardId), eq(workplaceCards.version, input.expectedVersion)),
    )
    .returning()
  if (row === undefined) return { outcome: 'stale' }
  return { outcome: 'blocked', card: toCard(row) }
}

/**
 * Before the agent row goes. Cards on boards this citizen owns cascade with
 * the board; cards they owned on somebody else's board must become ownerless
 * Ready in the same transaction, or the `active_has_owner` check refuses the
 * `set null` that follows the delete.
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
               when f.status in ('in_progress', 'blocked', 'review', 'done')
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
             when c.status in ('in_progress', 'blocked', 'review', 'done') then 'ready'
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
