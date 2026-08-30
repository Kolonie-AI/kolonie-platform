import { randomUUID } from 'node:crypto'
import {
  EMPTY_WORKPLACE_LINK_COUNTS,
  WorkplaceCardIdSchema,
  WorkplaceChecklistIdSchema,
  WorkplaceChecklistItemIdSchema,
  WorkplaceCommentIdSchema,
  WorkplaceHandoverIdSchema,
  WorkplaceLinkIdSchema,
  canTransitionWorkplace,
  claimAllowed,
  handoverAllowed,
  mustHaveOwner,
  type AgentId,
  type WorkplaceCard,
  type WorkplaceCardDetail,
  type WorkplaceCardSummary,
  type WorkplaceChecklist,
  type WorkplaceChecklistItem,
  type WorkplaceComment,
  type WorkplaceHandover,
  type WorkplaceLabel,
  type WorkplaceLane,
  type WorkplaceLinkCounts,
  type WorkplaceLinkKind,
  type WorkplaceMembership,
  type WorkplaceResolvedLink,
} from '@kolonie-ai/core'
import type { WorkplaceCards } from '../workplace-cards.js'
import type {
  AddLinkResult,
  ArchiveCardResult,
  AttachLabelResult,
  BlockCardResult,
  ClaimCardResult,
  CompleteCardResult,
  CreateCardResult,
  CreateChecklistItemResult,
  CreateChecklistResult,
  CreateCommentResult,
  DeleteChecklistItemResult,
  DeleteChecklistResult,
  DetachLabelResult,
  HandoverCardResult,
  ListCardsResult,
  ListCommentsResult,
  ListLinksResult,
  MoveCardResult,
  RemoveLinkResult,
  RequestReviewResult,
  UpdateCardResult,
  UpdateChecklistItemResult,
  UpdateChecklistResult,
} from '@kolonie-ai/db'

/**
 * Cards in memory (`#1760`).
 *
 * Reproduces the storage *answers* the route branches on. Membership is
 * planted, never invented — the same rule `#1760` set for HTTP tests that
 * need a board. What Postgres does with the unique rank index is asserted
 * in `packages/db`.
 */
export interface FakeWorkplaceCards extends WorkplaceCards {
  readonly plantBoard: (boardId: string, members: readonly WorkplaceMembership[]) => void
  readonly plantCard: (card: WorkplaceCard) => void
  readonly plantLabel: (label: WorkplaceLabel) => void
  readonly plantResolvable: (kind: WorkplaceLinkKind, ref: string) => void
}

const RANK_GAP = 1000

const toSummary = (
  card: WorkplaceCard,
  extra: {
    readonly labels: number
    readonly checklists: number
    readonly comments: number
    readonly links: WorkplaceLinkCounts
  },
): WorkplaceCardSummary => ({
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
  labelCount: extra.labels,
  checklistCount: extra.checklists,
  commentCount: extra.comments,
  linkCount:
    extra.links.account +
    extra.links.provider +
    extra.links.vault +
    extra.links.task +
    extra.links.playbook +
    extra.links.url,
  linkCounts: extra.links,
})

