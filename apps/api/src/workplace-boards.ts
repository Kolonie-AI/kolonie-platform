import type { AgentId, WorkplaceBoard, WorkplaceMembership } from '@kolonie-ai/core'
import {
  addMember,
  agentIdByHandle,
  archiveBoard,
  createBoard,
  getBoardFor,
  handlesOf,
  listBoardsFor,
  listMembers,
  removeMember,
  renameBoard,
  type AddMemberResult,
  type ArchiveBoardResult,
  type Database,
  type ListBoardsResult,
  type ListMembersResult,
  type RemoveMemberResult,
  type RenameBoardResult,
} from '@kolonie-ai/db'

/**
 * The board collection `#1759` hangs HTTP on.
 *
 * **A port rather than `Database`**, so `apps/api`'s route tests need no
 * Postgres — the same seam every other surface here has. Policy stays in
 * `@kolonie-ai/core` and the statements stay in `packages/db`; this file is
 * the shape the route calls.
 */
export interface WorkplaceBoards {
  get(callerId: AgentId, boardId: string): Promise<WorkplaceBoard | null>
  list(
    callerId: AgentId,
    query?: { readonly cursor?: string | null; readonly limit?: number },
  ): Promise<ListBoardsResult>
  create(input: {
    readonly callerId: AgentId
    readonly title: string
    readonly idempotencyKey?: string
  }): Promise<WorkplaceBoard>
  rename(input: {
    readonly callerId: AgentId
    readonly boardId: string
    readonly title: string
    readonly expectedVersion: number
  }): Promise<RenameBoardResult>
  archive(input: {
    readonly callerId: AgentId
    readonly boardId: string
    readonly expectedVersion: number
  }): Promise<ArchiveBoardResult>
  members(callerId: AgentId, boardId: string): Promise<ListMembersResult>
  addMember(input: {
    readonly callerId: AgentId
    readonly boardId: string
    readonly citizenId: string
  }): Promise<AddMemberResult>
  removeMember(input: {
    readonly callerId: AgentId
    readonly boardId: string
    readonly citizenId: string
  }): Promise<RemoveMemberResult>
  /** Handle half of add-member: uuid goes to `addMember` directly. */
  agentIdByHandle(handle: string): Promise<AgentId | undefined>
  handlesOf(agentIds: readonly AgentId[]): Promise<ReadonlyMap<AgentId, string>>
}

export function databaseWorkplaceBoards(db: Database): WorkplaceBoards {
  return {
    get: (callerId, boardId) => getBoardFor(db, callerId, boardId),
    list: (callerId, query) => listBoardsFor(db, callerId, query),
    create: (input) => createBoard(db, input),
    rename: (input) => renameBoard(db, input),
    archive: (input) => archiveBoard(db, input),
    members: (callerId, boardId) => listMembers(db, callerId, boardId),
    addMember: (input) => addMember(db, input),
    removeMember: (input) => removeMember(db, input),
    agentIdByHandle: (handle) => agentIdByHandle(db, handle),
    handlesOf: (agentIds) => handlesOf(db, agentIds),
  }
}

export type { WorkplaceBoard, WorkplaceMembership }
