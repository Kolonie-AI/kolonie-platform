import { randomUUID } from 'node:crypto'
import {
  AgentIdSchema,
  WorkplaceBoardIdSchema,
  type AgentId,
  type WorkplaceBoard,
  type WorkplaceMembership,
} from '@kolonie-ai/core'
import type { WorkplaceBoards } from '../workplace-boards.js'
import type {
  AddMemberResult,
  ArchiveBoardResult,
  ListBoardsResult,
  ListMembersResult,
  RemoveMemberResult,
  RenameBoardResult,
} from '@kolonie-ai/db'

/**
 * Boards in memory (`#1759`).
 *
 * Reproduces the storage *answers* the route branches on: a missing board and
 * a board the caller is not on are the same miss; a member who is not the
 * owner is `forbidden`; the default board cannot be archived. What Postgres
 * actually does with the unique partial index is asserted in `packages/db`.
 */
export interface FakeWorkplaceBoards extends WorkplaceBoards {
  /** Plant a board the way the provisioner would, without HTTP. */
  readonly plant: (board: WorkplaceBoard, members: readonly WorkplaceMembership[]) => void
  /** Bind a handle to an agent id, for add-member-by-handle. */
  readonly named: (handle: string, agentId: AgentId) => void
}

export function fakeWorkplaceBoards(): FakeWorkplaceBoards {
  const boards = new Map<string, WorkplaceBoard>()
  const seats = new Map<string, WorkplaceMembership[]>()
  const handles = new Map<string, AgentId>()
  const names = new Map<string, string>()

  const membershipOf = (callerId: AgentId, boardId: string) =>
    (seats.get(boardId) ?? []).find((one) => one.citizenId === callerId)

  return {
    plant: (board, members) => {
      boards.set(board.id, board)
      seats.set(board.id, [...members])
    },
    named: (handle, agentId) => {
      handles.set(handle.toLowerCase(), agentId)
      names.set(agentId, handle)
    },

    get: async (callerId, boardId) => {
      if (membershipOf(callerId, boardId) === undefined) return null
      return boards.get(boardId) ?? null
    },

    list: async (callerId, query = {}) => {
      if (query.cursor !== undefined && query.cursor !== null && query.cursor !== '') {
        if (!boards.has(query.cursor) && query.cursor !== 'next') {
          return { outcome: 'invalid-cursor' }
        }
      }
      const items = [...boards.values()]
        .filter((board) => membershipOf(callerId, board.id) !== undefined)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      const limit = query.limit ?? items.length
      const start =
        query.cursor !== undefined && query.cursor !== null && query.cursor !== ''
          ? items.findIndex((one) => one.id === query.cursor) + 1
          : 0
      const page = items.slice(Math.max(start, 0), Math.max(start, 0) + limit)
      const last = page[page.length - 1]
      const more = start + page.length < items.length
      return {
        outcome: 'listed',
        items: page,
        nextCursor: more && last !== undefined ? last.id : null,
      } satisfies ListBoardsResult
    },

    create: async (input) => {
      const now = new Date().toISOString()
      const board: WorkplaceBoard = {
        id: WorkplaceBoardIdSchema.parse(randomUUID()),
        ownerId: input.callerId,
        title: input.title,
        kind: 'additional',
        archivedAt: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }
      boards.set(board.id, board)
      seats.set(board.id, [{ boardId: board.id, citizenId: input.callerId, role: 'owner' }])
      return board
    },

    rename: async (input) => {
      const board = boards.get(input.boardId)
      if (board === undefined) return { outcome: 'missing' } satisfies RenameBoardResult
      const seat = membershipOf(input.callerId, input.boardId)
      if (seat === undefined) return { outcome: 'forbidden' }
      if (seat.role !== 'owner') return { outcome: 'forbidden' }
      if (board.version !== input.expectedVersion) return { outcome: 'stale' }
      const renamed = {
        ...board,
        title: input.title,
        version: board.version + 1,
        updatedAt: new Date().toISOString(),
      }
      boards.set(board.id, renamed)
      return { outcome: 'renamed', board: renamed }
    },

    archive: async (input) => {
      const board = boards.get(input.boardId)
      if (board === undefined) return { outcome: 'missing' } satisfies ArchiveBoardResult
      const seat = membershipOf(input.callerId, input.boardId)
      if (seat === undefined) return { outcome: 'forbidden' }
      if (seat.role !== 'owner') return { outcome: 'forbidden' }
      if (board.kind === 'default') return { outcome: 'default-board-protected' }
      if (board.version !== input.expectedVersion) return { outcome: 'stale' }
      const archived = {
        ...board,
        archivedAt: new Date().toISOString(),
        version: board.version + 1,
        updatedAt: new Date().toISOString(),
      }
      boards.set(board.id, archived)
      return { outcome: 'archived', board: archived }
    },

    members: async (callerId, boardId) => {
      if (membershipOf(callerId, boardId) === undefined) {
        return { outcome: 'unknown' } satisfies ListMembersResult
      }
      return { outcome: 'listed', members: seats.get(boardId) ?? [] }
    },

    addMember: async (input) => {
      const board = boards.get(input.boardId)
      if (board === undefined) return { outcome: 'missing' } satisfies AddMemberResult
      const seat = membershipOf(input.callerId, input.boardId)
      if (seat === undefined) return { outcome: 'forbidden' }
      if (seat.role !== 'owner') return { outcome: 'forbidden' }
      const parsed = AgentIdSchema.safeParse(input.citizenId)
      if (!parsed.success) return { outcome: 'unknown-citizen' }
      const citizenId = parsed.data
      const existing = membershipOf(citizenId, input.boardId)
      if (existing !== undefined) return { outcome: 'added', membership: existing }
      const membership: WorkplaceMembership = {
        boardId: board.id,
        citizenId,
        role: 'member',
      }
      seats.set(input.boardId, [...(seats.get(input.boardId) ?? []), membership])
      return { outcome: 'added', membership }
    },

    removeMember: async (input) => {
      const board = boards.get(input.boardId)
      if (board === undefined) return { outcome: 'missing' } satisfies RemoveMemberResult
      const seat = membershipOf(input.callerId, input.boardId)
      if (seat === undefined) return { outcome: 'forbidden' }
      if (seat.role !== 'owner') return { outcome: 'forbidden' }
      const target = membershipOf(AgentIdSchema.parse(input.citizenId), input.boardId)
      if (target === undefined) return { outcome: 'missing' }
      if (target.role === 'owner') return { outcome: 'default-board-protected' }
      seats.set(
        input.boardId,
        (seats.get(input.boardId) ?? []).filter((one) => one.citizenId !== input.citizenId),
      )
      return { outcome: 'removed' }
    },

    agentIdByHandle: async (handle) => handles.get(handle.toLowerCase()),
    handlesOf: async (agentIds) => {
      const out = new Map<AgentId, string>()
      for (const id of agentIds) {
        const handle = names.get(id)
        if (handle !== undefined) out.set(id, handle)
      }
      return out
    },
  }
}
