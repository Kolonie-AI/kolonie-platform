import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  AgentIdSchema,
  DEFAULT_PAGE_SIZE,
  EMPTY_WORKPLACE_LINK_COUNTS,
  MAX_PAGE_SIZE,
  WorkplaceBoardIdSchema,
  WorkplaceBoardSchema,
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
  claimAllowed,
  handoverAllowed,
  mustHaveOwner,
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
  type WorkplaceLinkKind,
  type WorkplaceLinkTarget,
  type WorkplaceMembership,
  type WorkplaceResolvedLink,
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
  workplaceComments,
  workplaceHandovers,
  workplaceIdempotency,
  workplaceLabels,
} from '../schema/index.js'
import { isUniqueViolation, isUuid } from './errors.js'
import { toTimestamp } from './rows.js'
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

export async function listBoardsFor(
  db: Database,
  callerId: AgentId,
  query: { readonly cursor?: string | null; readonly limit?: number } = {},
): Promise<ListBoardsResult> {
  const after = decodeBoardCursor(query.cursor)
  if (after === 'invalid') return { outcome: 'invalid-cursor' }
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)

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