export function fakeWorkplaceCards(): FakeWorkplaceCards {
  const seats = new Map<string, WorkplaceMembership[]>()
  const cards = new Map<string, WorkplaceCard>()
  const labels = new Map<string, WorkplaceLabel>()
  const cardLabels = new Map<string, Set<string>>()
  const checklists = new Map<string, WorkplaceChecklist>()
  const items = new Map<string, WorkplaceChecklistItem>()
  const comments = new Map<string, WorkplaceComment>()
  const handovers = new Map<string, WorkplaceHandover>()
  const links = new Map<string, WorkplaceResolvedLink>()
  const resolvable = new Set<string>()

  const membershipOf = (callerId: AgentId, boardId: string) =>
    (seats.get(boardId) ?? []).find((one) => one.citizenId === callerId)

  const visible = (callerId: AgentId, cardId: string): WorkplaceCard | null => {
    const card = cards.get(cardId)
    if (card === undefined) return null
    if (membershipOf(callerId, card.boardId) === undefined) return null
    return card
  }

  const bump = (card: WorkplaceCard, over: Partial<WorkplaceCard>): WorkplaceCard => ({
    ...card,
    ...over,
    version: card.version + 1,
    updatedAt: new Date().toISOString(),
  })

  const countsOf = (cardId: string) => {
    const ofCard = [...links.values()].filter((one) => one.cardId === cardId)
    const linkCounts: WorkplaceLinkCounts = { ...EMPTY_WORKPLACE_LINK_COUNTS }
    for (const link of ofCard) {
      linkCounts[link.kind] += 1
    }
    return {
      labels: cardLabels.get(cardId)?.size ?? 0,
      checklists: [...checklists.values()].filter((one) => one.cardId === cardId).length,
      comments: [...comments.values()].filter((one) => one.cardId === cardId).length,
      links: linkCounts,
    }
  }

  const mayWriteLink = (callerId: AgentId, card: WorkplaceCard) => {
    const membership = membershipOf(callerId, card.boardId)
    if (membership === undefined) return false
    return membership.role === 'owner' || card.ownerId === callerId
  }

  const resolvedOf = (kind: WorkplaceLinkKind, ref: string): WorkplaceResolvedLink['target'] => {
    if (kind === 'url') return { state: 'resolved', kind: 'url' }
    if (kind === 'vault') {
      return { state: 'resolved', kind: 'vault', name: ref, held: resolvable.has(`vault:${ref}`) }
    }
    if (!resolvable.has(`${kind}:${ref}`)) return { state: 'unresolvable', kind }
    if (kind === 'account') {
      return {
        state: 'resolved',
        kind: 'account',
        provider: 'mail.tm',
        identifier: 'owner@example.test',
        proved: true,
      }
    }
    if (kind === 'provider') {
      return { state: 'resolved', kind: 'provider', title: ref, category: 'mailbox' }
    }
    if (kind === 'task') {
      return { state: 'resolved', kind: 'task', title: 'Create an email address', status: 'active' }
    }
    return { state: 'resolved', kind: 'playbook', title: 'Weekly inbox triage', status: 'open' }
  }

  const nextPosition = (boardId: string, status: WorkplaceLane): number => {
    const max = [...cards.values()]
      .filter((one) => one.boardId === boardId && one.status === status && one.archivedAt === null)
      .reduce((acc, one) => Math.max(acc, one.position), 0)
    return max + RANK_GAP
  }

  return {
    plantBoard: (boardId, members) => {
      seats.set(boardId, [...members])
    },
    plantCard: (card) => {
      cards.set(card.id, card)
    },
    plantLabel: (label) => {
      labels.set(label.id, label)
    },
    plantResolvable: (kind: WorkplaceLinkKind, ref: string) => {
      resolvable.add(`${kind}:${ref}`)
    },

    list: async (callerId, boardId, query = {}) => {
      if (membershipOf(callerId, boardId) === undefined) return { outcome: 'unknown' }
      if (query.cursor !== undefined && query.cursor !== null && query.cursor !== '') {
        if (
          ![...cards.values()].some((one) => one.id === query.cursor) &&
          query.cursor !== 'next'
        ) {
          return { outcome: 'invalid-cursor' }
        }
      }
      const live = [...cards.values()]
        .filter(
          (card) =>
            card.boardId === boardId &&
            card.archivedAt === null &&
            (query.status === undefined || card.status === query.status),
        )
        .sort(
          (a, b) =>
            a.status.localeCompare(b.status) || a.position - b.position || a.id.localeCompare(b.id),
        )
      if (
        live.length === 0 &&
        (query.cursor === undefined || query.cursor === null || query.cursor === '')
      ) {
        return { outcome: 'empty' }
      }
      const limit = query.limit ?? live.length
      const start =
        query.cursor !== undefined && query.cursor !== null && query.cursor !== ''
          ? live.findIndex((one) => one.id === query.cursor) + 1
          : 0
      const page = live.slice(Math.max(start, 0), Math.max(start, 0) + limit)
      const last = page[page.length - 1]
      const more = start + page.length < live.length
      return {
        outcome: 'listed',
        items: page.map((card) => toSummary(card, countsOf(card.id))),
        nextCursor: more && last !== undefined ? last.id : null,
      } satisfies ListCardsResult
    },

    get: async (callerId, cardId) => {
      const card = visible(callerId, cardId)
      if (card === null) return null
      const attached = [...(cardLabels.get(cardId) ?? [])].flatMap((id) => {
        const label = labels.get(id)
        return label === undefined ? [] : [label]
      })
      const lists = [...checklists.values()].filter((one) => one.cardId === cardId)
      return {
        card,
        labels: attached,
        checklists: lists.map((checklist) => ({
          checklist,
          items: [...items.values()].filter((one) => one.checklistId === checklist.id),
        })),
        comments: [...comments.values()]
          .filter((one) => one.cardId === cardId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        links: [...links.values()]
          .filter((one) => one.cardId === cardId)
          .sort((a, b) => a.id.localeCompare(b.id)),
        handover:
          [...handovers.values()].find((one) => one.cardId === cardId && one.isCurrent) ?? null,
      } satisfies WorkplaceCardDetail
    },

    create: async (input) => {
      if (membershipOf(input.callerId, input.boardId) === undefined) {
        return { outcome: 'missing' } satisfies CreateCardResult
      }
      const status = input.status ?? 'inbox'
      if (status !== 'inbox' && status !== 'ready') return { outcome: 'invalid-transition' }
      const now = new Date().toISOString()
      const card: WorkplaceCard = {
        id: WorkplaceCardIdSchema.parse(randomUUID()),
        boardId: input.boardId as WorkplaceCard['boardId'],
        status,
        title: input.title,
        description: input.description ?? null,
        ownerId: null,
        position: nextPosition(input.boardId, status),
        priority: input.priority ?? 'unset',
        dueAt: input.dueAt ?? null,
        blockedBy: null,
        unblockWhen: null,
        outcome: null,
        version: 1,
        coverColour: input.coverColour ?? null,
        seedKey: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      cards.set(card.id, card)
      return { outcome: 'created', card }
    },

    update: async (input) => {
      const card = cards.get(input.cardId)
      if (card === undefined) return { outcome: 'missing' } satisfies UpdateCardResult
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'forbidden' }
      if (card.version !== input.expectedVersion) return { outcome: 'stale' }
      const updated = bump(card, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
        ...(input.coverColour === undefined ? {} : { coverColour: input.coverColour }),
        ...(input.position === undefined ? {} : { position: input.position }),
      })
      cards.set(card.id, updated)
      return { outcome: 'updated', card: updated }
    },

    claim: async (input) => {
      const card = cards.get(input.cardId)
      if (card === undefined) return { outcome: 'missing' } satisfies ClaimCardResult
      const membership = membershipOf(input.callerId, card.boardId) ?? null
      if (membership === null) return { outcome: 'forbidden' }
      if (
        !claimAllowed({ card, caller: input.callerId, membership }) ||
        card.version !== input.expectedVersion
      ) {
        return { outcome: 'conflict' }
      }
      const claimed = bump(card, {
        ownerId: input.callerId,
        status: 'in_progress',
        position: nextPosition(card.boardId, 'in_progress'),
      })
      cards.set(card.id, claimed)
      return { outcome: 'claimed', card: claimed }
    },

    move: async (input) => {
      const card = cards.get(input.cardId)
      if (card === undefined) return { outcome: 'missing' } satisfies MoveCardResult
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'forbidden' }
      if (card.version !== input.expectedVersion) return { outcome: 'stale' }
      if (!canTransitionWorkplace(card.status, input.status))
        return { outcome: 'invalid-transition' }
      let ownerId = card.ownerId
      if (input.status === 'in_progress' && card.ownerId === null) {
        ownerId = input.callerId
      } else if (input.status === 'in_progress' && card.ownerId !== input.callerId) {
        return { outcome: 'handover-required' }
      } else if (mustHaveOwner(input.status) && card.ownerId === null) {
        return { outcome: 'invalid-transition' }
      }
      if (input.status === 'blocked' && (card.blockedBy === null || card.unblockWhen === null)) {
        return { outcome: 'invalid-transition' }
      }
      if (input.status === 'done' && card.outcome === null) return { outcome: 'invalid-transition' }
      const unclaim = card.status === 'in_progress' && input.status === 'ready'
      const moved = bump(card, {
        status: input.status,
        position: input.position ?? nextPosition(card.boardId, input.status),
        ...(unclaim ? { ownerId: null } : ownerId !== card.ownerId ? { ownerId } : {}),
      })
      cards.set(card.id, moved)
      return { outcome: 'moved', card: moved }
    },

    block: async (input) => {
      const card = cards.get(input.cardId)
      if (card === undefined) return { outcome: 'missing' } satisfies BlockCardResult
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'forbidden' }
      if (card.version !== input.expectedVersion) return { outcome: 'stale' }
      if (!canTransitionWorkplace(card.status, 'blocked') || card.ownerId === null) {
        return { outcome: 'invalid-transition' }
      }
      const blocked = bump(card, {
        status: 'blocked',
        blockedBy: input.blockedBy,
        unblockWhen: input.unblockWhen,
        position: nextPosition(card.boardId, 'blocked'),
      })
      cards.set(card.id, blocked)
      return { outcome: 'blocked', card: blocked }
    },

    requestReview: async (input) => {
      const card = cards.get(input.cardId)
      if (card === undefined) return { outcome: 'missing' } satisfies RequestReviewResult
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'forbidden' }
      if (card.version !== input.expectedVersion) return { outcome: 'stale' }
      if (!canTransitionWorkplace(card.status, 'review') || card.ownerId === null) {
        return { outcome: 'invalid-transition' }
      }
      const reviewed = bump(card, {
        status: 'review',
        position: nextPosition(card.boardId, 'review'),
      })
      cards.set(card.id, reviewed)
      return { outcome: 'reviewed', card: reviewed }
    },

    complete: async (input) => {
      const card = cards.get(input.cardId)
      if (card === undefined) return { outcome: 'missing' } satisfies CompleteCardResult
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'forbidden' }
      if (card.version !== input.expectedVersion) return { outcome: 'stale' }
      if (!canTransitionWorkplace(card.status, 'done') || card.ownerId === null) {
        return { outcome: 'invalid-transition' }
      }
      const done = bump(card, {
        status: 'done',
        outcome: input.outcome,
        position: nextPosition(card.boardId, 'done'),
      })
      cards.set(card.id, done)
      return { outcome: 'completed', card: done }
    },

    handover: async (input) => {
      const card = cards.get(input.cardId)
      if (card === undefined) return { outcome: 'missing' } satisfies HandoverCardResult
      const callerMembership = membershipOf(input.callerId, card.boardId) ?? null
      if (callerMembership === null) return { outcome: 'forbidden' }
      if (card.version !== input.expectedVersion) return { outcome: 'stale' }
      const targetMembership = membershipOf(input.to as AgentId, card.boardId) ?? null
      if (targetMembership === null) return { outcome: 'unknown-citizen' }
      if (
        !handoverAllowed({
          card,
          caller: input.callerId,
          callerMembership,
          targetMembership,
        })
      ) {
        return { outcome: 'handover-required' }
      }
      const now = new Date().toISOString()
      const handed = bump(card, { ownerId: input.to as AgentId })
      cards.set(card.id, handed)
      for (const [id, one] of handovers) {
        if (one.cardId === card.id && one.isCurrent) {
          handovers.set(id, { ...one, isCurrent: false, updatedAt: now })
        }
      }
      const handover: WorkplaceHandover = {
        id: WorkplaceHandoverIdSchema.parse(randomUUID()),
        cardId: card.id,
        from: input.callerId,
        to: input.to as AgentId,
        done: input.done,
        learned: input.learned,
        next: input.next,
        blocked: input.blocked ?? null,
        evidenceLinks: [...(input.evidenceLinks ?? [])],
        isCurrent: true,
        createdAt: now,
        updatedAt: now,
      }
      handovers.set(handover.id, handover)
      return { outcome: 'handed-over', card: handed, handover }
    },

    archive: async (input) => {
      const card = cards.get(input.cardId)
      if (card === undefined) return { outcome: 'missing' } satisfies ArchiveCardResult
      const seat = membershipOf(input.callerId, card.boardId)
      if (seat === undefined) return { outcome: 'forbidden' }
      if (seat.role !== 'owner') return { outcome: 'forbidden' }
      if (card.version !== input.expectedVersion) return { outcome: 'stale' }
      if (!canTransitionWorkplace(card.status, 'archived')) return { outcome: 'invalid-transition' }
      const archived = bump(card, { archivedAt: new Date().toISOString() })
      cards.set(card.id, archived)
      return { outcome: 'archived', card: archived }
    },

    attachLabel: async (input) => {
      const card = cards.get(input.cardId)
      if (card === undefined) return { outcome: 'missing' } satisfies AttachLabelResult
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'forbidden' }
      const label = labels.get(input.labelId)
      if (label === undefined || label.boardId !== card.boardId) return { outcome: 'missing' }
      const set = cardLabels.get(input.cardId) ?? new Set<string>()
      set.add(input.labelId)
      cardLabels.set(input.cardId, set)
      return { outcome: 'attached', label }
    },

    detachLabel: async (input) => {
      const card = cards.get(input.cardId)
      if (card === undefined) return { outcome: 'missing' } satisfies DetachLabelResult
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'forbidden' }
      cardLabels.get(input.cardId)?.delete(input.labelId)
      return { outcome: 'detached' }
    },

    createChecklist: async (input) => {
      const card = cards.get(input.cardId)
      if (card === undefined) return { outcome: 'missing' } satisfies CreateChecklistResult
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'forbidden' }
      const position = [...checklists.values()].filter((one) => one.cardId === input.cardId).length
      const checklist: WorkplaceChecklist = {
        id: WorkplaceChecklistIdSchema.parse(randomUUID()),
        cardId: card.id,
        title: input.title,
        position,
      }
      checklists.set(checklist.id, checklist)
      return { outcome: 'created', checklist }
    },

    updateChecklist: async (input) => {
      const checklist = checklists.get(input.checklistId)
      if (checklist === undefined) return { outcome: 'missing' } satisfies UpdateChecklistResult
      const card = cards.get(checklist.cardId)
      if (card === undefined) return { outcome: 'missing' }
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'forbidden' }
      const updated = {
        ...checklist,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.position === undefined ? {} : { position: input.position }),
      }
      checklists.set(checklist.id, updated)
      return { outcome: 'updated', checklist: updated }
    },

    deleteChecklist: async (input) => {
      const checklist = checklists.get(input.checklistId)
      if (checklist === undefined) return { outcome: 'missing' } satisfies DeleteChecklistResult
      const card = cards.get(checklist.cardId)
      if (card === undefined) return { outcome: 'missing' }
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'forbidden' }
      checklists.delete(input.checklistId)
      for (const [id, item] of items) {
        if (item.checklistId === input.checklistId) items.delete(id)
      }
      return { outcome: 'deleted' }
    },

    createChecklistItem: async (input) => {
      const checklist = checklists.get(input.checklistId)
      if (checklist === undefined) return { outcome: 'missing' } satisfies CreateChecklistItemResult
      const card = cards.get(checklist.cardId)
      if (card === undefined) return { outcome: 'missing' }
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'forbidden' }
      const position = [...items.values()].filter(
        (one) => one.checklistId === input.checklistId,
      ).length
      const item: WorkplaceChecklistItem = {
        id: WorkplaceChecklistItemIdSchema.parse(randomUUID()),
        checklistId: checklist.id,
        title: input.title,
        doneAt: null,
        position,
      }
      items.set(item.id, item)
      return { outcome: 'created', item }
    },

    updateChecklistItem: async (input) => {
      const item = items.get(input.itemId)
      if (item === undefined) return { outcome: 'missing' } satisfies UpdateChecklistItemResult
      const checklist = checklists.get(item.checklistId)
      if (checklist === undefined) return { outcome: 'missing' }
      const card = cards.get(checklist.cardId)
      if (card === undefined) return { outcome: 'missing' }
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'forbidden' }
      const updated = {
        ...item,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.doneAt === undefined ? {} : { doneAt: input.doneAt }),
        ...(input.position === undefined ? {} : { position: input.position }),
      }
      items.set(item.id, updated)
      return { outcome: 'updated', item: updated }
    },

    deleteChecklistItem: async (input) => {
      const item = items.get(input.itemId)
      if (item === undefined) return { outcome: 'missing' } satisfies DeleteChecklistItemResult
      const checklist = checklists.get(item.checklistId)
      if (checklist === undefined) return { outcome: 'missing' }
      const card = cards.get(checklist.cardId)
      if (card === undefined) return { outcome: 'missing' }
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'forbidden' }
      items.delete(input.itemId)
      return { outcome: 'deleted' }
    },

    listComments: async (callerId, cardId, query = {}) => {
      if (visible(callerId, cardId) === null)
        return { outcome: 'unknown' } satisfies ListCommentsResult
      const listed = [...comments.values()]
        .filter((one) => one.cardId === cardId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      if (
        listed.length === 0 &&
        (query.cursor === undefined || query.cursor === null || query.cursor === '')
      ) {
        return { outcome: 'empty' }
      }
      if (query.cursor !== undefined && query.cursor !== null && query.cursor !== '') {
        if (!listed.some((one) => one.id === query.cursor)) return { outcome: 'invalid-cursor' }
      }
      const limit = query.limit ?? listed.length
      const start =
        query.cursor !== undefined && query.cursor !== null && query.cursor !== ''
          ? listed.findIndex((one) => one.id === query.cursor) + 1
          : 0
      const page = listed.slice(Math.max(start, 0), Math.max(start, 0) + limit)
      const last = page[page.length - 1]
      const more = start + page.length < listed.length
      return {
        outcome: 'listed',
        items: page,
        nextCursor: more && last !== undefined ? last.id : null,
      }
    },

    createComment: async (input) => {
      const card = cards.get(input.cardId)
      if (card === undefined) return { outcome: 'missing' } satisfies CreateCommentResult
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'forbidden' }
      const now = new Date().toISOString()
      const comment: WorkplaceComment = {
        id: WorkplaceCommentIdSchema.parse(randomUUID()),
        cardId: card.id,
        authorId: input.callerId,
        body: input.body,
        createdAt: now,
        updatedAt: now,
      }
      comments.set(comment.id, comment)
      return { outcome: 'created', comment }
    },

    listLinks: async (callerId, cardId) => {
      if (visible(callerId, cardId) === null) return { outcome: 'unknown' }
      const items = [...links.values()]
        .filter((one) => one.cardId === cardId)
        .sort((a, b) => a.id.localeCompare(b.id))
      if (items.length === 0) return { outcome: 'empty' }
      return { outcome: 'listed', items } satisfies ListLinksResult
    },

    addLink: async (input) => {
      const card = cards.get(input.cardId)
      if (card === undefined) return { outcome: 'missing' } satisfies AddLinkResult
      if (membershipOf(input.callerId, card.boardId) === undefined) {
        return { outcome: 'forbidden' }
      }
      if (!mayWriteLink(input.callerId, card)) return { outcome: 'forbidden' }
      if (input.kind !== 'url' && !resolvable.has(`${input.kind}:${input.ref}`)) {
        return { outcome: 'unresolvable' }
      }
      const existing = [...links.values()].find(
        (one) => one.cardId === input.cardId && one.kind === input.kind && one.ref === input.ref,
      )
      if (existing !== undefined) return { outcome: 'created', link: existing }
      const link: WorkplaceResolvedLink = {
        id: WorkplaceLinkIdSchema.parse(randomUUID()),
        cardId: card.id,
        kind: input.kind,
        ref: input.ref,
        ...(input.note === undefined ? {} : { note: input.note }),
        target: resolvedOf(input.kind, input.ref),
      }
      links.set(link.id, link)
      return { outcome: 'created', link }
    },

    removeLink: async (input) => {
      const link = links.get(input.linkId)
      if (link === undefined) return { outcome: 'missing' } satisfies RemoveLinkResult
      const card = cards.get(link.cardId)
      if (card === undefined) return { outcome: 'missing' }
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'missing' }
      if (!mayWriteLink(input.callerId, card)) return { outcome: 'forbidden' }
      links.delete(input.linkId)
      return { outcome: 'removed' }
    },
  }
}
