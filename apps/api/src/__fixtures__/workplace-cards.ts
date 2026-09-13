import { createHash, randomUUID } from 'node:crypto'
import {
  EMPTY_WORKPLACE_LINK_COUNTS,
  WORKPLACE_PRACTICUM_CARD_TITLES,
  WorkplaceCardIdSchema,
  WorkplaceCardClosureIdSchema,
  WorkplaceChecklistIdSchema,
  WorkplaceChecklistItemIdSchema,
  WorkplaceCommentIdSchema,
  WorkplaceHandoverIdSchema,
  WorkplaceLinkIdSchema,
  canTransitionWorkplace,
  handoverAllowed,
  mustHaveOwner,
  type AgentId,
  type WorkplaceCard,
  type WorkplaceCardClosure,
  type WorkplaceRecallHit,
  type WorkplaceRecallRequest,
  type WorkplaceCardEvent,
  type WorkplaceCardDetail,
  type WorkplaceCardSummary,
  type WorkplaceCommitment,
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
import type { WorkplaceBoards } from '../workplace-boards.js'
import type {
  AddLinkResult,
  ArchiveCardResult,
  RecallWorkplaceResult,
  AttachLabelResult,
  BlockCardResult,
  ClaimCardResult,
  CompleteCardResult,
  CreateCardClosureResult,
  CreateCardResult,
  CreateChecklistItemResult,
  CreateChecklistResult,
  CreateCommentResult,
  DeleteChecklistItemResult,
  DeleteChecklistResult,
  DetachLabelResult,
  HandoverCardResult,
  ListCardsResult,
  ListCardClosuresResult,
  ListCommentsResult,
  ListLinksResult,
  MoveCardResult,
  RemoveLinkResult,
  RequestReviewResult,
  StartProfessionPracticumResult,
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
  kind: card.kind,
  parentInitiativeId: card.parentInitiativeId,
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

export function fakeWorkplaceCards(boards?: WorkplaceBoards): FakeWorkplaceCards {
  const seats = new Map<string, WorkplaceMembership[]>()
  const cards = new Map<string, WorkplaceCard>()
  const events = new Map<string, WorkplaceCardEvent[]>()
  const closures = new Map<string, WorkplaceCardClosure[]>()
  const commitments = new Map<AgentId, WorkplaceCommitment>()
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

  const focusFor = async (
    callerId: AgentId,
    focusCardId: string,
  ): Promise<WorkplaceCard | null> => {
    const card = cards.get(focusCardId)
    if (card === undefined || card.archivedAt !== null) return null
    if (boards !== undefined) {
      const board = await boards.get(callerId, card.boardId)
      return board !== null && board.kind === 'default' && board.ownerId === callerId ? card : null
    }
    const owners = seats.get(card.boardId) ?? []
    return owners.some((one) => one.citizenId === callerId && one.role === 'owner') ? card : null
  }

  const boardTitleOf = async (callerId: AgentId, boardId: string): Promise<string> => {
    if (boards !== undefined) {
      const board = await boards.get(callerId, boardId)
      if (board !== null) return board.title
    }
    return `Board ${boardId.slice(0, 8)}`
  }

  /**
   * Recall over the planted rows, mirroring storage's answer shape (`#1943`).
   *
   * **A row store, not a rule copy**: boards in seats with their planted
   * titles, cards in the map, the closures the tests planted. The rules it
   * does restate — scope resolution, filters before ranking, the cursor's
   * query/filter hash — are the ones routes branch on; ranking itself is
   * substring relevance, enough for route tests to see ordering and
   * pagination without Postgres. The hash and cursor shape are copied from
   * `computeRecallHash`/`encodeRecallCursor` in
   * `packages/db/src/storage/workplace.ts`.
   */
  // @mirrors packages/db/src/storage/workplace.ts recallWorkplace 9532b229
  const recall = async (
    callerId: AgentId,
    request: WorkplaceRecallRequest,
  ): Promise<RecallWorkplaceResult> => {
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          q: request.query.toLowerCase(),
          scope: request.scope,
          boardId: request.boardId ?? null,
          kinds: (request.kinds ?? ['card', 'closure']).slice().sort(),
          result: (request.result ?? []).slice().sort(),
          status: (request.status ?? []).slice().sort(),
          from: request.from ?? null,
          to: request.to ?? null,
        }),
      )
      .digest('hex')
      .slice(0, 16)
    let after: { h: string; r: number; m: string; t: 'card' | 'closure'; id: string } | undefined
    if (request.cursor !== undefined && request.cursor !== '') {
      if (!/^[A-Za-z0-9_-]+$/.test(request.cursor)) return { outcome: 'invalid-cursor' }
      try {
        const parsed = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'))
        if (typeof parsed !== 'object' || parsed === null || parsed.h !== hash) {
          return { outcome: 'invalid-cursor' }
        }
        after = parsed as typeof after
      } catch {
        return { outcome: 'invalid-cursor' }
      }
    }

    const allowedBoards: string[] = []
    if (request.scope === 'board') {
      if (request.boardId === undefined || membershipOf(callerId, request.boardId) === undefined) {
        return { outcome: 'missing' }
      }
      allowedBoards.push(request.boardId)
    } else {
      const mine = [...seats.entries()]
        .filter(([, mems]) => mems.some((one) => one.citizenId === callerId))
        .map(([boardId]) => boardId)
      if (request.scope === 'my_default') {
        let def: string | undefined
        if (boards !== undefined) {
          const listed = await boards.list(callerId)
          if (listed.outcome === 'listed') {
            def = listed.items.find((one) => one.kind === 'default')?.id
          }
        }
        if (def === undefined) {
          def = mine.find((boardId) => {
            const mems = seats.get(boardId) ?? []
            return mems.some((one) => one.citizenId === callerId && one.role === 'owner')
          })
        }
        if (def === undefined) return { outcome: 'recalled', items: [], nextCursor: null }
        allowedBoards.push(def)
      } else {
        allowedBoards.push(...mine)
      }
    }

    const query = request.query.toLowerCase()
    const kinds = request.kinds ?? ['card', 'closure']
    type Candidate = {
      rank: number
      matchedAt: string
      type: 'card' | 'closure'
      id: string
      hit: WorkplaceRecallHit
    }
    const candidates: Candidate[] = []

    if (kinds.includes('card') && (request.result === undefined || request.result.length === 0)) {
      for (const card of cards.values()) {
        if (!allowedBoards.includes(card.boardId)) continue
        if (card.archivedAt !== null) continue
        if (request.status !== undefined && !request.status.includes(card.status)) continue
        const haystack = `${card.title} ${card.description ?? ''}`.toLowerCase()
        if (!haystack.includes(query)) continue
        const matchedAt = card.updatedAt
        if (request.from !== undefined && matchedAt < request.from) continue
        if (request.to !== undefined && matchedAt > request.to) continue
        candidates.push({
          rank: card.title.toLowerCase().includes(query) ? 2 : 1,
          matchedAt,
          type: 'card',
          id: card.id,
          hit: {
            type: 'card',
            board: { id: card.boardId, title: await boardTitleOf(callerId, card.boardId) },
            card: { id: card.id, title: card.title, status: card.status, kind: card.kind },
            matchedAt,
            highlights: [card.title.slice(0, 240)],
            read: {
              tool: 'kolonie.workplace',
              arguments: { act: 'get', subject: 'card', id: card.id },
            },
          },
        })
      }
    }

    if (kinds.includes('closure')) {
      for (const [cardId, history] of closures) {
        const card = cards.get(cardId)
        if (card === undefined) continue
        if (!allowedBoards.includes(card.boardId)) continue
        if (card.archivedAt !== null) continue
        if (request.status !== undefined && !request.status.includes(card.status)) continue
        for (const closure of history) {
          if (
            request.result !== undefined &&
            request.result.length > 0 &&
            !request.result.includes(closure.result)
          ) {
            continue
          }
          const refHaystack = closure.evidenceLinks
            .flatMap((link) => link.ref.split(/[^A-Za-z0-9-]+/))
            .join(' ')
            .toLowerCase()
          const haystack = `${closure.summary} ${closure.learned} ${refHaystack}`.toLowerCase()
          if (!haystack.includes(query)) continue
          const matchedAt = closure.createdAt
          if (request.from !== undefined && matchedAt < request.from) continue
          if (request.to !== undefined && matchedAt > request.to) continue
          candidates.push({
            rank: closure.summary.toLowerCase().includes(query) ? 2 : 1,
            matchedAt,
            type: 'closure',
            id: closure.id,
            hit: {
              type: 'closure',
              board: { id: card.boardId, title: await boardTitleOf(callerId, card.boardId) },
              card: { id: card.id, title: card.title, status: card.status, kind: card.kind },
              closure: { id: closure.id, revision: closure.revision, result: closure.result },
              matchedAt,
              highlights: [closure.summary.slice(0, 240)],
              read: {
                tool: 'kolonie.workplace',
                arguments: { act: 'get', subject: 'card', id: card.id },
              },
            },
          })
        }
      }
    }

    candidates.sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank
      if (b.matchedAt !== a.matchedAt) return b.matchedAt < a.matchedAt ? -1 : 1
      if (a.type !== b.type) return a.type < b.type ? -1 : 1
      return a.id < b.id ? -1 : 1
    })

    const afterIndex =
      after === undefined
        ? -1
        : candidates.findIndex((one) => one.id === after.id && one.type === after.t)
    if (after !== undefined && afterIndex < 0) return { outcome: 'invalid-cursor' }
    const live = candidates.slice(afterIndex + 1)
    const limit = Math.min(Math.max(request.limit ?? 10, 1), 50)
    const page = live.slice(0, limit)
    const last = page[page.length - 1]
    const nextCursor =
      live.length > limit && last !== undefined
        ? Buffer.from(
            JSON.stringify({
              h: hash,
              r: last.rank,
              m: last.matchedAt,
              t: last.type,
              id: last.id,
            }),
            'utf8',
          ).toString('base64url')
        : null
    return { outcome: 'recalled', items: page.map((one) => one.hit), nextCursor }
  }

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

  const appendEvent = (
    callerId: AgentId,
    card: WorkplaceCard,
    verb: WorkplaceCardEvent['verb'],
    payload: Record<string, unknown>,
    attribution?: Parameters<WorkplaceCards['create']>[0]['attribution'],
  ) => {
    const actorKind = attribution?.actorKind ?? 'citizen'
    const event: WorkplaceCardEvent = {
      id: randomUUID(),
      boardId: card.boardId,
      cardId: card.id,
      actorId: actorKind === 'system' ? null : (attribution?.actorId ?? callerId),
      actorKind,
      actorHumanId:
        actorKind === 'human-linked' && attribution?.actorHumanId !== undefined
          ? (attribution.actorHumanId as WorkplaceCardEvent['actorHumanId'])
          : null,
      subjectAgentId: attribution?.subjectAgentId ?? null,
      delegationId: (attribution?.delegationId as WorkplaceCardEvent['delegationId']) ?? null,
      verb,
      payload,
      legacy: false,
      createdAt: new Date().toISOString(),
    }
    events.set(card.id, [event, ...(events.get(card.id) ?? [])])
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

    setCommitment: async (input) => {
      if (
        input.focusCardId !== undefined &&
        input.focusCardId !== null &&
        (await focusFor(input.callerId, input.focusCardId)) === null
      ) {
        return { outcome: 'missing' as const }
      }
      /**
       * The fixture stores rows; the citizen-only rule is production's, and
       * the MCP tool refuses a candidate before this is ever reached.
       */
      const existing = commitments.get(input.callerId)
      if (existing !== undefined && input.expectedVersion !== existing.version) {
        return { outcome: 'stale' as const }
      }
      const commitment: WorkplaceCommitment = {
        outcome: input.outcome,
        nextAction: input.nextAction,
        reviewAt: input.reviewAt,
        state: input.state,
        ...(input.blocker === undefined ? {} : { blocker: input.blocker }),
        focusCardId:
          input.focusCardId === undefined ? (existing?.focusCardId ?? null) : input.focusCardId,
        version: (existing?.version ?? 0) + 1,
      }
      commitments.set(input.callerId, commitment)
      return { outcome: 'set' as const, commitment }
    },
    readCommitment: async (callerId) => commitments.get(callerId) ?? null,
    advanceCommitment: async (input) => {
      if (
        input.focusCardId !== undefined &&
        input.focusCardId !== null &&
        (await focusFor(input.callerId, input.focusCardId)) === null
      ) {
        return { outcome: 'missing' as const }
      }
      const existing = commitments.get(input.callerId)
      if (existing === undefined) return { outcome: 'missing' as const }
      if (existing.version !== input.expectedVersion) return { outcome: 'stale' as const }
      const commitment: WorkplaceCommitment = {
        outcome: existing.outcome,
        nextAction: input.nextAction,
        reviewAt: input.reviewAt ?? existing.reviewAt,
        state: input.state,
        ...(input.blocker === undefined ? {} : { blocker: input.blocker }),
        focusCardId: input.focusCardId === undefined ? existing.focusCardId : input.focusCardId,
        version: existing.version + 1,
      }
      commitments.set(input.callerId, commitment)
      return { outcome: 'advanced' as const, commitment }
    },
    endCommitment: async (input) => {
      commitments.delete(input.callerId)
      return { outcome: 'ended' as const }
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
            (query.status === undefined || card.status === query.status) &&
            (query.kind === undefined || card.kind === query.kind) &&
            (query.parentInitiativeId === undefined ||
              card.parentInitiativeId === query.parentInitiativeId),
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
        latestClosure: closures.get(cardId)?.[0] ?? null,
        closureCount: closures.get(cardId)?.length ?? 0,
        eventCount: events.get(cardId)?.length ?? 0,
        events: (events.get(cardId) ?? []).slice(0, 5),
        ...(card.kind === 'initiative'
          ? {
              actionCounts: {
                total: [...cards.values()].filter(
                  (one) => one.parentInitiativeId === card.id && one.archivedAt === null,
                ).length,
                done: [...cards.values()].filter(
                  (one) =>
                    one.parentInitiativeId === card.id &&
                    one.archivedAt === null &&
                    one.status === 'done',
                ).length,
                active: [...cards.values()].filter(
                  (one) =>
                    one.parentInitiativeId === card.id &&
                    one.archivedAt === null &&
                    one.status !== 'done',
                ).length,
              },
              nextActions: [...cards.values()]
                .filter(
                  (one) =>
                    one.parentInitiativeId === card.id &&
                    one.archivedAt === null &&
                    (one.status === 'ready' ||
                      (one.status === 'in_progress' && one.ownerId === callerId) ||
                      (one.status === 'blocked' && one.ownerId === callerId)),
                )
                .slice(0, 5)
                .map((one) => ({
                  id: one.id,
                  title: one.title,
                  status: one.status,
                  ownerId: one.ownerId,
                  version: one.version,
                })),
            }
          : {}),
      } satisfies WorkplaceCardDetail
    },

    events: async (callerId, cardId, query = {}) => {
      if (visible(callerId, cardId) === null) return { outcome: 'unknown' as const }
      const all = events.get(cardId) ?? []
      const start =
        query.cursor === undefined || query.cursor === null || query.cursor === ''
          ? 0
          : all.findIndex((event) => event.id === query.cursor) + 1
      if (query.cursor !== undefined && query.cursor !== null && start === 0) {
        return { outcome: 'invalid-cursor' as const }
      }
      const limit = query.limit ?? 50
      const items = all.slice(start, start + limit)
      return {
        outcome: 'listed' as const,
        items,
        nextCursor:
          start + items.length < all.length ? (items[items.length - 1]?.id ?? null) : null,
      }
    },

    closures: async (callerId, cardId, query = {}) => {
      if (visible(callerId, cardId) === null) return { outcome: 'unknown' as const }
      const all = closures.get(cardId) ?? []
      const start =
        query.cursor === undefined || query.cursor === null || query.cursor === ''
          ? 0
          : all.findIndex((closure) => closure.id === query.cursor) + 1
      if (query.cursor !== undefined && query.cursor !== null && start === 0) {
        return { outcome: 'invalid-cursor' as const }
      }
      const limit = query.limit ?? 50
      const page = all.slice(start, start + limit)
      return {
        outcome: 'listed' as const,
        items: page,
        nextCursor: start + page.length < all.length ? (page[page.length - 1]?.id ?? null) : null,
      } satisfies ListCardClosuresResult
    },

    recall,

    /**
     * Explicit practicum acceptance (`#1835`). The five titles come from the
     * core contract; this fixture only stores the rows and converges retries.
     */
    acceptPracticum: async (input): Promise<StartProfessionPracticumResult> => {
      const boardId = [...seats.entries()].find(([, memberships]) =>
        memberships.some(
          (membership) => membership.citizenId === input.callerId && membership.role === 'owner',
        ),
      )?.[0]
      if (boardId === undefined) return { outcome: 'citizen-required' }
      const existing = [...cards.values()].filter(
        (card) =>
          card.boardId === boardId &&
          card.seedKey?.startsWith('practicum:') === true &&
          !card.seedKey.includes('#'),
      )
      if (existing.length > 0) {
        const id = existing[0]?.seedKey?.split(':card:')[0]
        if (id === undefined) throw new Error('practicum card has no cycle identifier')
        return { outcome: 'started', cycle: { id, boardId: boardId as never, cards: existing } }
      }
      const id = `practicum:${randomUUID()}`
      const now = new Date().toISOString()
      const made = WORKPLACE_PRACTICUM_CARD_TITLES.map((title, index): WorkplaceCard => ({
        id: WorkplaceCardIdSchema.parse(randomUUID()),
        boardId: boardId as WorkplaceCard['boardId'],
        status: 'inbox',
        kind: 'action',
        parentInitiativeId: null,
        title,
        description: input.outcome,
        ownerId: null,
        position: nextPosition(boardId, 'inbox') + index * RANK_GAP,
        priority: 'unset',
        dueAt: null,
        blockedBy: null,
        unblockWhen: null,
        outcome: null,
        version: 1,
        coverColour: null,
        seedKey: `${id}:card:${index + 1}`,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      }))
      for (const card of made) cards.set(card.id, card)
      return { outcome: 'started', cycle: { id, boardId: boardId as never, cards: made } }
    },

    closePracticum: async (input) => {
      const cycleCards = [...cards.values()].filter(
        (card) =>
          card.boardId !== undefined &&
          membershipOf(input.callerId, card.boardId) !== undefined &&
          (card.seedKey?.startsWith(`${input.cycleId}:card:`) === true ||
            card.seedKey?.startsWith(`${input.cycleId}#`) === true),
      )
      if (cycleCards.length === 0) return { outcome: 'unknown-cycle' as const }
      const existingCode = cycleCards[0]?.seedKey?.slice(
        input.cycleId.length + 1,
        input.cycleId.length + 2,
      )
      const result =
        existingCode === 's'
          ? 'shipped'
          : existingCode === 'f'
            ? 'failed_experiment'
            : input.close.result
      if (existingCode !== 's' && existingCode !== 'f') {
        const code = input.close.result === 'shipped' ? 's' : 'f'
        for (const card of cycleCards) {
          const suffix = card.seedKey?.split(':card:')[1] ?? '1'
          cards.set(card.id, {
            ...card,
            seedKey: `${input.cycleId}#${code}:card:${suffix}`,
            updatedAt: new Date().toISOString(),
          })
        }
      }
      const accept = (outcome: string) => ({
        tool: 'kolonie.workplace' as const,
        arguments: {
          act: 'accept-practicum' as const,
          subject: 'card' as const,
          fields: { outcome },
        },
      })
      return {
        outcome: 'closed' as const,
        retrospective: {
          cycleId: input.cycleId,
          result,
          choices: {
            startRevised: accept('<your revised outcome>'),
            replaceOutcome: accept('<a different outcome>'),
            defer: {
              tool: 'kolonie.workplace' as const,
              arguments: {
                act: 'defer-practicum' as const,
                subject: 'card' as const,
                id: input.cycleId,
              },
            },
            end: {
              tool: 'kolonie.workplace' as const,
              arguments: {
                act: 'end-practicum' as const,
                subject: 'card' as const,
                id: input.cycleId,
              },
            },
          },
        },
      }
    },

    resolvePracticum: async (input) => {
      const exists = [...cards.values()].some(
        (card) =>
          membershipOf(input.callerId, card.boardId) !== undefined &&
          card.seedKey?.startsWith(`${input.cycleId}#`) === true,
      )
      return exists
        ? { outcome: 'resolved' as const, choice: input.choice }
        : { outcome: 'unknown-cycle' as const }
    },

    create: async (input) => {
      if (membershipOf(input.callerId, input.boardId) === undefined) {
        return { outcome: 'missing' } satisfies CreateCardResult
      }
      const status = input.status ?? 'inbox'
      const kind = input.kind ?? 'action'
      const parentInitiativeId = input.parentInitiativeId ?? null
      if (status !== 'inbox' && status !== 'ready') return { outcome: 'invalid-transition' }
      const parent = parentInitiativeId === null ? undefined : cards.get(parentInitiativeId)
      if (
        (parentInitiativeId !== null &&
          (kind !== 'action' ||
            parent === undefined ||
            parent.kind !== 'initiative' ||
            parent.boardId !== input.boardId ||
            parent.archivedAt !== null)) ||
        (kind === 'initiative' && parentInitiativeId !== null)
      ) {
        return { outcome: 'invalid-transition' }
      }
      const now = new Date().toISOString()
      const card: WorkplaceCard = {
        id: WorkplaceCardIdSchema.parse(randomUUID()),
        boardId: input.boardId as WorkplaceCard['boardId'],
        status,
        kind,
        parentInitiativeId:
          parentInitiativeId === null ? null : (parentInitiativeId as WorkplaceCard['id']),
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
      appendEvent(
        input.callerId,
        card,
        'card.created',
        {
          title: card.title,
          description: card.description,
          status: card.status,
          kind: card.kind,
          parentInitiativeId: card.parentInitiativeId,
          priority: card.priority,
          dueAt: card.dueAt,
          coverColour: card.coverColour,
        },
        input.attribution,
      )
      return { outcome: 'created', card }
    },

    update: async (input) => {
      const card = cards.get(input.cardId)
      if (card === undefined) return { outcome: 'missing' } satisfies UpdateCardResult
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'forbidden' }
      if (card.version !== input.expectedVersion) return { outcome: 'stale' }
      const kind = input.kind ?? card.kind
      const parentInitiativeId =
        input.parentInitiativeId === undefined ? card.parentInitiativeId : input.parentInitiativeId
      if (input.kind !== undefined && input.kind !== card.kind) {
        if ((card.status !== 'inbox' && card.status !== 'ready') || card.ownerId !== null) {
          return { outcome: 'invalid-transition' }
        }
        if (
          card.kind === 'initiative' &&
          input.kind === 'action' &&
          [...cards.values()].some((one) => one.parentInitiativeId === card.id)
        ) {
          return { outcome: 'invalid-transition' }
        }
      }
      const parent = parentInitiativeId === null ? undefined : cards.get(parentInitiativeId)
      if (
        (parentInitiativeId !== null &&
          (kind !== 'action' ||
            parent === undefined ||
            parent.kind !== 'initiative' ||
            parent.boardId !== card.boardId ||
            parent.archivedAt !== null)) ||
        (kind === 'initiative' && parentInitiativeId !== null)
      ) {
        return { outcome: 'invalid-transition' }
      }
      const updated = bump(card, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
        ...(input.coverColour === undefined ? {} : { coverColour: input.coverColour }),
        ...(input.position === undefined ? {} : { position: input.position }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.parentInitiativeId === undefined
          ? {}
          : {
              parentInitiativeId:
                input.parentInitiativeId === null
                  ? null
                  : (input.parentInitiativeId as WorkplaceCard['id']),
            }),
      })
      cards.set(card.id, updated)
      return { outcome: 'updated', card: updated }
    },

    claim: async (input) => {
      const card = cards.get(input.cardId)
      if (card === undefined) return { outcome: 'missing' } satisfies ClaimCardResult
      const membership = membershipOf(input.callerId, card.boardId) ?? null
      if (membership === null) return { outcome: 'forbidden' }
      if (card.ownerId !== null) return { outcome: 'conflict' }
      if (card.kind !== 'action' || card.status !== 'ready' || card.archivedAt !== null) {
        return { outcome: 'invalid-transition' }
      }
      if (card.version !== input.expectedVersion) {
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
      if (!canTransitionWorkplace(card.status, input.status, card.kind))
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
      if (!canTransitionWorkplace(card.status, 'blocked', card.kind) || card.ownerId === null) {
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
      if (!canTransitionWorkplace(card.status, 'review', card.kind) || card.ownerId === null) {
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
      if (
        !canTransitionWorkplace(card.status, 'done', card.kind) ||
        (card.kind === 'action' && card.ownerId === null) ||
        (card.kind === 'initiative' &&
          [...cards.values()].some(
            (one) =>
              one.parentInitiativeId === card.id &&
              one.archivedAt === null &&
              one.status !== 'done',
          ))
      ) {
        return { outcome: 'invalid-transition' }
      }
      const close = input.close ?? { outcome: input.outcome ?? '' }
      const legacy = 'outcome' in close
      const normalized = legacy
        ? {
            result: 'shipped' as const,
            summary: close.outcome,
            learned: 'No learning was supplied by the legacy client.',
            evidenceLinkIds: [] as WorkplaceCardClosure['evidenceLinkIds'],
            next: { kind: 'none' as const },
          }
        : close
      const evidenceLinks = normalized.evidenceLinkIds.flatMap((id) => {
        const link = links.get(id)
        return link?.cardId === card.id ? [link] : []
      })
      if (evidenceLinks.length !== normalized.evidenceLinkIds.length) {
        return { outcome: 'invalid-evidence' }
      }
      if (normalized.next.kind === 'card') {
        const successor = cards.get(normalized.next.cardId)
        if (
          successor === undefined ||
          successor.boardId !== card.boardId ||
          successor.archivedAt !== null
        ) {
          return { outcome: 'invalid-successor' }
        }
      }
      const done = bump(card, {
        status: 'done',
        outcome: normalized.summary,
        position: nextPosition(card.boardId, 'done'),
      })
      cards.set(card.id, done)
      const closure: WorkplaceCardClosure = {
        id: WorkplaceCardClosureIdSchema.parse(randomUUID()),
        boardId: card.boardId,
        cardId: card.id,
        actorId:
          input.attribution?.actorKind === 'system'
            ? null
            : (input.attribution?.actorId ?? input.callerId),
        revision: 1,
        ...normalized,
        evidenceLinkIds: evidenceLinks.map((link) => link.id),
        evidenceLinks,
        legacy,
        supersedesClosureId: null,
        createdAt: new Date().toISOString(),
      }
      closures.set(card.id, [closure])
      appendEvent(
        input.callerId,
        done,
        'card.closed',
        { closeRecordId: closure.id, result: closure.result },
        input.attribution,
      )
      return { outcome: 'completed', card: done, closure }
    },

    createClosure: async (input) => {
      const card = cards.get(input.cardId)
      if (card === undefined) return { outcome: 'missing' } satisfies CreateCardClosureResult
      if (membershipOf(input.callerId, card.boardId) === undefined) return { outcome: 'forbidden' }
      if (card.status !== 'done') return { outcome: 'invalid-transition' }
      const previous = closures.get(card.id) ?? []
      const latest = previous[0]
      if (latest === undefined || latest.id !== input.close.supersedesClosureId) {
        return { outcome: 'conflict' }
      }
      const evidenceLinks = input.close.evidenceLinkIds.flatMap((id) => {
        const link = links.get(id)
        return link?.cardId === card.id ? [link] : []
      })
      if (evidenceLinks.length !== input.close.evidenceLinkIds.length) {
        return { outcome: 'invalid-evidence' }
      }
      if (input.close.next.kind === 'card') {
        const successor = cards.get(input.close.next.cardId)
        if (
          successor === undefined ||
          successor.boardId !== card.boardId ||
          successor.archivedAt !== null
        ) {
          return { outcome: 'invalid-successor' }
        }
      }
      const closure: WorkplaceCardClosure = {
        id: WorkplaceCardClosureIdSchema.parse(randomUUID()),
        boardId: card.boardId,
        cardId: card.id,
        actorId:
          input.attribution?.actorKind === 'system'
            ? null
            : (input.attribution?.actorId ?? input.callerId),
        revision: latest.revision + 1,
        result: input.close.result,
        summary: input.close.summary,
        learned: input.close.learned,
        evidenceLinkIds: evidenceLinks.map((link) => link.id),
        evidenceLinks,
        next: input.close.next,
        legacy: false,
        supersedesClosureId: latest.id,
        createdAt: new Date().toISOString(),
      }
      closures.set(card.id, [closure, ...previous])
      return { outcome: 'created', card, closure }
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
      if (!canTransitionWorkplace(card.status, 'archived', card.kind)) {
        return { outcome: 'invalid-transition' }
      }
      if (card.kind === 'initiative') {
        for (const child of cards.values()) {
          if (child.parentInitiativeId === card.id && child.archivedAt === null) {
            const unparented = bump(child, { parentInitiativeId: null })
            cards.set(child.id, unparented)
            appendEvent(
              input.callerId,
              unparented,
              'card.updated',
              { changes: { parentInitiativeId: { before: card.id, after: null } } },
              input.attribution,
            )
          }
        }
      }
      const archived = bump(card, { archivedAt: new Date().toISOString() })
      cards.set(card.id, archived)
      for (const [citizenId, commitment] of commitments) {
        if (commitment.focusCardId === card.id) {
          commitments.set(citizenId, {
            ...commitment,
            focusCardId: null,
            version: commitment.version + 1,
          })
        }
      }
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
      for (const [cardId, history] of closures) {
        closures.set(
          cardId,
          history.map((closure) => ({
            ...closure,
            evidenceLinkIds: closure.evidenceLinkIds.filter((id) => id !== input.linkId),
            evidenceLinks: closure.evidenceLinks.filter((link) => link.id !== input.linkId),
          })),
        )
      }
      return { outcome: 'removed' }
    },
  }
}
