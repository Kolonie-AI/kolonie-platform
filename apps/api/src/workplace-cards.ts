import type {
  AgentId,
  WorkplaceCard,
  WorkplaceCardDetail,
  WorkplaceChecklist,
  WorkplaceChecklistItem,
  WorkplaceComment,
  WorkplaceLabel,
  WorkplaceLane,
  WorkplaceLinkKind,
} from '@kolonie-ai/core'
import {
  addLink,
  archiveCard,
  attachLabel,
  blockCard,
  claimCard,
  completeCard,
  createCard,
  createChecklist,
  createChecklistItem,
  createComment,
  deleteChecklist,
  deleteChecklistItem,
  detachLabel,
  getCard,
  handoverCard,
  listCards,
  listComments,
  listLinks,
  moveCard,
  removeLink,
  requestReview,
  startProfessionPracticum,
  updateCard,
  updateChecklist,
  updateChecklistItem,
  type AddLinkResult,
  type ArchiveCardResult,
  type AttachLabelResult,
  type BlockCardResult,
  type ClaimCardResult,
  type CompleteCardResult,
  type CreateCardResult,
  type CreateChecklistItemResult,
  type CreateChecklistResult,
  type CreateCommentResult,
  type Database,
  type DeleteChecklistItemResult,
  type DeleteChecklistResult,
  type DetachLabelResult,
  type HandoverCardResult,
  type ListCardsResult,
  type ListCommentsResult,
  type ListLinksResult,
  type MoveCardResult,
  type RemoveLinkResult,
  type RequestReviewResult,
  type StartProfessionPracticumResult,
  type UpdateCardResult,
  type UpdateChecklistItemResult,
  type UpdateChecklistResult,
} from '@kolonie-ai/db'

/**
 * The card collection `#1760` hangs HTTP on.
 *
 * **A port rather than `Database`**, matching {@link WorkplaceBoards}: route
 * tests need no Postgres. Policy stays in `@kolonie-ai/core` and the
 * statements stay in `packages/db`.
 */
export interface WorkplaceCards {
  list(
    callerId: AgentId,
    boardId: string,
    query?: {
      readonly status?: WorkplaceLane
      readonly cursor?: string | null
      readonly limit?: number
    },
  ): Promise<ListCardsResult>
  get(callerId: AgentId, cardId: string): Promise<WorkplaceCardDetail | null>
  acceptPracticum(input: {
    readonly callerId: AgentId
    readonly outcome: string
  }): Promise<StartProfessionPracticumResult>
  create(input: {
    readonly callerId: AgentId
    readonly boardId: string
    readonly title: string
    readonly description?: string | null
    readonly status?: WorkplaceLane
    readonly priority?: string
    readonly dueAt?: string | null
    readonly coverColour?: string | null
    readonly idempotencyKey?: string
  }): Promise<CreateCardResult>
  update(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly title?: string
    readonly description?: string | null
    readonly priority?: string
    readonly dueAt?: string | null
    readonly coverColour?: string | null
    readonly position?: number
  }): Promise<UpdateCardResult>
  claim(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly idempotencyKey?: string
  }): Promise<ClaimCardResult>
  move(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly status: WorkplaceLane
    readonly position?: number
  }): Promise<MoveCardResult>
  block(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly blockedBy: string
    readonly unblockWhen: string
  }): Promise<BlockCardResult>
  requestReview(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
  }): Promise<RequestReviewResult>
  complete(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly outcome: string
  }): Promise<CompleteCardResult>
  handover(input: {
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
  }): Promise<HandoverCardResult>
  archive(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
  }): Promise<ArchiveCardResult>
  attachLabel(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly labelId: string
  }): Promise<AttachLabelResult>
  detachLabel(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly labelId: string
  }): Promise<DetachLabelResult>
  createChecklist(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly title: string
  }): Promise<CreateChecklistResult>
  updateChecklist(input: {
    readonly callerId: AgentId
    readonly checklistId: string
    readonly title?: string
    readonly position?: number
  }): Promise<UpdateChecklistResult>
  deleteChecklist(input: {
    readonly callerId: AgentId
    readonly checklistId: string
  }): Promise<DeleteChecklistResult>
  createChecklistItem(input: {
    readonly callerId: AgentId
    readonly checklistId: string
    readonly title: string
  }): Promise<CreateChecklistItemResult>
  updateChecklistItem(input: {
    readonly callerId: AgentId
    readonly itemId: string
    readonly title?: string
    readonly doneAt?: string | null
    readonly position?: number
  }): Promise<UpdateChecklistItemResult>
  deleteChecklistItem(input: {
    readonly callerId: AgentId
    readonly itemId: string
  }): Promise<DeleteChecklistItemResult>
  listComments(
    callerId: AgentId,
    cardId: string,
    query?: { readonly cursor?: string | null; readonly limit?: number },
  ): Promise<ListCommentsResult>
  createComment(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly body: string
  }): Promise<CreateCommentResult>
  listLinks(callerId: AgentId, cardId: string): Promise<ListLinksResult>
  addLink(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly kind: WorkplaceLinkKind
    readonly ref: string
    readonly note?: string
  }): Promise<AddLinkResult>
  removeLink(input: {
    readonly callerId: AgentId
    readonly linkId: string
  }): Promise<RemoveLinkResult>
}

export function databaseWorkplaceCards(db: Database): WorkplaceCards {
  return {
    list: (callerId, boardId, query) => listCards(db, callerId, boardId, query),
    get: (callerId, cardId) => getCard(db, callerId, cardId),
    acceptPracticum: (input) => startProfessionPracticum(db, input),
    create: (input) => createCard(db, input),
    update: (input) => updateCard(db, input),
    claim: (input) => claimCard(db, input),
    move: (input) => moveCard(db, input),
    block: (input) => blockCard(db, input),
    requestReview: (input) => requestReview(db, input),
    complete: (input) => completeCard(db, input),
    handover: (input) => handoverCard(db, input),
    archive: (input) => archiveCard(db, input),
    attachLabel: (input) => attachLabel(db, input),
    detachLabel: (input) => detachLabel(db, input),
    createChecklist: (input) => createChecklist(db, input),
    updateChecklist: (input) => updateChecklist(db, input),
    deleteChecklist: (input) => deleteChecklist(db, input),
    createChecklistItem: (input) => createChecklistItem(db, input),
    updateChecklistItem: (input) => updateChecklistItem(db, input),
    deleteChecklistItem: (input) => deleteChecklistItem(db, input),
    listComments: (callerId, cardId, query) => listComments(db, callerId, cardId, query),
    createComment: (input) => createComment(db, input),
    listLinks: (callerId, cardId) => listLinks(db, callerId, cardId),
    addLink: (input) => addLink(db, input),
    removeLink: (input) => removeLink(db, input),
  }
}

export type {
  WorkplaceCard,
  WorkplaceCardDetail,
  WorkplaceChecklist,
  WorkplaceChecklistItem,
  WorkplaceComment,
  WorkplaceLabel,
}
