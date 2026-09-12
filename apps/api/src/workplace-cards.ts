import type {
  AgentId,
  WorkplaceCommitment,
  WorkplaceCommitmentState,
  WorkplaceCard,
  WorkplaceCardEvent,
  WorkplaceCardDetail,
  WorkplaceChecklist,
  WorkplaceChecklistItem,
  WorkplaceComment,
  WorkplaceLabel,
  WorkplaceLane,
  WorkplaceLinkKind,
  WorkplaceClosePracticumRequest,
} from '@kolonie-ai/core'
import {
  addLink,
  advanceCommitment,
  endCommitment,
  readCommitment,
  setCommitment,
  archiveCard,
  attachLabel,
  blockCard,
  claimCard,
  closeProfessionPracticum,
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
  listCardEvents,
  listComments,
  listLinks,
  moveCard,
  removeLink,
  resolveProfessionPracticum,
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
  type CloseProfessionPracticumResult,
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
  type ListCardEventsResult,
  type WorkplaceEventAttribution,
  type ListCommentsResult,
  type ListLinksResult,
  type MoveCardResult,
  type RemoveLinkResult,
  type ResolveProfessionPracticumResult,
  type RequestReviewResult,
  type StartProfessionPracticumResult,
  type UpdateCardResult,
  type AdvanceCommitmentResult,
  type SetCommitmentResult,
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
export type WorkplaceWriteAttribution = WorkplaceEventAttribution

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
  events(
    callerId: AgentId,
    cardId: string,
    query?: { readonly cursor?: string | null; readonly limit?: number },
  ): Promise<ListCardEventsResult>
  acceptPracticum(input: {
    readonly callerId: AgentId
    readonly outcome: string
  }): Promise<StartProfessionPracticumResult>
  closePracticum(input: {
    readonly callerId: AgentId
    readonly cycleId: string
    readonly close: WorkplaceClosePracticumRequest
  }): Promise<CloseProfessionPracticumResult>
  resolvePracticum(input: {
    readonly callerId: AgentId
    readonly cycleId: string
    readonly choice: 'deferred' | 'ended'
  }): Promise<ResolveProfessionPracticumResult>
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
    readonly attribution?: WorkplaceWriteAttribution
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
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<UpdateCardResult>
  claim(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly idempotencyKey?: string
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<ClaimCardResult>
  move(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly status: WorkplaceLane
    readonly position?: number
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<MoveCardResult>
  block(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly blockedBy: string
    readonly unblockWhen: string
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<BlockCardResult>
  requestReview(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<RequestReviewResult>
  complete(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly outcome: string
    readonly attribution?: WorkplaceWriteAttribution
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
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<HandoverCardResult>
  archive(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly expectedVersion: number
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<ArchiveCardResult>
  attachLabel(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly labelId: string
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<AttachLabelResult>
  detachLabel(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly labelId: string
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<DetachLabelResult>
  createChecklist(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly title: string
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<CreateChecklistResult>
  updateChecklist(input: {
    readonly callerId: AgentId
    readonly checklistId: string
    readonly title?: string
    readonly position?: number
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<UpdateChecklistResult>
  deleteChecklist(input: {
    readonly callerId: AgentId
    readonly checklistId: string
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<DeleteChecklistResult>
  createChecklistItem(input: {
    readonly callerId: AgentId
    readonly checklistId: string
    readonly title: string
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<CreateChecklistItemResult>
  updateChecklistItem(input: {
    readonly callerId: AgentId
    readonly itemId: string
    readonly title?: string
    readonly doneAt?: string | null
    readonly position?: number
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<UpdateChecklistItemResult>
  deleteChecklistItem(input: {
    readonly callerId: AgentId
    readonly itemId: string
    readonly attribution?: WorkplaceWriteAttribution
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
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<CreateCommentResult>
  listLinks(callerId: AgentId, cardId: string): Promise<ListLinksResult>
  addLink(input: {
    readonly callerId: AgentId
    readonly cardId: string
    readonly kind: WorkplaceLinkKind
    readonly ref: string
    readonly note?: string
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<AddLinkResult>
  removeLink(input: {
    readonly callerId: AgentId
    readonly linkId: string
    readonly attribution?: WorkplaceWriteAttribution
  }): Promise<RemoveLinkResult>
  /**
   * The one self-authored commitment (`#1869`).
   *
   * On this port rather than on a fourth one: the MCP tool already holds
   * `cards`, and a commitment is neither a board nor a card but is reached
   * through the same grammar, so a separate port would buy a second wiring
   * for one row.
   */
  setCommitment(input: {
    readonly callerId: AgentId
    readonly outcome: string
    readonly nextAction: string
    readonly reviewAt: string
    readonly state: WorkplaceCommitmentState
    readonly blocker?: string
    readonly expectedVersion?: number
  }): Promise<SetCommitmentResult>
  readCommitment(callerId: AgentId): Promise<WorkplaceCommitment | null>
  advanceCommitment(input: {
    readonly callerId: AgentId
    readonly expectedVersion: number
    readonly nextAction: string
    readonly reviewAt?: string
    readonly state: WorkplaceCommitmentState
    readonly blocker?: string
  }): Promise<AdvanceCommitmentResult>
  endCommitment(input: { readonly callerId: AgentId }): Promise<{ readonly outcome: 'ended' }>
}

export function databaseWorkplaceCards(db: Database): WorkplaceCards {
  return {
    list: (callerId, boardId, query) => listCards(db, callerId, boardId, query),
    get: (callerId, cardId) => getCard(db, callerId, cardId),
    events: (callerId, cardId, query) => listCardEvents(db, callerId, cardId, query),
    acceptPracticum: (input) => startProfessionPracticum(db, input),
    closePracticum: (input) => closeProfessionPracticum(db, input),
    resolvePracticum: (input) => resolveProfessionPracticum(db, input),
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
    setCommitment: (input) => setCommitment(db, input),
    readCommitment: (callerId) => readCommitment(db, callerId),
    advanceCommitment: (input) => advanceCommitment(db, input),
    endCommitment: (input) => endCommitment(db, input),
  }
}

export type {
  WorkplaceCard,
  WorkplaceCardEvent,
  WorkplaceCardDetail,
  WorkplaceChecklist,
  WorkplaceChecklistItem,
  WorkplaceComment,
  WorkplaceLabel,
}
