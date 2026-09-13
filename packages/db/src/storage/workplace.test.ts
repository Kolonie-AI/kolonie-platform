import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  type AccountCapability,
  type AgentId,
  type WorkplaceLinkId,
} from '@kolonie-ai/core'
import { createDatabase, type Database } from '../client.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { declareAccount, recordProvedAccount } from './accounts.js'
import { listAtlasProvider } from './provider-recipes.js'
import * as vaultStorage from './vault.js'
import { setVaultEntry } from './vault.js'
import { eraseAgent } from './erasure.js'
import {
  addLink,
  addMember,
  archiveBoard,
  archiveCard,
  attachLabel,
  blockCard,
  claimCard,
  completeCard,
  createBoard,
  createCard,
  createChecklist,
  createChecklistItem,
  createComment,
  createDefaultBoard,
  deleteChecklist,
  getBoardFor,
  getCard,
  createCardClosure,
  handoverCard,
  listBoardsFor,
  listCards,
  listComments,
  listCardEvents,
  listCardClosures,
  listLinks,
  listMembers,
  materialiseDue,
  startProfessionPracticum,
  closeProfessionPracticum,
  practicumEventCounts,
  moveCard,
  removeLink,
  removeMember,
  renameBoard,
  recallWorkplace,
  rebuildWorkplaceRecallProjection,
  requestReview,
  resolveProfessionPracticum,
  retireStarter,
  setCommitment,
  readCommitment,
  advanceCommitment,
  endCommitment,
  updateCard,
  workplaceWakeup,
} from './workplace.js'
import { toTimestamp } from './rows.js'
import {
  agents,
  playbooks,
  tasks,
  workplaceActivity,
  workplaceBoardMemberships,
  workplaceBoards,
  workplaceCommitments,
  workplaceCardClosureEvidence,
  workplaceCardClosures,
  workplaceCardLinks,
  workplaceCards,
  workplaceChecklistItems,
  workplaceLabels,
  workplacePracticumEvents,
  workplaceRecurrenceOccurrences,
  workplaceRecurrenceRules,
} from '../schema/index.js'

const target = databaseTestTarget()
const SALT = 'a'.repeat(32)

describe('workplace storage', () => {
  let db: Database
  let owner: AgentId
  let member: AgentId
  let stranger: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    owner = await citizen('owner')
    member = await citizen('member')
    stranger = await citizen('stranger')
  })

  const keys = new Map<AgentId, string>()

  const citizen = async (name: string): Promise<AgentId> => {
    const registered = await registerAgent(db, {
      name,
      platform: 'openclaw',
      operator: null,
    })
    if (registered.outcome !== 'registered') throw new Error(`could not register ${name}`)
    keys.set(registered.agent.id, String(registered.credentials.apiKey))
    return registered.agent.id
  }

  const defaultBoard = async (callerId = owner) =>
    createDefaultBoard(db, { callerId, title: 'Default board' })

  /**
   * The complete Software Producer example `#1835` asks for: the citizen names
   * one user/problem and one smallest runnable artifact in the outcome it
   * accepts, and the cycle carries that sentence from problem through delivery
   * to feedback. The cards stay ordinary — rewritable and archivable.
   */
  it('creates Initiatives and valid child Actions and filters each shape', async () => {
    const board = await defaultBoard()
    const initiative = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Reach one outcome',
      kind: 'initiative',
      status: 'ready',
    })
    if (initiative.outcome !== 'created') throw new Error('initiative missing')
    const action = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Ship one artifact',
      kind: 'action',
      parentInitiativeId: initiative.card.id,
      status: 'ready',
    })
    expect(action.outcome).toBe('created')
    if (action.outcome !== 'created') return
    expect(action.card.parentInitiativeId).toBe(initiative.card.id)
    expect(
      await listCards(db, owner, board.id, {
        kind: 'action',
        parentInitiativeId: initiative.card.id,
      }),
    ).toMatchObject({ outcome: 'listed', items: [{ id: action.card.id, kind: 'action' }] })
    const detail = await getCard(db, owner, initiative.card.id)
    expect(detail).toMatchObject({
      actionCounts: { total: 1, done: 0, active: 1 },
      nextActions: [{ id: action.card.id }],
    })
  })

  it('refuses invalid parents and kind changes with children', async () => {
    const board = await defaultBoard()
    const other = await createBoard(db, { callerId: owner, title: 'Other' })
    const initiative = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Home outcome',
      kind: 'initiative',
      status: 'ready',
    })
    const ordinary = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Ordinary Action',
      status: 'ready',
    })
    if (initiative.outcome !== 'created' || ordinary.outcome !== 'created') {
      throw new Error('cards missing')
    }
    expect(
      await createCard(db, {
        callerId: owner,
        boardId: other.id,
        title: 'Cross-board Action',
        parentInitiativeId: initiative.card.id,
      }),
    ).toEqual({ outcome: 'invalid-transition' })
    expect(
      await createCard(db, {
        callerId: owner,
        boardId: board.id,
        title: 'Action under Action',
        parentInitiativeId: ordinary.card.id,
      }),
    ).toEqual({ outcome: 'invalid-transition' })
    const child = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Child',
      parentInitiativeId: initiative.card.id,
    })
    expect(child.outcome).toBe('created')
    expect(
      await updateCard(db, {
        callerId: owner,
        cardId: initiative.card.id,
        expectedVersion: initiative.card.version,
        kind: 'action',
      }),
    ).toEqual({ outcome: 'invalid-transition' })
  })

  it('gates Initiative completion on open Actions and unparents children on archive', async () => {
    const board = await defaultBoard()
    const initiative = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Reach one outcome',
      kind: 'initiative',
      status: 'ready',
    })
    if (initiative.outcome !== 'created') throw new Error('initiative missing')
    const child = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Open Action',
      parentInitiativeId: initiative.card.id,
      status: 'ready',
    })
    if (child.outcome !== 'created') throw new Error('child missing')
    expect(
      await completeCard(db, {
        callerId: owner,
        cardId: initiative.card.id,
        expectedVersion: initiative.card.version,
        close: { outcome: 'Outcome reached.' },
      }),
    ).toEqual({ outcome: 'invalid-transition' })

    const archived = await archiveCard(db, {
      callerId: owner,
      cardId: initiative.card.id,
      expectedVersion: initiative.card.version,
    })
    expect(archived.outcome).toBe('archived')
    expect((await getCard(db, owner, child.card.id))?.card.parentInitiativeId).toBeNull()
    const history = await listCardEvents(db, owner, child.card.id)
    if (history.outcome !== 'listed') throw new Error('event history missing')
    expect(history.items[0]).toMatchObject({
      verb: 'card.updated',
      payload: {
        changes: { parentInitiativeId: { before: initiative.card.id, after: null } },
      },
    })
  })

  it('serializes concurrent Initiative archive and child reparenting', async () => {
    const board = await defaultBoard()
    const initiative = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Outcome to archive',
      kind: 'initiative',
      status: 'ready',
    })
    const child = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Child to move',
      status: 'ready',
    })
    if (initiative.outcome !== 'created' || child.outcome !== 'created') {
      throw new Error('cards missing')
    }

    const [archived, reparented] = await Promise.all([
      archiveCard(db, {
        callerId: owner,
        cardId: initiative.card.id,
        expectedVersion: initiative.card.version,
      }),
      updateCard(db, {
        callerId: owner,
        cardId: child.card.id,
        expectedVersion: child.card.version,
        parentInitiativeId: initiative.card.id,
      }),
    ])

    expect(archived.outcome).toBe('archived')
    expect(['updated', 'invalid-transition']).toContain(reparented.outcome)
    expect((await getCard(db, owner, child.card.id))?.card.parentInitiativeId).toBeNull()
  })

  it('serializes concurrent Initiative completion and child creation', async () => {
    const board = await defaultBoard()
    const initiative = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Outcome to complete',
      kind: 'initiative',
      status: 'ready',
    })
    if (initiative.outcome !== 'created') throw new Error('initiative missing')

    const [completed, child] = await Promise.all([
      completeCard(db, {
        callerId: owner,
        cardId: initiative.card.id,
        expectedVersion: initiative.card.version,
        close: {
          result: 'abandoned',
          summary: 'The Initiative ended without further execution.',
          learned: 'No additional Action was warranted.',
          evidenceLinkIds: [],
          next: { kind: 'sentence', text: 'Return to the board.' },
        },
      }),
      createCard(db, {
        callerId: owner,
        boardId: board.id,
        title: 'Late child',
        parentInitiativeId: initiative.card.id,
        status: 'ready',
      }),
    ])

    expect(completed.outcome).toBe('completed')
    expect(child.outcome).toBe('created')
    if (child.outcome === 'created') {
      expect(child.card.parentInitiativeId).toBe(initiative.card.id)
    }
  })

  it('starts an explicitly accepted successor without altering prior terminal evidence', async () => {
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, owner))
    const first = await startProfessionPracticum(db, {
      callerId: owner,
      outcome: 'Deliver one runnable status page.',
    })
    if (first.outcome !== 'started') throw new Error('cycle missing')
    await closeProfessionPracticum(db, {
      callerId: owner,
      cycleId: first.cycle.id,
      close: {
        result: 'shipped',
        evidence: { kind: 'url', ref: 'https://example.invalid/status-page' },
        feedback: 'Asked one maintainer to open it.',
      },
    })

    const successor = await startProfessionPracticum(db, {
      callerId: owner,
      outcome: 'Revise the page around the feedback.',
    })

    expect(successor.outcome).toBe('started')
    if (successor.outcome !== 'started') return
    expect(successor.cycle.id).not.toBe(first.cycle.id)
    expect(successor.cycle.cards).toHaveLength(5)
    const prior = await db
      .select({ seedKey: workplaceCards.seedKey })
      .from(workplaceCards)
      .where(sql`${workplaceCards.seedKey} like ${`${first.cycle.id}#s%`}`)
    expect(prior).toHaveLength(5)
    expect(await workplaceWakeup(db, owner)).toMatchObject({
      practicumActive: true,
    })
    expect(await workplaceWakeup(db, owner)).not.toHaveProperty('practicumRetrospective')
  })

  it('starts one Software Producer cycle of editable cards on the lazy default board', async () => {
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, owner))
    const additional = await createBoard(db, { callerId: owner, title: 'Existing' })
    const existing = await createCard(db, {
      callerId: owner,
      boardId: additional.id,
      title: 'Keep this card',
    })

    const started = await startProfessionPracticum(db, {
      callerId: owner,
      outcome: 'Help one support team see service health with a smallest runnable status page.',
    })

    expect(started.outcome).toBe('started')
    if (started.outcome !== 'started') return
    expect(started.cycle.cards).toHaveLength(5)
    expect(started.cycle.cards.map((card) => card.title)).toEqual([
      'Understand one user and problem',
      'Make the smallest artifact',
      'Run or test the artifact',
      'Publish or deliver the artifact',
      'Ask for feedback',
    ])
    expect(
      started.cycle.cards.every(
        (card) =>
          card.description ===
          'Help one support team see service health with a smallest runnable status page.',
      ),
    ).toBe(true)
    expect(started.cycle.cards.every((card) => card.boardId === started.cycle.boardId)).toBe(true)
    expect(started.cycle.cards.every((card) => card.status === 'inbox')).toBe(true)
    expect(new Set(started.cycle.cards.map((card) => card.seedKey?.split(':card:')[0]))).toEqual(
      new Set([started.cycle.id]),
    )
    expect(
      await db.select().from(workplaceBoards).where(eq(workplaceBoards.ownerId, owner)),
    ).toHaveLength(2)
    expect(
      await getCard(db, owner, existing.outcome === 'created' ? existing.card.id : ''),
    ).not.toBeNull()
    const rewritten = await updateCard(db, {
      callerId: owner,
      cardId: started.cycle.cards[0]!.id,
      expectedVersion: started.cycle.cards[0]!.version,
      title: 'Interview one support lead',
    })
    expect(rewritten.outcome).toBe('updated')
    const archived = await archiveCard(db, {
      callerId: owner,
      cardId: started.cycle.cards[1]!.id,
      expectedVersion: started.cycle.cards[1]!.version,
    })
    expect(archived.outcome).toBe('archived')
  })

  /**
   * `#1739` and `direction.test.ts`: nothing here reads what a citizen says it
   * works as. A novel trade gets the same five cards as any other, and the
   * citizen's own outcome is the only thing that differs.
   */
  it('classifies no profession text and carries the citizen outcome instead', async () => {
    await db
      .update(agents)
      .set({ status: 'citizen', profession: 'Intertidal Signal Gardener' })
      .where(eq(agents.id, owner))

    const started = await startProfessionPracticum(db, {
      callerId: owner,
      outcome: 'Deliver one tide-readable signal and ask its intended reader what changed.',
    })

    expect(started.outcome).toBe('started')
    if (started.outcome !== 'started') return
    expect(started.cycle.cards.map((card) => card.title)).toEqual([
      'Understand one user and problem',
      'Make the smallest artifact',
      'Run or test the artifact',
      'Publish or deliver the artifact',
      'Ask for feedback',
    ])
    expect(started.cycle.cards[0]?.description).toBe(
      'Deliver one tide-readable signal and ask its intended reader what changed.',
    )
    expect(JSON.stringify(started.cycle.cards)).not.toContain('Intertidal Signal Gardener')
  })

  it('refuses a candidate without creating a board or cards', async () => {
    expect(
      await startProfessionPracticum(db, {
        callerId: owner,
        outcome: 'Deliver one observable result.',
      }),
    ).toEqual({ outcome: 'citizen-required' })
    expect(
      await db.select().from(workplaceBoards).where(eq(workplaceBoards.ownerId, owner)),
    ).toEqual([])
    expect(await db.select().from(workplaceCards)).toEqual([])
  })

  it('converges retried and concurrent acceptance on one cycle', async () => {
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, owner))
    const outcome = 'Deliver a runnable queue viewer for one maintainer.'

    const results = await Promise.all([
      startProfessionPracticum(db, { callerId: owner, outcome }),
      startProfessionPracticum(db, { callerId: owner, outcome }),
      startProfessionPracticum(db, { callerId: owner, outcome }),
      startProfessionPracticum(db, { callerId: owner, outcome }),
    ])

    expect(results.every((result) => result.outcome === 'started')).toBe(true)
    const started = results.filter((result) => result.outcome === 'started')
    expect(new Set(started.map((result) => result.cycle.id))).toHaveLength(1)
    expect(new Set(started.map((result) => result.cycle.boardId))).toHaveLength(1)
    const cycleId = started[0]?.cycle.id
    expect(
      await db
        .select()
        .from(workplaceCards)
        .where(sql`${workplaceCards.seedKey} like ${`${cycleId}:card:%`}`),
    ).toHaveLength(5)
    expect(
      await db
        .select()
        .from(workplaceBoards)
        .where(and(eq(workplaceBoards.ownerId, owner), eq(workplaceBoards.kind, 'default'))),
    ).toHaveLength(1)
  })

  /**
   * `#1836`. The complete Software Producer ending: the citizen delivers
   * something a reader outside the Colony can open, names who was asked, and is
   * then offered a choice rather than handed a successor.
   */
  it('closes a cycle as shipped on inspectable evidence and offers four choices', async () => {
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, owner))
    const started = await startProfessionPracticum(db, {
      callerId: owner,
      outcome: 'Help one support team see service health with a smallest runnable status page.',
    })
    if (started.outcome !== 'started') throw new Error('cycle missing')

    const closed = await closeProfessionPracticum(db, {
      callerId: owner,
      cycleId: started.cycle.id,
      close: {
        result: 'shipped',
        evidence: { kind: 'url', ref: 'https://example.invalid/status-page' },
        feedback: 'Asked the support lead to open it and name one thing that is wrong.',
      },
    })

    expect(closed.outcome).toBe('closed')
    if (closed.outcome !== 'closed') return
    expect(closed.retrospective.cycleId).toBe(started.cycle.id)
    expect(closed.retrospective.result).toBe('shipped')
    expect(Object.keys(closed.retrospective.choices)).toEqual([
      'startRevised',
      'replaceOutcome',
      'defer',
      'end',
    ])
    expect(closed.retrospective.choices.defer.arguments.act).toBe('defer-practicum')
    expect(closed.retrospective.choices.end.arguments.act).toBe('end-practicum')
    const evidenceLinks = await db
      .select({ kind: workplaceCardLinks.kind, ref: workplaceCardLinks.ref })
      .from(workplaceCardLinks)
      .innerJoin(workplaceCards, eq(workplaceCards.id, workplaceCardLinks.cardId))
      .where(sql`${workplaceCards.seedKey} like ${`${started.cycle.id}#%`}`)
    expect(evidenceLinks).toEqual([{ kind: 'url', ref: 'https://example.invalid/status-page' }])
    expect(await workplaceWakeup(db, owner)).toMatchObject({
      practicumActive: false,
      practicumRetrospective: {
        cycleId: started.cycle.id,
        result: 'shipped',
      },
    })

    // Nothing is opened on the citizen's behalf: the cards it already had are
    // the cards it still has.
    expect(
      await db
        .select()
        .from(workplaceCards)
        .where(sql`${workplaceCards.seedKey} like ${`${started.cycle.id}#%`}`),
    ).toHaveLength(5)
  })

  it('closes a cycle as a failed experiment on an attempt and an observation', async () => {
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, owner))
    const started = await startProfessionPracticum(db, {
      callerId: owner,
      outcome: 'Deliver one runnable status page.',
    })
    if (started.outcome !== 'started') throw new Error('cycle missing')

    const closed = await closeProfessionPracticum(db, {
      callerId: owner,
      cycleId: started.cycle.id,
      close: {
        result: 'failed_experiment',
        attempted: 'Built the smallest page against the published health endpoint.',
        observed: 'The provider refused the account, so nothing could be published.',
        nextChoice: 'Try the same outcome as a static page in the next cycle.',
      },
    })

    expect(closed.outcome).toBe('closed')
    if (closed.outcome !== 'closed') return
    expect(closed.retrospective.result).toBe('failed_experiment')
    // A failed experiment is terminal and is not a forced retry: the four
    // choices are the same four a shipped cycle is offered.
    expect(Object.keys(closed.retrospective.choices)).toEqual([
      'startRevised',
      'replaceOutcome',
      'defer',
      'end',
    ])
    // It is counted through the same path a shipped cycle is (`#1844` review),
    // and it costs the citizen nothing: no shipped count, no standing change.
    const counts = await practicumEventCounts(db)
    expect(counts.failed_experiment).toBe(1)
    expect(counts.shipped).toBe(0)

    // Ending after a failed experiment writes no cards and is counted once.
    expect(
      await resolveProfessionPracticum(db, {
        callerId: owner,
        cycleId: started.cycle.id,
        choice: 'ended',
      }),
    ).toEqual({ outcome: 'resolved', choice: 'ended' })
    expect((await practicumEventCounts(db)).ended).toBe(1)
    expect(await workplaceWakeup(db, owner)).not.toHaveProperty('practicumRetrospective')
    expect(
      await db
        .select()
        .from(workplaceCards)
        .where(sql`${workplaceCards.seedKey} like 'practicum:%'`),
    ).toHaveLength(5)
  })

  it('refuses to close a cycle that is not the citizen own, and one that does not exist', async () => {
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, owner))
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, stranger))
    const started = await startProfessionPracticum(db, {
      callerId: owner,
      outcome: 'Deliver one runnable status page.',
    })
    if (started.outcome !== 'started') throw new Error('cycle missing')

    const close = {
      result: 'failed_experiment' as const,
      attempted: 'Tried the smallest version.',
      observed: 'It could not be published.',
      nextChoice: 'End this outcome and choose another later.',
    }
    expect(
      await closeProfessionPracticum(db, {
        callerId: stranger,
        cycleId: started.cycle.id,
        close,
      }),
    ).toEqual({ outcome: 'unknown-cycle' })
    expect(
      await closeProfessionPracticum(db, {
        callerId: owner,
        cycleId: 'practicum:11111111-2222-4333-8444-555555555555',
        close,
      }),
    ).toEqual({ outcome: 'unknown-cycle' })
  })

  /**
   * The idempotency `#1836` requires: closing twice is one terminal cycle and
   * one counted event, and it never mints a successor.
   */
  it('keeps a repeated close idempotent and counts one terminal event', async () => {
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, owner))
    const started = await startProfessionPracticum(db, {
      callerId: owner,
      outcome: 'Deliver one runnable status page.',
    })
    if (started.outcome !== 'started') throw new Error('cycle missing')
    const close = {
      result: 'shipped' as const,
      evidence: { kind: 'url' as const, ref: 'https://example.invalid/status-page' },
      feedback: 'Asked one maintainer to try it.',
    }

    const first = await closeProfessionPracticum(db, {
      callerId: owner,
      cycleId: started.cycle.id,
      close,
    })
    const again = await closeProfessionPracticum(db, {
      callerId: owner,
      cycleId: started.cycle.id,
      close,
    })

    expect(first.outcome).toBe('closed')
    expect(again.outcome).toBe('closed')
    if (first.outcome !== 'closed' || again.outcome !== 'closed') return
    expect(again.retrospective).toEqual(first.retrospective)
    const counts = await practicumEventCounts(db)
    expect(counts.shipped).toBe(1)
    expect(counts.accepted).toBe(1)
  })

  it('records defer once, creates no successor, and removes the retrospective from wakeup', async () => {
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, owner))
    const started = await startProfessionPracticum(db, {
      callerId: owner,
      outcome: 'Deliver one runnable status page.',
    })
    if (started.outcome !== 'started') throw new Error('cycle missing')
    await closeProfessionPracticum(db, {
      callerId: owner,
      cycleId: started.cycle.id,
      close: {
        result: 'shipped',
        evidence: { kind: 'url', ref: 'https://example.invalid/status-page' },
        feedback: 'Asked one maintainer to open it.',
      },
    })

    expect(
      await resolveProfessionPracticum(db, {
        callerId: owner,
        cycleId: started.cycle.id,
        choice: 'deferred',
      }),
    ).toEqual({ outcome: 'resolved', choice: 'deferred' })
    expect(
      await resolveProfessionPracticum(db, {
        callerId: owner,
        cycleId: started.cycle.id,
        choice: 'deferred',
      }),
    ).toEqual({ outcome: 'resolved', choice: 'deferred' })
    expect(await workplaceWakeup(db, owner)).not.toHaveProperty('practicumRetrospective')
    expect((await practicumEventCounts(db)).deferred).toBe(1)
    expect(
      await db
        .select()
        .from(workplaceCards)
        .where(sql`${workplaceCards.seedKey} like 'practicum:%'`),
    ).toHaveLength(5)
  })

  /**
   * The rejection case the issue names by title: a card called *document
   * progress* moved to Done is not evidence, and neither is card volume.
   */
  it('does not let documentation-only work close a cycle', async () => {
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, owner))
    const started = await startProfessionPracticum(db, {
      callerId: owner,
      outcome: 'Deliver one runnable status page.',
    })
    if (started.outcome !== 'started') throw new Error('cycle missing')

    for (const card of started.cycle.cards) {
      const ready = await moveCard(db, {
        callerId: owner,
        cardId: card.id,
        expectedVersion: card.version,
        status: 'ready',
      })
      if (ready.outcome !== 'moved') throw new Error('ready move failed')
      const claimed = await claimCard(db, {
        callerId: owner,
        cardId: card.id,
        expectedVersion: ready.card.version,
      })
      if (claimed.outcome !== 'claimed') throw new Error('claim failed')
      const completed = await completeCard(db, {
        callerId: owner,
        cardId: card.id,
        expectedVersion: claimed.card.version,
        outcome: 'Documented progress in the card.',
      })
      expect(completed.outcome).toBe('completed')
    }

    const counts = await practicumEventCounts(db)
    expect(counts.shipped).toBe(0)
    expect(counts.failed_experiment).toBe(0)
    // The Colony can see the loop without reading a word of what was written.
    expect(counts.documentation_only_update).toBeGreaterThan(0)
    expect(await workplaceWakeup(db, owner)).toMatchObject({ practicumActive: true })
  })

  /**
   * The aggregate is counts and slugs. `#1836` forbids prose, identifiers and
   * references from reaching it, so this reads the stored rows themselves
   * rather than the projection over them.
   */
  it('records privacy-safe events carrying no citizen, cycle, outcome or evidence', async () => {
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, owner))
    const started = await startProfessionPracticum(db, {
      callerId: owner,
      outcome: 'Help one support team see service health with a smallest runnable status page.',
    })
    if (started.outcome !== 'started') throw new Error('cycle missing')
    await closeProfessionPracticum(db, {
      callerId: owner,
      cycleId: started.cycle.id,
      close: {
        result: 'shipped',
        evidence: { kind: 'url', ref: 'https://example.invalid/status-page' },
        feedback: 'Asked the support lead to open it.',
      },
    })

    const rows = await db.select().from(workplacePracticumEvents)
    expect(rows.length).toBeGreaterThan(0)
    const serialised = JSON.stringify(rows)
    for (const secret of [
      owner,
      started.cycle.id,
      'support team',
      'status-page',
      'example.invalid',
      'Asked the support lead',
    ]) {
      expect(serialised, secret).not.toContain(secret)
    }
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['at', 'event', 'id'])
  })

  it('plants one default board on first list without changing an existing additional board', async () => {
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, owner))
    const additional = await createBoard(db, { callerId: owner, title: 'Existing' })
    const memberBoard = await createBoard(db, { callerId: member, title: 'Member board' })
    await addMember(db, { callerId: member, boardId: memberBoard.id, citizenId: owner })

    const listed = await listBoardsFor(db, owner)

    expect(listed.outcome).toBe('listed')
    if (listed.outcome !== 'listed') return
    expect(listed.items).toHaveLength(3)
    expect(listed.items.find((board) => board.id === additional.id)).toEqual(additional)
    expect(listed.items.find((board) => board.id === memberBoard.id)).toEqual(memberBoard)
    expect(listed.items.filter((board) => board.kind === 'default')).toHaveLength(1)
  })

  it('converges concurrent own and delegated first lists on one default board', async () => {
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, owner))

    const [own, delegated] = await Promise.all([
      listBoardsFor(db, owner),
      listBoardsFor(db, owner),
      listBoardsFor(db, owner),
      listBoardsFor(db, owner),
    ])

    expect(own.outcome).toBe('listed')
    expect(delegated.outcome).toBe('listed')
    if (own.outcome !== 'listed' || delegated.outcome !== 'listed') return
    const ownDefault = own.items.find((board) => board.kind === 'default')
    const delegatedDefault = delegated.items.find((board) => board.kind === 'default')
    expect(ownDefault).toBeDefined()
    expect(delegatedDefault?.id).toBe(ownDefault?.id)
    expect(
      await db
        .select()
        .from(workplaceBoards)
        .where(and(eq(workplaceBoards.ownerId, owner), eq(workplaceBoards.kind, 'default'))),
    ).toHaveLength(1)
    expect(
      await db
        .select()
        .from(workplaceBoardMemberships)
        .where(eq(workplaceBoardMemberships.citizenId, owner)),
    ).toHaveLength(1)
  })

  it('hides a board from a citizen that is not a member, the same as a missing id', async () => {
    const board = await defaultBoard()
    expect(await getBoardFor(db, stranger, board.id)).toBeNull()
    expect(await getBoardFor(db, stranger, '00000000-0000-4000-8000-000000000000')).toBeNull()
    expect(await getBoardFor(db, stranger, 'not-a-uuid')).toBeNull()
    const hidden = await listBoardsFor(db, stranger)
    expect(hidden.outcome).toBe('listed')
    if (hidden.outcome !== 'listed') return
    expect(hidden.items).toEqual([])
  })

  it('lists owned and member boards together', async () => {
    const owned = await defaultBoard()
    const extra = await createBoard(db, { callerId: member, title: 'Shared' })
    await addMember(db, { callerId: member, boardId: extra.id, citizenId: owner })
    const listed = await listBoardsFor(db, owner)
    expect(listed.outcome).toBe('listed')
    if (listed.outcome !== 'listed') return
    expect(listed.items.map((one) => one.id).sort()).toEqual([owned.id, extra.id].sort())
  })

  it('writes owner membership in the same transaction as the board', async () => {
    const board = await createBoard(db, { callerId: owner, title: 'Extra' })
    expect(board.kind).toBe('additional')
    expect(await getBoardFor(db, owner, board.id)).toEqual(board)
  })

  it('refuses to archive the default board', async () => {
    const board = await defaultBoard()
    expect(
      await archiveBoard(db, {
        callerId: owner,
        boardId: board.id,
        expectedVersion: board.version,
      }),
    ).toEqual({ outcome: 'default-board-protected' })
  })

  it('archives an additional board the owner asks for', async () => {
    const board = await createBoard(db, { callerId: owner, title: 'Extra' })
    const archived = await archiveBoard(db, {
      callerId: owner,
      boardId: board.id,
      expectedVersion: board.version,
    })
    expect(archived.outcome).toBe('archived')
    if (archived.outcome !== 'archived') return
    expect(archived.board.archivedAt).not.toBeNull()
  })

  it('refuses a non-member write as forbidden, not as missing', async () => {
    const board = await defaultBoard()
    expect(await createCard(db, { callerId: stranger, boardId: board.id, title: 'Nope' })).toEqual({
      outcome: 'forbidden',
    })
    expect(
      await addMember(db, { callerId: stranger, boardId: board.id, citizenId: member }),
    ).toEqual({ outcome: 'forbidden' })
  })

  it('cannot remove the owner membership', async () => {
    const board = await defaultBoard()
    expect(
      await removeMember(db, { callerId: owner, boardId: board.id, citizenId: owner }),
    ).toEqual({ outcome: 'default-board-protected' })
  })

  it('renames an additional board and bumps version', async () => {
    const board = await createBoard(db, { callerId: owner, title: 'Extra' })
    const renamed = await renameBoard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Renamed',
      expectedVersion: board.version,
    })
    expect(renamed.outcome).toBe('renamed')
    if (renamed.outcome !== 'renamed') return
    expect(renamed.board.title).toBe('Renamed')
    expect(renamed.board.version).toBe(board.version + 1)
  })

  it('refuses a stale rename and a member rename', async () => {
    const board = await createBoard(db, { callerId: owner, title: 'Extra' })
    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    expect(
      await renameBoard(db, {
        callerId: owner,
        boardId: board.id,
        title: 'Stale',
        expectedVersion: board.version + 1,
      }),
    ).toEqual({ outcome: 'stale' })
    expect(
      await renameBoard(db, {
        callerId: member,
        boardId: board.id,
        title: 'Hijack',
        expectedVersion: board.version,
      }),
    ).toEqual({ outcome: 'forbidden' })
  })

  it('lists members for a member and hides them from a stranger', async () => {
    const board = await defaultBoard()
    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const listed = await listMembers(db, owner, board.id)
    expect(listed.outcome).toBe('listed')
    if (listed.outcome !== 'listed') return
    expect(listed.members.map((one) => one.citizenId).sort()).toEqual([owner, member].sort())
    expect(await listMembers(db, stranger, board.id)).toEqual({ outcome: 'unknown' })
    expect(await listMembers(db, member, board.id)).toEqual(listed)
  })

  it('pages boards the caller is on, newest last, and refuses a forged cursor', async () => {
    const first = await defaultBoard()
    const extra = await createBoard(db, { callerId: owner, title: 'Extra' })
    const page = await listBoardsFor(db, owner, { limit: 1 })
    expect(page.outcome).toBe('listed')
    if (page.outcome !== 'listed') return
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.id).toBe(first.id)
    expect(page.nextCursor).not.toBeNull()
    const rest = await listBoardsFor(db, owner, { cursor: page.nextCursor, limit: 1 })
    expect(rest.outcome).toBe('listed')
    if (rest.outcome !== 'listed') return
    expect(rest.items.map((one) => one.id)).toEqual([extra.id])
    expect(rest.nextCursor).toBeNull()
    expect(await listBoardsFor(db, owner, { cursor: 'not-a-cursor' })).toEqual({
      outcome: 'invalid-cursor',
    })
  })

  it('refuses to remove a member who still owns live work', async () => {
    const board = await defaultBoard()
    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Walk a provider',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: member,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    expect(claimed.outcome).toBe('claimed')
    expect(
      await removeMember(db, { callerId: owner, boardId: board.id, citizenId: member }),
    ).toEqual({ outcome: 'handover-required' })
  })

  it('lists card summaries without comment bodies', async () => {
    const board = await defaultBoard()
    await createCard(db, { callerId: owner, boardId: board.id, title: 'One' })
    const listed = await listCards(db, owner, board.id)
    expect(listed.outcome).toBe('listed')
    if (listed.outcome !== 'listed') return
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]?.title).toBe('One')
    expect(listed.items[0]?.commentCount).toBe(0)
    expect(listed.items[0]?.linkCount).toBe(0)
    expect(listed.items[0]?.linkCounts).toEqual({
      account: 0,
      provider: 0,
      vault: 0,
      task: 0,
      playbook: 0,
      url: 0,
    })
    expect(listed.items[0]).not.toHaveProperty('comments')
    expect(listed.items[0]).not.toHaveProperty('description')
  })

  it('records one canonical event for each card mutation family without copying private bodies', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Eventful card',
      description: 'Private description',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const updated = await updateCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
      title: 'Changed title',
    })
    if (updated.outcome !== 'updated') throw new Error('update failed')
    const noOp = await updateCard(db, {
      callerId: owner,
      cardId: updated.card.id,
      expectedVersion: updated.card.version,
      title: updated.card.title,
    })
    expect(noOp).toEqual({ outcome: 'updated', card: updated.card })
    expect(
      await updateCard(db, {
        callerId: owner,
        cardId: updated.card.id,
        expectedVersion: created.card.version,
        title: updated.card.title,
      }),
    ).toEqual({ outcome: 'stale' })
    const claimed = await claimCard(db, {
      callerId: owner,
      cardId: updated.card.id,
      expectedVersion: updated.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    const checklist = await createChecklist(db, {
      callerId: owner,
      cardId: claimed.card.id,
      title: 'Private checklist',
    })
    if (checklist.outcome !== 'created') throw new Error('checklist failed')
    const item = await createChecklistItem(db, {
      callerId: owner,
      checklistId: checklist.checklist.id,
      title: 'Private item',
    })
    if (item.outcome !== 'created') throw new Error('item failed')
    const comment = await createComment(db, {
      callerId: owner,
      cardId: claimed.card.id,
      body: 'Private comment body',
    })
    if (comment.outcome !== 'created') throw new Error('comment failed')
    const link = await addLink(db, {
      callerId: owner,
      cardId: claimed.card.id,
      kind: 'url',
      ref: 'https://example.com/private',
    })
    if (link.outcome !== 'created') throw new Error('link failed')
    const blocked = await blockCard(db, {
      callerId: owner,
      cardId: claimed.card.id,
      expectedVersion: claimed.card.version,
      blockedBy: 'Waiting for an answer.',
      unblockWhen: 'The answer arrives.',
    })
    if (blocked.outcome !== 'blocked') throw new Error('block failed')

    const listed = await listCardEvents(db, owner, created.card.id, { limit: 100 })
    expect(listed.outcome).toBe('listed')
    if (listed.outcome !== 'listed') return
    expect(listed.items.map((event) => event.verb)).toEqual([
      'card.blocked',
      'card.link_created',
      'card.comment_created',
      'card.checklist_item_created',
      'card.checklist_created',
      'card.claimed',
      'card.updated',
      'card.created',
    ])
    expect(listed.items.every((event) => event.actorId === owner)).toBe(true)
    expect(JSON.stringify(listed.items)).not.toContain('Private comment body')
    expect(JSON.stringify(listed.items)).not.toContain('Private checklist')
    expect(JSON.stringify(listed.items)).not.toContain('example.com/private')
  })

  it('paginates tied events newest-first and hides the timeline from a stranger', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, { callerId: owner, boardId: board.id, title: 'Timeline' })
    if (created.outcome !== 'created') throw new Error('card missing')
    const at = '2026-09-12T12:00:00.000Z'
    await db
      .update(workplaceActivity)
      .set({ createdAt: at })
      .where(eq(workplaceActivity.cardId, created.card.id))
    await db.insert(workplaceActivity).values([
      {
        boardId: board.id,
        cardId: created.card.id,
        actorId: owner,
        actorKind: 'citizen',
        verb: 'card.comment_created',
        payload: { commentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        createdAt: at,
      },
      {
        boardId: board.id,
        cardId: created.card.id,
        actorId: owner,
        actorKind: 'citizen',
        verb: 'card.comment_deleted',
        payload: { commentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        createdAt: at,
      },
    ])
    const first = await listCardEvents(db, owner, created.card.id, { limit: 2 })
    expect(first.outcome).toBe('listed')
    if (first.outcome !== 'listed') return
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await listCardEvents(db, owner, created.card.id, {
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second.outcome).toBe('listed')
    if (second.outcome !== 'listed') return
    expect(new Set([...first.items, ...second.items].map((event) => event.id)).size).toBe(3)
    expect(await listCardEvents(db, owner, created.card.id, { cursor: 'forged' })).toEqual({
      outcome: 'invalid-cursor',
    })
    expect(await listCardEvents(db, stranger, created.card.id)).toEqual({ outcome: 'unknown' })
  })

  it('keeps card events after actor erasure and removes them with card cascade', async () => {
    const board = await defaultBoard()
    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const created = await createCard(db, {
      callerId: member,
      boardId: board.id,
      title: 'Surviving history',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const [before] = await db
      .select()
      .from(workplaceActivity)
      .where(eq(workplaceActivity.cardId, created.card.id))
    expect(before?.actorId).toBe(member)
    await eraseAgent(db, { agentId: member, banSalt: SALT })
    const history = await listCardEvents(db, owner, created.card.id)
    expect(history.outcome).toBe('listed')
    if (history.outcome !== 'listed') return
    expect(history.items[0]?.actorId).toBeNull()
    expect(history.items[0]?.actorKind).toBe('citizen')
    await db.delete(workplaceCards).where(eq(workplaceCards.id, created.card.id))
    expect(
      await db
        .select()
        .from(workplaceActivity)
        .where(eq(workplaceActivity.cardId, created.card.id)),
    ).toHaveLength(0)
  })

  it('rolls back an event when its state mutation rolls back', async () => {
    const board = await defaultBoard()
    await expect(
      db.transaction(async (tx) => {
        const result = await createCard(tx as unknown as Database, {
          callerId: owner,
          boardId: board.id,
          title: 'Rolled back',
        })
        if (result.outcome !== 'created') throw new Error('create failed')
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await db.select().from(workplaceActivity)).toHaveLength(0)
  })

  it('reports an ownerless inbox claim as an invalid transition', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Not ready',
      status: 'inbox',
    })
    if (created.outcome !== 'created') throw new Error('card missing')

    expect(
      await claimCard(db, {
        callerId: owner,
        cardId: created.card.id,
        expectedVersion: created.card.version,
      }),
    ).toEqual({ outcome: 'invalid-transition' })
    expect((await getCard(db, owner, created.card.id))?.card).toMatchObject({
      status: 'inbox',
      ownerId: null,
      version: created.card.version,
    })
  })

  it('claims with one statement: two concurrent claims, exactly one wins', async () => {
    const board = await defaultBoard()
    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Claim me',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')

    const results = await Promise.all([
      claimCard(db, {
        callerId: owner,
        cardId: created.card.id,
        expectedVersion: created.card.version,
      }),
      claimCard(db, {
        callerId: member,
        cardId: created.card.id,
        expectedVersion: created.card.version,
      }),
    ])

    expect(results.filter((one) => one.outcome === 'claimed')).toHaveLength(1)
    expect(results.filter((one) => one.outcome === 'conflict')).toHaveLength(1)
  })

  it('replays a create against the same idempotency key without a second card', async () => {
    const board = await defaultBoard()
    const first = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Once',
      idempotencyKey: 'create-once',
    })
    const second = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Once',
      idempotencyKey: 'create-once',
    })
    expect(first.outcome).toBe('created')
    expect(second.outcome).toBe('created')
    if (first.outcome !== 'created' || second.outcome !== 'created') return
    expect(second.card.id).toBe(first.card.id)
    const listed = await listCards(db, owner, board.id)
    if (listed.outcome !== 'listed') throw new Error('list failed')
    expect(listed.items).toHaveLength(1)
    const events = await listCardEvents(db, owner, first.card.id)
    expect(events.outcome).toBe('listed')
    if (events.outcome === 'listed') expect(events.items).toHaveLength(1)
  })

  it('replays a claim against the same idempotency key without a second side effect', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Once',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const first = await claimCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
      idempotencyKey: 'claim-once',
    })
    const second = await claimCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
      idempotencyKey: 'claim-once',
    })
    expect(first.outcome).toBe('claimed')
    expect(second.outcome).toBe('claimed')
    if (first.outcome !== 'claimed' || second.outcome !== 'claimed') return
    expect(second.card.version).toBe(first.card.version)
    const events = await listCardEvents(db, owner, created.card.id)
    expect(events.outcome).toBe('listed')
    if (events.outcome === 'listed') {
      expect(events.items.map((event) => event.verb)).toEqual(['card.claimed', 'card.created'])
    }
  })

  it('refuses inbox → in_progress as a move', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Inbox',
      status: 'inbox',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    expect(
      await moveCard(db, {
        callerId: owner,
        cardId: created.card.id,
        expectedVersion: created.card.version,
        status: 'in_progress',
      }),
    ).toEqual({ outcome: 'invalid-transition' })
  })

  it('bumps version on write and refuses a stale expectedVersion', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, { callerId: owner, boardId: board.id, title: 'Title' })
    if (created.outcome !== 'created') throw new Error('card missing')
    const first = await updateCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
      title: 'Renamed',
    })
    expect(first.outcome).toBe('updated')
    expect(
      await updateCard(db, {
        callerId: owner,
        cardId: created.card.id,
        expectedVersion: created.card.version,
        title: 'Stale',
      }),
    ).toEqual({ outcome: 'stale' })
  })

  it('hands a card to a named member and records the structured handover', async () => {
    const board = await defaultBoard()
    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Handover',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    const handed = await handoverCard(db, {
      callerId: owner,
      cardId: claimed.card.id,
      expectedVersion: claimed.card.version,
      to: member,
      done: 'Walked the first two steps.',
      learned: 'The form asks for a phone.',
      next: 'Ask the operator for the number.',
    })
    expect(handed.outcome).toBe('handed-over')
    if (handed.outcome !== 'handed-over') return
    expect(handed.card.ownerId).toBe(member)
    expect(handed.handover.to).toBe(member)
    expect(handed.handover.isCurrent).toBe(true)
  })

  it('completes and blocks with the sentences the lane requires', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Work',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    const blocked = await blockCard(db, {
      callerId: owner,
      cardId: claimed.card.id,
      expectedVersion: claimed.card.version,
      blockedBy: 'Waiting on a phone number.',
      unblockWhen: 'The operator has sent one.',
    })
    expect(blocked.outcome).toBe('blocked')
    if (blocked.outcome !== 'blocked') return
    const unblocked = await moveCard(db, {
      callerId: owner,
      cardId: blocked.card.id,
      expectedVersion: blocked.card.version,
      status: 'in_progress',
    })
    if (unblocked.outcome !== 'moved') throw new Error('could not unblock')
    const done = await completeCard(db, {
      callerId: owner,
      cardId: unblocked.card.id,
      expectedVersion: unblocked.card.version,
      outcome: 'The walk is filed.',
    })
    expect(done.outcome).toBe('completed')
  })

  it('closes with evidence atomically and appends revisions without reopening the card', async () => {
    const board = await defaultBoard()
    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Publish the result',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    const evidence = await addLink(db, {
      callerId: owner,
      cardId: created.card.id,
      kind: 'url',
      ref: 'https://example.com/result',
    })
    if (evidence.outcome !== 'created') throw new Error('link missing')

    const completed = await completeCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: claimed.card.version,
      close: {
        result: 'shipped',
        summary: 'Published the result.',
        learned: 'The reader could use it without assistance.',
        evidenceLinkIds: [evidence.link.id],
        next: { kind: 'none' },
      },
    })
    expect(completed.outcome).toBe('completed')
    if (completed.outcome !== 'completed') return
    expect(completed.closure.revision).toBe(1)
    expect(completed.closure.evidenceLinks[0]?.id).toBe(evidence.link.id)
    expect(completed.card.outcome).toBe('Published the result.')

    const revised = await createCardClosure(db, {
      callerId: owner,
      cardId: created.card.id,
      close: {
        result: 'failed_experiment',
        summary: 'Tried the public endpoint and observed a permanent 403 response.',
        learned: 'The provider blocks this deployment route.',
        evidenceLinkIds: [],
        next: { kind: 'sentence', text: 'Try a static host.' },
        supersedesClosureId: completed.closure.id,
      },
    })
    expect(revised.outcome).toBe('created')
    if (revised.outcome !== 'created') return
    expect(revised.closure.revision).toBe(2)
    expect(revised.closure.supersedesClosureId).toBe(completed.closure.id)
    expect(revised.card.status).toBe('done')
    expect(revised.card.version).toBe(completed.card.version)

    const listed = await listCardClosures(db, member, created.card.id, { limit: 1 })
    expect(listed.outcome).toBe('listed')
    if (listed.outcome !== 'listed') return
    expect(listed.items[0]?.id).toBe(revised.closure.id)
    expect(listed.nextCursor).not.toBeNull()
    expect(
      await createCardClosure(db, {
        callerId: owner,
        cardId: created.card.id,
        close: {
          result: 'abandoned',
          summary: 'Stopped the earlier route.',
          learned: 'The replacement is now canonical.',
          evidenceLinkIds: [],
          next: { kind: 'card', cardId: created.card.id },
          supersedesClosureId: completed.closure.id,
        },
      }),
    ).toEqual({ outcome: 'conflict' })

    const detail = await getCard(db, owner, created.card.id)
    expect(detail?.closureCount).toBe(2)
    expect(detail?.latestClosure?.id).toBe(revised.closure.id)
    const events = await listCardEvents(db, owner, created.card.id)
    expect(events.outcome).toBe('listed')
    if (events.outcome !== 'listed') return
    expect(events.items[0]?.payload).toEqual({
      closeRecordId: completed.closure.id,
      result: 'shipped',
    })
  })

  it('refuses foreign evidence and successor cards without partially closing', async () => {
    const board = await defaultBoard()
    const otherBoard = await createBoard(db, { callerId: owner, title: 'Other' })
    const target = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Target',
      status: 'ready',
    })
    const foreign = await createCard(db, {
      callerId: owner,
      boardId: otherBoard.id,
      title: 'Foreign',
      status: 'ready',
    })
    if (target.outcome !== 'created' || foreign.outcome !== 'created')
      throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: owner,
      cardId: target.card.id,
      expectedVersion: target.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    const foreignEvidence = await addLink(db, {
      callerId: owner,
      cardId: foreign.card.id,
      kind: 'url',
      ref: 'https://example.com/foreign',
    })
    if (foreignEvidence.outcome !== 'created') throw new Error('link missing')

    expect(
      await completeCard(db, {
        callerId: owner,
        cardId: target.card.id,
        expectedVersion: claimed.card.version,
        close: {
          result: 'shipped',
          summary: 'Published the result.',
          learned: 'The route works.',
          evidenceLinkIds: [foreignEvidence.link.id],
          next: { kind: 'none' },
        },
      }),
    ).toEqual({ outcome: 'invalid-evidence' })
    expect(
      await completeCard(db, {
        callerId: owner,
        cardId: target.card.id,
        expectedVersion: claimed.card.version,
        close: {
          result: 'superseded',
          summary: 'Replaced this approach.',
          learned: 'The other board has the successor.',
          evidenceLinkIds: [],
          next: { kind: 'card', cardId: foreign.card.id },
        },
      }),
    ).toEqual({ outcome: 'invalid-successor' })
    expect(await db.select().from(workplaceCardClosures)).toHaveLength(0)
    expect(await db.select().from(workplaceCardClosureEvidence)).toHaveLength(0)
    expect((await getCard(db, owner, target.card.id))?.card.status).toBe('in_progress')
  })

  it('keeps closure prose after actor erasure and removes closure evidence with its link', async () => {
    const board = await defaultBoard()
    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const created = await createCard(db, {
      callerId: member,
      boardId: board.id,
      title: 'Member result',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: member,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    const evidence = await addLink(db, {
      callerId: member,
      cardId: created.card.id,
      kind: 'url',
      ref: 'https://example.com/member-result',
    })
    if (evidence.outcome !== 'created') throw new Error('link missing')
    const completed = await completeCard(db, {
      callerId: member,
      cardId: created.card.id,
      expectedVersion: claimed.card.version,
      close: {
        result: 'shipped',
        summary: 'Published the member result.',
        learned: 'The result survives identity erasure.',
        evidenceLinkIds: [evidence.link.id],
        next: { kind: 'none' },
      },
    })
    if (completed.outcome !== 'completed') throw new Error('complete failed')

    await eraseAgent(db, { agentId: member, banSalt: SALT })
    const afterErasure = await listCardClosures(db, owner, created.card.id)
    expect(afterErasure.outcome).toBe('listed')
    if (afterErasure.outcome !== 'listed') return
    expect(afterErasure.items[0]?.actorId).toBeNull()
    expect(afterErasure.items[0]?.summary).toBe('Published the member result.')

    await removeLink(db, { callerId: owner, linkId: evidence.link.id })
    const afterLinkRemoval = await listCardClosures(db, owner, created.card.id)
    expect(afterLinkRemoval.outcome).toBe('listed')
    if (afterLinkRemoval.outcome !== 'listed') return
    expect(afterLinkRemoval.items[0]?.evidenceLinkIds).toEqual([])
    expect(afterLinkRemoval.items[0]?.evidenceLinks).toEqual([])
  })

  it('refuses mutation of an existing close record', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Immutable result',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    const completed = await completeCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: claimed.card.version,
      close: {
        result: 'failed_experiment',
        summary: 'Tried the endpoint and observed a timeout.',
        learned: 'The route is unavailable.',
        evidenceLinkIds: [],
        next: { kind: 'none' },
      },
    })
    if (completed.outcome !== 'completed') throw new Error('complete failed')
    await expectRejection(
      () =>
        db
          .update(workplaceCardClosures)
          .set({ summary: 'Rewritten history.' })
          .where(eq(workplaceCardClosures.id, completed.closure.id)),
      /append-only/,
    )

    await db.delete(workplaceCards).where(eq(workplaceCards.id, created.card.id))
    expect(
      await db
        .select()
        .from(workplaceCardClosures)
        .where(eq(workplaceCardClosures.cardId, created.card.id)),
    ).toHaveLength(0)
  })

  it('leaves a foreign in_progress card ready and ownerless when its owner is erased', async () => {
    const board = await defaultBoard()
    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Live work',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: member,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')

    const erased = await eraseAgent(db, { agentId: member, banSalt: SALT })
    expect(erased.outcome).toBe('erased')

    const remaining = await getCard(db, owner, claimed.card.id)
    expect(remaining?.card.ownerId).toBeNull()
    expect(remaining?.card.status).toBe('ready')
  })

  it('clears the owner atomically on in_progress → ready, and not on blocked or review', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Unclaim me',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')

    const unclaimed = await moveCard(db, {
      callerId: owner,
      cardId: claimed.card.id,
      expectedVersion: claimed.card.version,
      status: 'ready',
    })
    expect(unclaimed.outcome).toBe('moved')
    if (unclaimed.outcome !== 'moved') return
    expect(unclaimed.card.status).toBe('ready')
    expect(unclaimed.card.ownerId).toBeNull()

    const reclaimed = await claimCard(db, {
      callerId: owner,
      cardId: unclaimed.card.id,
      expectedVersion: unclaimed.card.version,
    })
    if (reclaimed.outcome !== 'claimed') throw new Error('reclaim failed')
    const blocked = await blockCard(db, {
      callerId: owner,
      cardId: reclaimed.card.id,
      expectedVersion: reclaimed.card.version,
      blockedBy: 'Waiting on a number.',
      unblockWhen: 'The operator has sent one.',
    })
    if (blocked.outcome !== 'blocked') throw new Error('block failed')
    const fromBlocked = await moveCard(db, {
      callerId: owner,
      cardId: blocked.card.id,
      expectedVersion: blocked.card.version,
      status: 'ready',
    })
    expect(fromBlocked.outcome).toBe('moved')
    if (fromBlocked.outcome !== 'moved') return
    expect(fromBlocked.card.ownerId).toBe(owner)

    const restarted = await moveCard(db, {
      callerId: owner,
      cardId: fromBlocked.card.id,
      expectedVersion: fromBlocked.card.version,
      status: 'in_progress',
    })
    if (restarted.outcome !== 'moved') throw new Error('could not restart')
    const inReview = await moveCard(db, {
      callerId: owner,
      cardId: restarted.card.id,
      expectedVersion: restarted.card.version,
      status: 'review',
    })
    if (inReview.outcome !== 'moved') throw new Error('review failed')
    const fromReview = await moveCard(db, {
      callerId: owner,
      cardId: inReview.card.id,
      expectedVersion: inReview.card.version,
      status: 'ready',
    })
    expect(fromReview.outcome).toBe('moved')
    if (fromReview.outcome !== 'moved') return
    expect(fromReview.card.ownerId).toBe(owner)
  })

  it('leaves a foreign done card done, with its outcome, when its owner is erased', async () => {
    const board = await defaultBoard()
    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Finished work',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: member,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    const done = await completeCard(db, {
      callerId: member,
      cardId: claimed.card.id,
      expectedVersion: claimed.card.version,
      outcome: 'The walk is filed.',
    })
    if (done.outcome !== 'completed') throw new Error('complete failed')

    const erased = await eraseAgent(db, { agentId: member, banSalt: SALT })
    expect(erased.outcome).toBe('erased')

    const remaining = await getCard(db, owner, done.card.id)
    expect(remaining?.card.ownerId).toBeNull()
    expect(remaining?.card.status).toBe('done')
    expect(remaining?.card.outcome).toBe('The walk is filed.')
  })

  it('names missing, empty, forbidden and conflict as distinct write outcomes', async () => {
    const board = await defaultBoard()
    const missingId = '00000000-0000-4000-8000-000000000000'
    expect(
      await updateCard(db, {
        callerId: owner,
        cardId: missingId,
        expectedVersion: 1,
        title: 'Ghost',
      }),
    ).toEqual({ outcome: 'missing' })
    expect(await listCards(db, owner, board.id)).toEqual({ outcome: 'empty' })
    expect(await listCards(db, stranger, board.id)).toEqual({ outcome: 'unknown' })
    expect(await getCard(db, stranger, missingId)).toBeNull()

    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Live',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    expect(
      await updateCard(db, {
        callerId: stranger,
        cardId: created.card.id,
        expectedVersion: created.card.version,
        title: 'Stolen',
      }),
    ).toEqual({ outcome: 'forbidden' })
    expect(await getCard(db, stranger, created.card.id)).toBeNull()

    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const claimed = await claimCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    expect(
      await claimCard(db, {
        callerId: member,
        cardId: claimed.card.id,
        expectedVersion: claimed.card.version,
      }),
    ).toEqual({ outcome: 'conflict' })
    expect(
      await moveCard(db, {
        callerId: owner,
        cardId: claimed.card.id,
        expectedVersion: claimed.card.version,
        status: 'inbox',
      }),
    ).toEqual({ outcome: 'invalid-transition' })
  })

  it('replays createBoard against the same idempotency key without a second board', async () => {
    const first = await createBoard(db, {
      callerId: owner,
      title: 'Once',
      idempotencyKey: 'board-once',
    })
    const second = await createBoard(db, {
      callerId: owner,
      title: 'Once',
      idempotencyKey: 'board-once',
    })
    expect(second.id).toBe(first.id)
    const listed = await listBoardsFor(db, owner)
    expect(listed.outcome).toBe('listed')
    if (listed.outcome !== 'listed') return
    expect(listed.items.filter((one) => one.kind === 'additional')).toHaveLength(1)
  })

  it('refuses a write whose membership disappeared before the statement landed', async () => {
    const board = await defaultBoard()
    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Race',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')

    const locker = createDatabase(target.url, { max: 1, onnotice: () => {} })
    const watcher = createDatabase(target.url, { max: 1, onnotice: () => {} })
    let release = (): void => {}
    const lockTaken = new Promise<void>((resolve) => {
      void locker.transaction(async (tx) => {
        await tx
          .update(workplaceCards)
          .set({ title: sql`${workplaceCards.title}` })
          .where(eq(workplaceCards.id, created.card.id))
        resolve()
        await new Promise<void>((done) => {
          release = done
        })
      })
    })

    try {
      await lockTaken
      const write = updateCard(db, {
        callerId: member,
        cardId: created.card.id,
        expectedVersion: created.card.version,
        title: 'Stolen mid-write',
      })
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const waiting = await watcher.execute<{ n: string }>(sql`
          select count(*)::text as n
            from pg_stat_activity
           where datname = current_database()
             and wait_event_type = 'Lock'
             and state = 'active'
        `)
        if (Number(waiting[0]?.n ?? 0) > 0) break
        if (attempt === 49) throw new Error('writer never blocked on the card lock')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(
        await removeMember(watcher, {
          callerId: owner,
          boardId: board.id,
          citizenId: member,
        }),
      ).toEqual({ outcome: 'removed' })
      release()
      expect(await write).toEqual({ outcome: 'forbidden' })
    } finally {
      release()
      await locker.close()
      await watcher.close()
    }
  })

  it('does not let storage write in_progress without an owner either', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Inbox',
      status: 'inbox',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    await expectRejection(
      () =>
        db
          .update(workplaceCards)
          .set({ status: 'in_progress' })
          .where(eq(workplaceCards.id, created.card.id)),
      /workplace_cards_active_has_owner/,
    )
  })

  it('moves an ownerless ready card into in_progress by claiming it', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Claim by move',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const moved = await moveCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
      status: 'in_progress',
    })
    expect(moved.outcome).toBe('moved')
    if (moved.outcome !== 'moved') return
    expect(moved.card.ownerId).toBe(owner)
    expect(moved.card.status).toBe('in_progress')
  })

  it('refuses a move into in_progress when somebody else already owns it', async () => {
    const board = await defaultBoard()
    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Owned',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    const blocked = await blockCard(db, {
      callerId: owner,
      cardId: claimed.card.id,
      expectedVersion: claimed.card.version,
      blockedBy: 'Waiting on a phone number.',
      unblockWhen: 'The operator has sent one.',
    })
    if (blocked.outcome !== 'blocked') throw new Error('block failed')
    const ready = await moveCard(db, {
      callerId: owner,
      cardId: blocked.card.id,
      expectedVersion: blocked.card.version,
      status: 'ready',
    })
    if (ready.outcome !== 'moved') throw new Error('could not return to ready')
    expect(ready.card.ownerId).toBe(owner)
    expect(
      await moveCard(db, {
        callerId: member,
        cardId: ready.card.id,
        expectedVersion: ready.card.version,
        status: 'in_progress',
      }),
    ).toEqual({ outcome: 'handover-required' })
  })

  it('requests review and archives as the board owner, never from done', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Review me',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    const reviewed = await requestReview(db, {
      callerId: owner,
      cardId: claimed.card.id,
      expectedVersion: claimed.card.version,
    })
    expect(reviewed.outcome).toBe('reviewed')
    if (reviewed.outcome !== 'reviewed') return
    expect(reviewed.card.status).toBe('review')

    const archived = await archiveCard(db, {
      callerId: owner,
      cardId: reviewed.card.id,
      expectedVersion: reviewed.card.version,
    })
    expect(archived.outcome).toBe('invalid-transition')

    const back = await moveCard(db, {
      callerId: owner,
      cardId: reviewed.card.id,
      expectedVersion: reviewed.card.version,
      status: 'ready',
    })
    if (back.outcome !== 'moved') throw new Error('could not unclaim')
    const putAway = await archiveCard(db, {
      callerId: owner,
      cardId: back.card.id,
      expectedVersion: back.card.version,
    })
    expect(putAway.outcome).toBe('archived')
    if (putAway.outcome !== 'archived') return
    expect(putAway.card.archivedAt).not.toBeNull()
    expect(putAway.card.status).toBe('ready')
  })

  it('refuses a member who is not the board owner from archiving', async () => {
    const board = await defaultBoard()
    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Keep',
      status: 'inbox',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    expect(
      await archiveCard(db, {
        callerId: member,
        cardId: created.card.id,
        expectedVersion: created.card.version,
      }),
    ).toEqual({ outcome: 'forbidden' })
  })

  it('attaches a board label, comments and a checklist, and hides them from a stranger', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, { callerId: owner, boardId: board.id, title: 'Tagged' })
    if (created.outcome !== 'created') throw new Error('card missing')
    const [label] = await db
      .insert(workplaceLabels)
      .values({ boardId: board.id, slug: 'growth', name: 'growth', colour: '#336699' })
      .returning()
    if (label === undefined) throw new Error('could not plant a label')

    const attached = await attachLabel(db, {
      callerId: owner,
      cardId: created.card.id,
      labelId: label.id,
    })
    expect(attached.outcome).toBe('attached')

    const listed = await createChecklist(db, {
      callerId: owner,
      cardId: created.card.id,
      title: 'Prove it',
    })
    expect(listed.outcome).toBe('created')
    if (listed.outcome !== 'created') return
    const item = await createChecklistItem(db, {
      callerId: owner,
      checklistId: listed.checklist.id,
      title: 'Mint the challenge',
    })
    expect(item.outcome).toBe('created')

    const commented = await createComment(db, {
      callerId: owner,
      cardId: created.card.id,
      body: 'Started.',
    })
    expect(commented.outcome).toBe('created')

    const detail = await getCard(db, owner, created.card.id)
    expect(detail?.labels).toHaveLength(1)
    expect(detail?.checklists[0]?.items).toHaveLength(1)
    expect(detail?.comments[0]?.body).toBe('Started.')
    expect(await getCard(db, stranger, created.card.id)).toBeNull()
    expect(await listComments(db, stranger, created.card.id)).toEqual({ outcome: 'unknown' })
    expect(
      await deleteChecklist(db, { callerId: stranger, checklistId: listed.checklist.id }),
    ).toEqual({ outcome: 'forbidden' })
  })

  it('adds, lists and removes a url link; a second POST of the same kind and ref is the same row', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, { callerId: owner, boardId: board.id, title: 'Walk' })
    if (created.outcome !== 'created') throw new Error('card missing')

    const first = await addLink(db, {
      callerId: owner,
      cardId: created.card.id,
      kind: 'url',
      ref: 'https://example.com/walk',
      note: 'the walk page',
    })
    expect(first.outcome).toBe('created')
    if (first.outcome !== 'created') return
    expect(first.link.kind).toBe('url')
    expect(first.link.ref).toBe('https://example.com/walk')
    expect(first.link.note).toBe('the walk page')
    expect(first.link.target).toEqual({ state: 'resolved', kind: 'url' })

    const again = await addLink(db, {
      callerId: owner,
      cardId: created.card.id,
      kind: 'url',
      ref: 'https://example.com/walk',
    })
    expect(again.outcome).toBe('created')
    if (again.outcome !== 'created') return
    expect(again.link.id).toBe(first.link.id)

    const listed = await listLinks(db, owner, created.card.id)
    expect(listed.outcome).toBe('listed')
    if (listed.outcome !== 'listed') return
    expect(listed.items).toHaveLength(1)

    const summaries = await listCards(db, owner, board.id)
    expect(summaries.outcome).toBe('listed')
    if (summaries.outcome !== 'listed') return
    expect(summaries.items[0]?.linkCount).toBe(1)
    expect(summaries.items[0]?.linkCounts.url).toBe(1)
    expect(summaries.items[0]?.linkCounts.account).toBe(0)

    const removed = await removeLink(db, { callerId: owner, linkId: first.link.id })
    expect(removed).toEqual({ outcome: 'removed' })
    expect(await listLinks(db, owner, created.card.id)).toEqual({ outcome: 'empty' })
  })

  it('resolves an account the caller holds and leaves a stranger as unknown', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, { callerId: owner, boardId: board.id, title: 'Mailbox' })
    if (created.outcome !== 'created') throw new Error('card missing')
    const declared = await declareAccount(db, owner, {
      kind: AccountKindSchema.parse('mailbox'),
      identifier: 'owner@example.test',
      provider: 'mail.tm',
    })
    if (declared.outcome !== 'declared') throw new Error(declared.outcome)
    await recordProvedAccount(db, owner, {
      kind: AccountKindSchema.parse('mailbox'),
      identifier: 'owner@example.test',
      capabilities: ['receive'] as unknown as readonly AccountCapability[],
      provedAt: new Date().toISOString(),
    })

    const added = await addLink(db, {
      callerId: owner,
      cardId: created.card.id,
      kind: 'account',
      ref: declared.account.id,
    })
    expect(added.outcome).toBe('created')
    if (added.outcome !== 'created') return
    expect(added.link.target).toEqual({
      state: 'resolved',
      kind: 'account',
      provider: 'mail.tm',
      identifier: 'owner@example.test',
      proved: true,
    })

    expect(await listLinks(db, stranger, created.card.id)).toEqual({ outcome: 'unknown' })
    expect(await getCard(db, stranger, created.card.id)).toBeNull()
  })

  it('refuses an account that is not the board owner’s as unresolvable', async () => {
    const board = await defaultBoard()
    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const created = await createCard(db, { callerId: owner, boardId: board.id, title: 'Foreign' })
    if (created.outcome !== 'created') throw new Error('card missing')
    const foreign = await declareAccount(db, member, {
      kind: AccountKindSchema.parse('mailbox'),
      identifier: 'member@example.test',
      provider: 'mail.tm',
    })
    if (foreign.outcome !== 'declared') throw new Error(foreign.outcome)

    expect(
      await addLink(db, {
        callerId: owner,
        cardId: created.card.id,
        kind: 'account',
        ref: foreign.account.id,
      }),
    ).toEqual({ outcome: 'unresolvable' })
  })

  it('resolves a provider by token, a task and a playbook, and a vault name without the value', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, { callerId: owner, boardId: board.id, title: 'Linked' })
    if (created.outcome !== 'created') throw new Error('card missing')

    await listAtlasProvider(db, {
      kind: AccountKindSchema.parse('mailbox'),
      provider: 'mail.tm',
      title: 'mail.tm',
      category: 'mailbox',
    })
    const [task] = await db
      .insert(tasks)
      .values({
        type: 'email-create',
        title: 'Create an email address',
        description: 'Prove you can operate your own mailbox.',
        instructions: 'Create an address and send a mail to the given recipient.',
        rewardReputation: 5,
        timeoutHours: 24,
        status: 'active',
      })
      .returning({ id: tasks.id, title: tasks.title, status: tasks.status })
    if (task === undefined) throw new Error('task missing')
    const [playbook] = await db
      .insert(playbooks)
      .values({
        slug: 'weekly-inbox',
        authorAgentId: owner,
        title: 'Weekly inbox triage',
        summary: 'Read what nobody has answered and write one reply.',
        steps: [{ title: 'Read the open tickets' }],
        status: 'open',
        publishedAt: '2026-08-01T12:00:00.000Z',
      })
      .returning({ id: playbooks.id })
    if (playbook === undefined) throw new Error('playbook missing')
    const apiKey = keys.get(owner)
    if (apiKey === undefined) throw new Error('owner has no key')
    await setVaultEntry(db, apiKey, owner, 'mail.tm', 'a mailbox password')

    const provider = await addLink(db, {
      callerId: owner,
      cardId: created.card.id,
      kind: 'provider',
      ref: 'mail.tm',
    })
    expect(provider.outcome).toBe('created')
    if (provider.outcome !== 'created') return
    expect(provider.link.target).toEqual({
      state: 'resolved',
      kind: 'provider',
      title: 'mail.tm',
      category: 'mailbox',
    })

    const academy = await addLink(db, {
      callerId: owner,
      cardId: created.card.id,
      kind: 'task',
      ref: task.id,
    })
    expect(academy.outcome).toBe('created')
    if (academy.outcome !== 'created') return
    expect(academy.link.target).toEqual({
      state: 'resolved',
      kind: 'task',
      title: task.title,
      status: task.status,
    })

    const pipeline = await addLink(db, {
      callerId: owner,
      cardId: created.card.id,
      kind: 'playbook',
      ref: playbook.id,
    })
    expect(pipeline.outcome).toBe('created')
    if (pipeline.outcome !== 'created') return
    expect(pipeline.link.target).toMatchObject({
      state: 'resolved',
      kind: 'playbook',
      title: 'Weekly inbox triage',
      status: 'open',
    })

    const vault = await addLink(db, {
      callerId: owner,
      cardId: created.card.id,
      kind: 'vault',
      ref: 'mail.tm',
    })
    expect(vault.outcome).toBe('created')
    if (vault.outcome !== 'created') return
    expect(vault.link.target).toEqual({
      state: 'resolved',
      kind: 'vault',
      name: 'mail.tm',
      held: true,
    })
    expect(JSON.stringify(vault.link)).not.toContain('a mailbox password')

    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const asMember = await listLinks(db, member, created.card.id)
    expect(asMember.outcome).toBe('listed')
    if (asMember.outcome !== 'listed') return
    const vaultForMember = asMember.items.find((one) => one.kind === 'vault')
    expect(vaultForMember?.target).toEqual({
      state: 'resolved',
      kind: 'vault',
      name: 'mail.tm',
      held: false,
    })

    const summaries = await listCards(db, owner, board.id)
    expect(summaries.outcome).toBe('listed')
    if (summaries.outcome !== 'listed') return
    expect(summaries.items[0]?.linkCount).toBe(4)
    expect(summaries.items[0]?.linkCounts).toEqual({
      account: 0,
      provider: 1,
      vault: 1,
      task: 1,
      playbook: 1,
      url: 0,
    })
  })

  it('keeps a dangling pointer as unresolvable on GET and never 422s it', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, { callerId: owner, boardId: board.id, title: 'Dangling' })
    if (created.outcome !== 'created') throw new Error('card missing')
    await db.insert(workplaceCardLinks).values({
      cardId: created.card.id,
      kind: 'account',
      ref: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })

    const listed = await listLinks(db, owner, created.card.id)
    expect(listed.outcome).toBe('listed')
    if (listed.outcome !== 'listed') return
    expect(listed.items[0]?.target).toEqual({ state: 'unresolvable', kind: 'account' })

    const detail = await getCard(db, owner, created.card.id)
    expect(detail?.links[0]?.target).toEqual({ state: 'unresolvable', kind: 'account' })
  })

  it('lets the card owner write a link; a member who does not own the card is forbidden', async () => {
    const board = await defaultBoard()
    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Claimed',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: member,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    expect(claimed.outcome).toBe('claimed')

    const byOwner = await addLink(db, {
      callerId: owner,
      cardId: created.card.id,
      kind: 'url',
      ref: 'https://example.com/owner',
    })
    expect(byOwner.outcome).toBe('created')

    const byCardOwner = await addLink(db, {
      callerId: member,
      cardId: created.card.id,
      kind: 'url',
      ref: 'https://example.com/member',
    })
    expect(byCardOwner.outcome).toBe('created')

    const idle = await citizen('idle')
    await addMember(db, { callerId: owner, boardId: board.id, citizenId: idle })
    expect(
      await addLink(db, {
        callerId: idle,
        cardId: created.card.id,
        kind: 'url',
        ref: 'https://example.com/idle',
      }),
    ).toEqual({ outcome: 'forbidden' })
    if (byCardOwner.outcome !== 'created') return
    expect(await removeLink(db, { callerId: idle, linkId: byCardOwner.link.id })).toEqual({
      outcome: 'forbidden',
    })
    expect(await removeLink(db, { callerId: stranger, linkId: byCardOwner.link.id })).toEqual({
      outcome: 'missing',
    })
  })

  it('answers missing for a vault the board owner does not hold', async () => {
    const board = await defaultBoard()
    const created = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Empty vault',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    expect(
      await addLink(db, {
        callerId: owner,
        cardId: created.card.id,
        kind: 'vault',
        ref: 'mail.tm',
      }),
    ).toEqual({ outcome: 'unresolvable' })
  })
})

describe('workplace wakeup recommendation', () => {
  let db: Database
  let citizenId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    const registered = await registerAgent(db, {
      name: 'wakeup-citizen',
      platform: 'openclaw',
      operator: null,
    })
    if (registered.outcome !== 'registered') throw new Error('citizen missing')
    citizenId = registered.agent.id
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, citizenId))
  })

  it('scopes focused Initiative wakeup to eligible child Actions', async () => {
    const board = await createDefaultBoard(db, { callerId: citizenId, title: 'Default board' })
    const initiative = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Focused initiative',
      kind: 'initiative',
      status: 'ready',
    })
    const child =
      initiative.outcome === 'created'
        ? await createCard(db, {
            callerId: citizenId,
            boardId: board.id,
            title: 'Focused child',
            parentInitiativeId: initiative.card.id,
            status: 'ready',
          })
        : undefined
    const unrelated = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Unrelated action',
      status: 'ready',
    })
    if (
      initiative.outcome !== 'created' ||
      child?.outcome !== 'created' ||
      unrelated.outcome !== 'created'
    ) {
      throw new Error('card missing')
    }
    await setCommitment(db, {
      callerId: citizenId,
      outcome: 'Reach the focused outcome.',
      nextAction: 'Continue inside the initiative.',
      reviewAt: '2026-09-14T00:00:00.000Z',
      state: 'active',
      focusCardId: initiative.card.id,
    })

    await db
      .update(workplaceCards)
      .set({ createdAt: '2026-09-13T10:00:00.000Z', position: 2000 })
      .where(eq(workplaceCards.id, child.card.id))
    const earlier = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Earlier position, later creation',
      parentInitiativeId: initiative.card.id,
      status: 'ready',
    })
    if (earlier.outcome !== 'created') throw new Error('earlier child missing')
    await db
      .update(workplaceCards)
      .set({ createdAt: '2026-09-13T10:00:00.000Z', position: 500 })
      .where(eq(workplaceCards.id, earlier.card.id))

    const result = await workplaceWakeup(db, citizenId)

    expect(result).toMatchObject({
      focusCardId: initiative.card.id,
      focusKind: 'initiative',
      recommendation: { cardId: earlier.card.id },
    })
    expect(result?.more.some((card) => card.cardId === unrelated.card.id)).toBe(false)
  })

  it('recommends a focused blocked Action as a decision surface before unrelated work', async () => {
    const board = await createDefaultBoard(db, { callerId: citizenId, title: 'Default board' })
    const focused = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Blocked focus',
      status: 'ready',
    })
    const unrelated = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Unrelated ready action',
      status: 'ready',
    })
    if (focused.outcome !== 'created' || unrelated.outcome !== 'created')
      throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: citizenId,
      cardId: focused.card.id,
      expectedVersion: focused.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    const blocked = await blockCard(db, {
      callerId: citizenId,
      cardId: focused.card.id,
      expectedVersion: claimed.card.version,
      blockedBy: 'Waiting for a result.',
      unblockWhen: 'The result arrives.',
    })
    if (blocked.outcome !== 'blocked') throw new Error('block failed')
    await setCommitment(db, {
      callerId: citizenId,
      outcome: 'Resolve the blocker.',
      nextAction: 'Decide what to do next.',
      reviewAt: '2026-09-14T00:00:00.000Z',
      state: 'waiting',
      blocker: 'Waiting for a result.',
      focusCardId: focused.card.id,
    })

    const result = await workplaceWakeup(db, citizenId)

    expect(result?.recommendation).toMatchObject({
      cardId: focused.card.id,
      status: 'blocked',
      next: {
        tool: 'kolonie.workplace',
        arguments: {
          act: 'update',
          subject: 'card',
          id: focused.card.id,
          boardId: board.id,
          expectedVersion: blocked.card.version,
          fields: { status: 'in_progress' },
        },
      },
    })
    expect(result?.more).toEqual([])
  })

  it('returns executable choices instead of unrelated work for an empty focused Initiative', async () => {
    const board = await createDefaultBoard(db, { callerId: citizenId, title: 'Default board' })
    const initiative = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Empty focus',
      kind: 'initiative',
      status: 'ready',
    })
    await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Unrelated action',
      status: 'ready',
    })
    if (initiative.outcome !== 'created') throw new Error('initiative missing')
    const set = await setCommitment(db, {
      callerId: citizenId,
      outcome: 'Reach the focused outcome.',
      nextAction: 'Choose the next child Action.',
      reviewAt: '2026-09-14T00:00:00.000Z',
      state: 'active',
      focusCardId: initiative.card.id,
    })
    if (set.outcome !== 'set') throw new Error('commitment missing')

    const result = await workplaceWakeup(db, citizenId)

    expect(result?.recommendation).toBeNull()
    expect(result?.more).toEqual([])
    expect(result?.commitmentDecision?.choices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          arguments: expect.objectContaining({
            act: 'get',
            subject: 'card',
            id: initiative.card.id,
          }),
        }),
        expect.objectContaining({
          arguments: expect.objectContaining({
            act: 'create',
            subject: 'card',
            boardId: board.id,
            fields: {
              kind: 'action',
              parentInitiativeId: initiative.card.id,
            },
          }),
        }),
        expect.objectContaining({
          arguments: expect.objectContaining({
            act: 'advance',
            subject: 'commitment',
            expectedVersion: set.commitment.version,
            fields: {
              nextAction: set.commitment.nextAction,
              state: set.commitment.state,
              focusCardId: null,
            },
          }),
        }),
      ]),
    )
  })

  it.each(['active', 'waiting'] as const)(
    'returns a decision for a focused Done Action on a %s commitment',
    async (state) => {
      const board = await createDefaultBoard(db, { callerId: citizenId, title: 'Default board' })
      const focused = await createCard(db, {
        callerId: citizenId,
        boardId: board.id,
        title: 'Focused Action',
        status: 'ready',
      })
      if (focused.outcome !== 'created') throw new Error('focus missing')
      const claimed = await claimCard(db, {
        callerId: citizenId,
        cardId: focused.card.id,
        expectedVersion: focused.card.version,
      })
      if (claimed.outcome !== 'claimed') throw new Error('claim failed')
      const completed = await completeCard(db, {
        callerId: citizenId,
        cardId: focused.card.id,
        expectedVersion: claimed.card.version,
        outcome: 'The focused Action finished.',
      })
      if (completed.outcome !== 'completed') throw new Error('completion failed')
      await createCard(db, {
        callerId: citizenId,
        boardId: board.id,
        title: 'Unrelated ready Action',
        status: 'ready',
      })
      await setCommitment(db, {
        callerId: citizenId,
        outcome: 'Finish the focused result.',
        nextAction: 'Choose what follows.',
        reviewAt: '2026-09-14T00:00:00.000Z',
        state,
        ...(state === 'waiting' ? { blocker: 'A decision is pending.' } : {}),
        focusCardId: completed.card.id,
      })

      const result = await workplaceWakeup(db, citizenId)

      expect(result).toMatchObject({
        focusCardId: completed.card.id,
        focusKind: 'action',
        recommendation: null,
        more: [],
      })
      expect(result?.commitmentDecision?.choices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            arguments: { act: 'get', subject: 'card', id: completed.card.id, boardId: board.id },
          }),
          expect.objectContaining({
            arguments: {
              act: 'update',
              subject: 'card',
              id: completed.card.id,
              boardId: board.id,
              expectedVersion: completed.card.version,
            },
          }),
          expect.objectContaining({ arguments: { act: 'end', subject: 'commitment' } }),
        ]),
      )
    },
  )

  it('keeps ordinary ranking after the focused commitment ends', async () => {
    const board = await createDefaultBoard(db, { callerId: citizenId, title: 'Default board' })
    const focus = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Focused ready',
      status: 'ready',
    })
    const live = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Ordinary live work',
      status: 'ready',
    })
    if (focus.outcome !== 'created' || live.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: citizenId,
      cardId: live.card.id,
      expectedVersion: live.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    await setCommitment(db, {
      callerId: citizenId,
      outcome: 'Focus elsewhere.',
      nextAction: 'Read the focus.',
      reviewAt: '2026-09-14T00:00:00.000Z',
      state: 'active',
      focusCardId: focus.card.id,
    })
    expect((await workplaceWakeup(db, citizenId))?.recommendation?.cardId).toBe(focus.card.id)

    await endCommitment(db, { callerId: citizenId })

    expect((await workplaceWakeup(db, citizenId))?.recommendation?.cardId).toBe(live.card.id)
    expect((await getCard(db, citizenId, focus.card.id))?.card.archivedAt).toBeNull()
  })

  it('keeps default seed-card wakeup discovery and ranks an accepted practicum first', async () => {
    const boards = await listBoardsFor(db, citizenId)
    if (boards.outcome !== 'listed') throw new Error('default board missing')
    const defaultBoard = boards.items.find((board) => board.kind === 'default')
    if (defaultBoard === undefined) throw new Error('default board missing')

    const before = await workplaceWakeup(db, citizenId)
    expect(before?.boardId).toBe(defaultBoard.id)
    expect(before?.practicumActive).toBe(false)
    expect(before?.recommendation).toMatchObject({
      title: 'Sharpen profession and mission',
      status: 'inbox',
    })

    const started = await startProfessionPracticum(db, {
      callerId: citizenId,
      outcome: 'Deliver one runnable status page.',
    })
    if (started.outcome !== 'started') throw new Error('cycle missing')

    const result = await workplaceWakeup(db, citizenId)

    expect(result?.boardId).toBe(started.cycle.boardId)
    expect(result?.practicumActive).toBe(true)
    expect(result?.recommendation).toMatchObject({
      cardId: started.cycle.cards[0]?.id,
      title: 'Understand one user and problem',
      status: 'inbox',
    })
    expect(result?.more).toEqual([])
  })

  it('excludes Initiatives and returns parent metadata for a child Action', async () => {
    const board = await createDefaultBoard(db, { callerId: citizenId, title: 'Default board' })
    const initiative = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Reach the outcome',
      kind: 'initiative',
      status: 'ready',
    })
    if (initiative.outcome !== 'created') throw new Error('initiative missing')
    const action = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Ship the next artifact',
      parentInitiativeId: initiative.card.id,
      status: 'ready',
    })
    if (action.outcome !== 'created') throw new Error('action missing')

    const result = await workplaceWakeup(db, citizenId)
    if (result === undefined || result.cardSignals === undefined) {
      throw new Error('wakeup workplace missing')
    }

    expect(result.recommendation).toMatchObject({
      cardId: action.card.id,
      parentInitiative: { id: initiative.card.id, title: 'Reach the outcome' },
    })
    expect(result.cardSignals.some((signal) => signal.cardId === initiative.card.id)).toBe(false)
  })

  it('ranks owned in-progress above ready and returns a ready-to-send get call', async () => {
    const board = await createDefaultBoard(db, { callerId: citizenId, title: 'Default board' })
    const ready = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Old ready',
      status: 'ready',
    })
    const live = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Live work',
      status: 'ready',
    })
    if (ready.outcome !== 'created' || live.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: citizenId,
      cardId: live.card.id,
      expectedVersion: live.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')

    expect(await workplaceWakeup(db, citizenId)).toEqual({
      boardId: board.id,
      practicumActive: false,
      recommendation: {
        cardId: live.card.id,
        title: 'Live work',
        status: 'in_progress',
        revision: claimed.card.version,
        parentInitiative: null,
        next: {
          tool: 'kolonie.workplace',
          arguments: { act: 'get', subject: 'card', id: live.card.id },
        },
      },
      more: [{ cardId: ready.card.id, status: 'ready', revision: ready.card.version }],
      cardSignals: [
        { cardId: live.card.id, status: 'in_progress', revision: claimed.card.version },
        { cardId: ready.card.id, status: 'ready', revision: ready.card.version },
      ],
      followUp: {
        changedCardIds: [live.card.id, ready.card.id],
        readsAdvised: true,
      },
    })
  })

  it('returns identical revision and status signals across unchanged wakeups', async () => {
    const board = await createDefaultBoard(db, { callerId: citizenId, title: 'Default board' })
    const ready = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Ready work',
      status: 'ready',
    })
    if (ready.outcome !== 'created') throw new Error('card missing')
    const since = new Date(Date.now() + 60_000).toISOString()

    const first = await workplaceWakeup(db, citizenId, since)
    const second = await workplaceWakeup(db, citizenId, since)

    expect(second?.cardSignals).toEqual(first?.cardSignals)
    expect(second?.followUp).toEqual({ changedCardIds: [], readsAdvised: false })
    expect(second?.recommendation).toMatchObject({
      cardId: ready.card.id,
      status: 'ready',
      revision: ready.card.version,
    })
  })

  it('changes the signal and names only the mutated card for a follow-up read', async () => {
    const board = await createDefaultBoard(db, { callerId: citizenId, title: 'Default board' })
    const changed = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Change me',
      status: 'ready',
    })
    const unchanged = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Leave me',
      status: 'ready',
    })
    if (changed.outcome !== 'created' || unchanged.outcome !== 'created') {
      throw new Error('card missing')
    }
    const before = await workplaceWakeup(db, citizenId)
    const window = new Date().toISOString()
    const rewritten = await updateCard(db, {
      callerId: citizenId,
      cardId: changed.card.id,
      expectedVersion: changed.card.version,
      title: 'Changed',
    })
    if (rewritten.outcome !== 'updated') throw new Error('update failed')

    const after = await workplaceWakeup(db, citizenId, window)

    expect(after?.cardSignals).not.toEqual(before?.cardSignals)
    expect(after?.cardSignals).toContainEqual({
      cardId: changed.card.id,
      status: 'ready',
      revision: rewritten.card.version,
    })
    expect(after?.cardSignals).toContainEqual({
      cardId: unchanged.card.id,
      status: 'ready',
      revision: unchanged.card.version,
    })
    expect(after?.followUp).toEqual({
      changedCardIds: [changed.card.id],
      readsAdvised: true,
    })
  })

  it('detects a practicum independently of the bounded recommendation ranking', async () => {
    const board = await createDefaultBoard(db, { callerId: citizenId, title: 'Default board' })
    const started = await startProfessionPracticum(db, {
      callerId: citizenId,
      outcome: 'Deliver one runnable status page.',
    })
    if (started.outcome !== 'started') throw new Error('cycle missing')
    for (let index = 0; index < 6; index += 1) {
      await createCard(db, {
        callerId: citizenId,
        boardId: board.id,
        title: `Ready ${index}`,
        status: 'ready',
      })
    }

    const result = await workplaceWakeup(db, citizenId)

    expect(result?.recommendation?.title).toBe('Ready 0')
    expect(result?.practicumActive).toBe(true)
  })

  it('limits more to four eligible child Actions inside a focused Initiative', async () => {
    const board = await createDefaultBoard(db, { callerId: citizenId, title: 'Default board' })
    const initiative = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Broad focus',
      kind: 'initiative',
      status: 'ready',
    })
    if (initiative.outcome !== 'created') throw new Error('initiative missing')
    const children: Array<{ id: string; createdAt: string; position: number }> = []
    for (let index = 0; index < 7; index += 1) {
      const child = await createCard(db, {
        callerId: citizenId,
        boardId: board.id,
        title: `Focused child ${index}`,
        kind: 'action',
        parentInitiativeId: initiative.card.id,
        status: 'ready',
      })
      if (child.outcome !== 'created') throw new Error('child missing')
      children.push({
        id: child.card.id,
        createdAt: child.card.createdAt,
        position: child.card.position,
      })
    }
    await setCommitment(db, {
      callerId: citizenId,
      outcome: 'Finish the initiative.',
      nextAction: 'Continue with one child.',
      reviewAt: '2026-09-14T00:00:00.000Z',
      state: 'active',
      focusCardId: initiative.card.id,
    })

    const result = await workplaceWakeup(db, citizenId)

    expect(result?.more).toHaveLength(4)
    const expected = [...children]
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.position - right.position ||
          left.id.localeCompare(right.id),
      )
      .slice(0, 5)
      .map((one) => one.id)
    expect([
      result?.recommendation?.cardId,
      ...(result?.more.map((one) => one.cardId) ?? []),
    ]).toEqual(expected)
  })

  it('bounds fifty ready cards to one recommendation and four ids', async () => {
    const board = await createDefaultBoard(db, { callerId: citizenId, title: 'Default board' })
    for (let index = 0; index < 50; index += 1) {
      await createCard(db, {
        callerId: citizenId,
        boardId: board.id,
        title: `Ready ${index}`,
        status: 'ready',
      })
    }

    const result = await workplaceWakeup(db, citizenId)
    expect(result?.recommendation?.title).toBe('Ready 0')
    expect(result?.more).toHaveLength(4)
  })

  it('omits candidates even if a default board exists', async () => {
    const board = await createDefaultBoard(db, { callerId: citizenId, title: 'Default board' })
    await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Ready',
      status: 'ready',
    })
    await db.update(agents).set({ status: 'candidate' }).where(eq(agents.id, citizenId))

    expect(await workplaceWakeup(db, citizenId)).toBeUndefined()
  })
})

describe('materialiseDue', () => {
  let db: Database
  let owner: AgentId
  const keys = new Map<AgentId, string>()

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    owner = await citizen('owner')
  })

  const citizen = async (name: string): Promise<AgentId> => {
    const registered = await registerAgent(db, {
      name,
      platform: 'openclaw',
      operator: null,
    })
    if (registered.outcome !== 'registered') throw new Error(`could not register ${name}`)
    keys.set(registered.agent.id, String(registered.credentials.apiKey))
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, registered.agent.id))
    return registered.agent.id
  }

  const plantRule = async (input: {
    readonly boardId: string
    readonly cardId: string
    readonly cadence?: 'weekly' | 'daily'
    readonly nextDueAt?: string
  }) => {
    const [rule] = await db
      .insert(workplaceRecurrenceRules)
      .values({
        boardId: input.boardId,
        cardId: input.cardId,
        cadence: input.cadence ?? 'weekly',
        nextDueAt: input.nextDueAt ?? '2026-08-24T00:00:00.000Z',
      })
      .returning()
    if (rule === undefined) throw new Error('rule missing')
    return rule
  }

  const occurrenceCards = async (
    citizenId: AgentId,
    boardId: string,
    title: string,
    templateId: string,
  ) => {
    const listed = await listCards(db, citizenId, boardId)
    if (listed.outcome !== 'listed' && listed.outcome !== 'empty') {
      throw new Error(`could not list cards: ${listed.outcome}`)
    }
    const items = listed.outcome === 'listed' ? listed.items : []
    return items.filter((one) => one.title === title && one.id !== templateId)
  }

  it('creates one ownerless inbox card for two ticks in the same period', async () => {
    const board = await createDefaultBoard(db, { callerId: owner, title: 'Default board' })
    const template = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Review and improve the profession',
    })
    if (template.outcome !== 'created') throw new Error('template missing')
    await plantRule({ boardId: board.id, cardId: template.card.id })

    const first = await materialiseDue(db, owner, '2026-08-30T15:04:05.000Z')
    const second = await materialiseDue(db, owner, '2026-08-30T22:00:00.000Z')
    expect(first.created).toBe(1)
    expect(second.created).toBe(0)

    const copies = await occurrenceCards(
      owner,
      board.id,
      'Review and improve the profession',
      template.card.id,
    )
    expect(copies).toHaveLength(1)
    expect(copies[0]?.status).toBe('inbox')
    expect(copies[0]?.ownerId).toBeNull()
    expect(copies[0]?.title).toBe('Review and improve the profession')
    expect(copies[0]?.title).not.toMatch(/\d{4}/)

    const rows = await db.select().from(workplaceRecurrenceOccurrences)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cardId).toBe(copies[0]?.id)
    expect(toTimestamp(rows[0]!.periodStart)).toBe('2026-08-24T00:00:00.000Z')
  })

  it('skips a new period while the previous occurrence is unfinished and records it', async () => {
    const board = await createDefaultBoard(db, { callerId: owner, title: 'Default board' })
    const template = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Weekly review',
    })
    if (template.outcome !== 'created') throw new Error('template missing')
    await plantRule({ boardId: board.id, cardId: template.card.id })

    await materialiseDue(db, owner, '2026-08-30T12:00:00.000Z')
    const skipped = await materialiseDue(db, owner, '2026-09-07T12:00:00.000Z')
    expect(skipped.created).toBe(0)
    expect(skipped.skipped).toBe(1)

    const copies = await occurrenceCards(owner, board.id, 'Weekly review', template.card.id)
    expect(copies).toHaveLength(1)

    const rows = await db
      .select()
      .from(workplaceRecurrenceOccurrences)
      .orderBy(workplaceRecurrenceOccurrences.periodStart)
    expect(rows).toHaveLength(2)
    expect(toTimestamp(rows[1]!.periodStart)).toBe('2026-09-07T00:00:00.000Z')
    expect(rows[1]?.cardId).toBeNull()

    const activity = await db
      .select()
      .from(workplaceActivity)
      .where(eq(workplaceActivity.verb, 'recurrence.skipped'))
    expect(activity).toHaveLength(1)
    expect(activity[0]?.verb).toBe('recurrence.skipped')
    expect(activity[0]?.actorId).toBeNull()
    expect(activity[0]?.actorKind).toBe('system')
    expect(activity[0]?.boardId).toBe(board.id)
  })

  it('creates the next period after the previous occurrence is completed', async () => {
    const board = await createDefaultBoard(db, { callerId: owner, title: 'Default board' })
    const template = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Weekly review',
      status: 'ready',
    })
    if (template.outcome !== 'created') throw new Error('template missing')
    await plantRule({ boardId: board.id, cardId: template.card.id })

    await materialiseDue(db, owner, '2026-08-30T12:00:00.000Z')
    const copies = await occurrenceCards(owner, board.id, 'Weekly review', template.card.id)
    const open = copies[0]
    if (open === undefined) throw new Error('occurrence missing')
    const ready = await moveCard(db, {
      callerId: owner,
      cardId: open.id,
      expectedVersion: open.version,
      status: 'ready',
    })
    if (ready.outcome !== 'moved') throw new Error('could not ready')
    const claimed = await claimCard(db, {
      callerId: owner,
      cardId: ready.card.id,
      expectedVersion: ready.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    const done = await completeCard(db, {
      callerId: owner,
      cardId: claimed.card.id,
      expectedVersion: claimed.card.version,
      outcome: 'The week is filed.',
    })
    expect(done.outcome).toBe('completed')

    const next = await materialiseDue(db, owner, '2026-09-07T12:00:00.000Z')
    expect(next.created).toBe(1)
    expect(await occurrenceCards(owner, board.id, 'Weekly review', template.card.id)).toHaveLength(
      2,
    )
  })

  it('copies labels, unchecked checklists and typed links without decrypting a vault value', async () => {
    const board = await createDefaultBoard(db, { callerId: owner, title: 'Default board' })
    const template = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Walk the provider',
    })
    if (template.outcome !== 'created') throw new Error('template missing')
    const [label] = await db
      .insert(workplaceLabels)
      .values({ boardId: board.id, slug: 'growth', name: 'growth', colour: '#336699' })
      .returning()
    if (label === undefined) throw new Error('label missing')
    await attachLabel(db, { callerId: owner, cardId: template.card.id, labelId: label.id })
    const listed = await createChecklist(db, {
      callerId: owner,
      cardId: template.card.id,
      title: 'Prove it',
    })
    if (listed.outcome !== 'created') throw new Error('checklist missing')
    const item = await createChecklistItem(db, {
      callerId: owner,
      checklistId: listed.checklist.id,
      title: 'Mint the challenge',
    })
    if (item.outcome !== 'created') throw new Error('item missing')
    await db
      .update(workplaceChecklistItems)
      .set({ doneAt: '2026-08-29T12:00:00.000Z' })
      .where(eq(workplaceChecklistItems.id, item.item.id))

    const apiKey = keys.get(owner)
    if (apiKey === undefined) throw new Error('owner has no key')
    await setVaultEntry(db, apiKey, owner, 'mail.tm', 'a mailbox password')
    const vault = await addLink(db, {
      callerId: owner,
      cardId: template.card.id,
      kind: 'vault',
      ref: 'mail.tm',
    })
    expect(vault.outcome).toBe('created')
    await addLink(db, {
      callerId: owner,
      cardId: template.card.id,
      kind: 'url',
      ref: 'https://example.com/walk',
    })
    await plantRule({ boardId: board.id, cardId: template.card.id, cadence: 'daily' })

    const decrypt = vi.spyOn(vaultStorage, 'getVaultEntry')
    await materialiseDue(db, owner, '2026-08-30T15:04:05.000Z')
    expect(decrypt).not.toHaveBeenCalled()
    decrypt.mockRestore()

    const copies = await occurrenceCards(owner, board.id, 'Walk the provider', template.card.id)
    expect(copies).toHaveLength(1)
    const copyId = copies[0]?.id
    if (copyId === undefined) throw new Error('copy missing')
    const detail = await getCard(db, owner, copyId)
    expect(detail?.labels.map((one) => one.name)).toEqual(['growth'])
    expect(detail?.checklists[0]?.checklist.title).toBe('Prove it')
    expect(detail?.checklists[0]?.items[0]?.title).toBe('Mint the challenge')
    expect(detail?.checklists[0]?.items[0]?.doneAt).toBeNull()
    expect(detail?.links.map((one) => one.kind).sort()).toEqual(['url', 'vault'])
    const vaultLink = detail?.links.find((one) => one.kind === 'vault')
    expect(vaultLink?.ref).toBe('mail.tm')
    expect(JSON.stringify(detail)).not.toContain('a mailbox password')
  })

  it('does not fire for a candidate, a suspended agent, a banned agent or an archived board', async () => {
    const candidate = await registerAgent(db, {
      name: 'candidate',
      platform: 'openclaw',
      operator: null,
    })
    if (candidate.outcome !== 'registered') throw new Error('candidate missing')
    const candidateBoard = await createDefaultBoard(db, {
      callerId: candidate.agent.id,
      title: 'Candidate board',
    })
    const candidateCard = await createCard(db, {
      callerId: candidate.agent.id,
      boardId: candidateBoard.id,
      title: 'Candidate review',
    })
    if (candidateCard.outcome !== 'created') throw new Error('candidate card missing')
    await plantRule({ boardId: candidateBoard.id, cardId: candidateCard.card.id })
    expect(await materialiseDue(db, candidate.agent.id, '2026-08-30T12:00:00.000Z')).toEqual({
      created: 0,
      skipped: 0,
    })

    const suspended = await citizen('suspended')
    await db.update(agents).set({ status: 'suspended' }).where(eq(agents.id, suspended))
    const suspendedBoard = await createDefaultBoard(db, {
      callerId: suspended,
      title: 'Suspended board',
    })
    const suspendedCard = await createCard(db, {
      callerId: suspended,
      boardId: suspendedBoard.id,
      title: 'Suspended review',
    })
    if (suspendedCard.outcome !== 'created') throw new Error('suspended card missing')
    await plantRule({ boardId: suspendedBoard.id, cardId: suspendedCard.card.id })
    expect(await materialiseDue(db, suspended, '2026-08-30T12:00:00.000Z')).toEqual({
      created: 0,
      skipped: 0,
    })

    const banned = await citizen('banned')
    await db.update(agents).set({ status: 'banned' }).where(eq(agents.id, banned))
    const bannedBoard = await createDefaultBoard(db, { callerId: banned, title: 'Banned board' })
    const bannedCard = await createCard(db, {
      callerId: banned,
      boardId: bannedBoard.id,
      title: 'Banned review',
    })
    if (bannedCard.outcome !== 'created') throw new Error('banned card missing')
    await plantRule({ boardId: bannedBoard.id, cardId: bannedCard.card.id })
    expect(await materialiseDue(db, banned, '2026-08-30T12:00:00.000Z')).toEqual({
      created: 0,
      skipped: 0,
    })

    const extra = await createBoard(db, { callerId: owner, title: 'Extra' })
    const extraCard = await createCard(db, {
      callerId: owner,
      boardId: extra.id,
      title: 'Archived review',
    })
    if (extraCard.outcome !== 'created') throw new Error('extra card missing')
    await plantRule({ boardId: extra.id, cardId: extraCard.card.id })
    await archiveBoard(db, { callerId: owner, boardId: extra.id, expectedVersion: extra.version })
    expect(await materialiseDue(db, owner, '2026-08-30T12:00:00.000Z')).toEqual({
      created: 0,
      skipped: 0,
    })
    expect(await db.select().from(workplaceRecurrenceOccurrences)).toEqual([])
  })
})

describe('self-authored commitment storage', () => {
  let db: Database
  let owner: AgentId
  let member: AgentId
  let stranger: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    owner = await citizen('owner')
    member = await citizen('member')
    stranger = await citizen('stranger')
    await db
      .update(agents)
      .set({ status: 'citizen' })
      .where(inArray(agents.id, [owner, member, stranger]))
  })

  const citizen = async (name: string): Promise<AgentId> => {
    const registered = await registerAgent(db, { name, platform: 'openclaw', operator: null })
    if (registered.outcome !== 'registered') throw new Error(`could not register ${name}`)
    return registered.agent.id
  }

  const first = {
    outcome: 'Publish a reliable migration guide.',
    nextAction: 'Exercise the guide against a disposable database.',
    reviewAt: '2026-09-06T12:00:00.000Z',
    state: 'active' as const,
  }

  it('refuses a candidate at the storage boundary', async () => {
    await db.update(agents).set({ status: 'candidate' }).where(eq(agents.id, owner))
    const refused = await setCommitment(db, { callerId: owner, ...first })
    expect(refused.outcome).toBe('citizen-required')
    expect(await readCommitment(db, owner)).toBeNull()
  })

  it('sets, replaces, preserves and clears a focus on the citizen default board', async () => {
    const board = await createDefaultBoard(db, { callerId: owner, title: 'Default board' })
    const firstFocus = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'First focus',
      status: 'ready',
    })
    const secondFocus = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Second focus',
      status: 'ready',
    })
    if (firstFocus.outcome !== 'created' || secondFocus.outcome !== 'created') {
      throw new Error('focus card missing')
    }

    const set = await setCommitment(db, {
      callerId: owner,
      ...first,
      focusCardId: firstFocus.card.id,
    })
    expect(set.outcome).toBe('set')
    if (set.outcome !== 'set') return
    expect(set.commitment.focusCardId).toBe(firstFocus.card.id)

    const preservedSet = await setCommitment(db, {
      callerId: owner,
      ...first,
      expectedVersion: set.commitment.version,
    })
    expect(preservedSet.outcome).toBe('set')
    if (preservedSet.outcome !== 'set') return
    expect(preservedSet.commitment.focusCardId).toBe(firstFocus.card.id)

    const replaced = await setCommitment(db, {
      callerId: owner,
      ...first,
      expectedVersion: preservedSet.commitment.version,
      focusCardId: secondFocus.card.id,
    })
    expect(replaced.outcome).toBe('set')
    if (replaced.outcome !== 'set') return
    expect(replaced.commitment.focusCardId).toBe(secondFocus.card.id)

    const preserved = await advanceCommitment(db, {
      callerId: owner,
      expectedVersion: replaced.commitment.version,
      nextAction: 'Keep moving.',
      state: 'active',
    })
    expect(preserved.outcome).toBe('advanced')
    if (preserved.outcome !== 'advanced') return
    expect(preserved.commitment.focusCardId).toBe(secondFocus.card.id)

    const cleared = await advanceCommitment(db, {
      callerId: owner,
      expectedVersion: preserved.commitment.version,
      nextAction: 'Choose later.',
      state: 'active',
      focusCardId: null,
    })
    expect(cleared.outcome).toBe('advanced')
    if (cleared.outcome !== 'advanced') return
    expect(cleared.commitment.focusCardId).toBeNull()
  })

  it('hides unknown, archived, shared-board and unreadable focus cards behind one miss', async () => {
    const own = await createDefaultBoard(db, { callerId: owner, title: 'Default board' })
    const archived = await createCard(db, {
      callerId: owner,
      boardId: own.id,
      title: 'Archived focus',
    })
    if (archived.outcome !== 'created') throw new Error('focus card missing')
    await archiveCard(db, {
      callerId: owner,
      cardId: archived.card.id,
      expectedVersion: archived.card.version,
    })
    const shared = await createDefaultBoard(db, { callerId: member, title: 'Member default' })
    await addMember(db, { callerId: member, boardId: shared.id, citizenId: owner })
    const sharedCard = await createCard(db, {
      callerId: member,
      boardId: shared.id,
      title: 'Shared focus',
    })
    if (sharedCard.outcome !== 'created') throw new Error('shared focus missing')

    for (const focusCardId of [
      '00000000-0000-4000-8000-000000000000',
      archived.card.id,
      sharedCard.card.id,
    ]) {
      expect(await setCommitment(db, { callerId: owner, ...first, focusCardId })).toEqual({
        outcome: 'missing',
      })
    }
  })

  it('sets, reads back, advances and ends exactly one commitment', async () => {
    const set = await setCommitment(db, { callerId: owner, ...first })
    expect(set.outcome).toBe('set')
    if (set.outcome !== 'set') return
    expect(set.commitment).toMatchObject({ ...first, version: 1 })

    expect(await readCommitment(db, owner)).toMatchObject({ ...first, version: 1 })

    const advanced = await advanceCommitment(db, {
      callerId: owner,
      expectedVersion: set.commitment.version,
      nextAction: 'Write the rollback section.',
      state: 'active',
    })
    expect(advanced.outcome).toBe('advanced')
    if (advanced.outcome !== 'advanced') return
    expect(advanced.commitment.outcome).toBe(first.outcome)
    expect(advanced.commitment.nextAction).toBe('Write the rollback section.')
    expect(advanced.commitment.version).toBe(2)

    expect(await endCommitment(db, { callerId: owner })).toEqual({ outcome: 'ended' })
    expect(await readCommitment(db, owner)).toBeNull()
  })

  it('refuses a replacement whose expectedVersion is stale and supersedes with the right one', async () => {
    const set = await setCommitment(db, { callerId: owner, ...first })
    if (set.outcome !== 'set') throw new Error('commitment missing')

    const stale = await setCommitment(db, {
      callerId: owner,
      ...first,
      outcome: 'A different outcome.',
      expectedVersion: 99,
    })
    expect(stale.outcome).toBe('stale')

    const missing = await setCommitment(db, {
      callerId: owner,
      ...first,
      outcome: 'A different outcome.',
    })
    expect(missing.outcome).toBe('stale')

    const superseded = await setCommitment(db, {
      callerId: owner,
      ...first,
      outcome: 'A different outcome.',
      expectedVersion: set.commitment.version,
    })
    expect(superseded.outcome).toBe('set')
    if (superseded.outcome !== 'set') return
    expect(superseded.commitment.outcome).toBe('A different outcome.')
    expect(
      await db.select().from(workplaceCommitments).where(eq(workplaceCommitments.agentId, owner)),
    ).toHaveLength(1)
  })

  it('converges two concurrent first writes on one row', async () => {
    const attempts = await Promise.allSettled([
      setCommitment(db, { callerId: owner, ...first, outcome: 'Race one.' }),
      setCommitment(db, { callerId: owner, ...first, outcome: 'Race two.' }),
    ])
    const settled = attempts.filter(
      (attempt) => attempt.status === 'fulfilled' && attempt.value.outcome === 'set',
    )
    expect(settled.length).toBeGreaterThanOrEqual(1)
    expect(
      await db.select().from(workplaceCommitments).where(eq(workplaceCommitments.agentId, owner)),
    ).toHaveLength(1)
  })

  it('keeps waiting explained and refuses an unexplained wait', async () => {
    const set = await setCommitment(db, {
      callerId: owner,
      ...first,
      state: 'waiting',
      blocker: 'Waiting on the operator to open a disposable database.',
    })
    expect(set.outcome).toBe('set')
    if (set.outcome !== 'set') return
    expect(set.commitment.blocker).toBe('Waiting on the operator to open a disposable database.')
    await expectRejection(
      () =>
        db.insert(workplaceCommitments).values({
          agentId: stranger,
          outcome: first.outcome,
          nextAction: first.nextAction,
          reviewAt: first.reviewAt,
          state: 'waiting',
        }),
      /workplace_commitments_waiting_is_explained/,
    )
  })

  it('cannot advance or end what is not there, and ending twice is not an error', async () => {
    const advanced = await advanceCommitment(db, {
      callerId: owner,
      expectedVersion: 1,
      nextAction: 'Resurrect the ended commitment.',
      state: 'active',
    })
    expect(advanced.outcome).toBe('missing')

    await setCommitment(db, { callerId: owner, ...first })
    expect(await endCommitment(db, { callerId: owner })).toEqual({ outcome: 'ended' })
    expect(await endCommitment(db, { callerId: owner })).toEqual({ outcome: 'ended' })
    expect(await db.select().from(workplaceCommitments)).toHaveLength(0)
  })

  it('provisions no board, creates no card and writes no activity', async () => {
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, owner))
    await setCommitment(db, { callerId: owner, ...first })

    expect(await db.select().from(workplaceBoards)).toEqual([])
    expect(await db.select().from(workplaceCards)).toEqual([])
    expect(await db.select().from(workplaceActivity)).toEqual([])
    expect(await db.select().from(workplacePracticumEvents)).toEqual([])
    expect(await workplaceWakeup(db, owner)).toBeUndefined()
  })

  it('clears an archived focus transactionally and reports focusLost once without title leakage', async () => {
    const board = await createDefaultBoard(db, { callerId: owner, title: 'Default board' })
    const focus = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Former private focus title',
    })
    if (focus.outcome !== 'created') throw new Error('focus card missing')
    await setCommitment(db, { callerId: owner, ...first, focusCardId: focus.card.id })

    const archived = await archiveCard(db, {
      callerId: owner,
      cardId: focus.card.id,
      expectedVersion: focus.card.version,
    })
    expect(archived.outcome).toBe('archived')
    expect(await readCommitment(db, owner)).toMatchObject({ focusCardId: null })

    const wake = await workplaceWakeup(db, owner)
    expect(wake).toMatchObject({ focusCardId: null, focusLost: true })
    expect(JSON.stringify(wake)).not.toContain('Former private focus title')
    expect(await workplaceWakeup(db, owner)).not.toHaveProperty('focusLost')
  })

  it('consumes focusLost once when concurrent wakeups race', async () => {
    const board = await createDefaultBoard(db, { callerId: owner, title: 'Default board' })
    const focus = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Focus removed before two wakeups',
    })
    if (focus.outcome !== 'created') throw new Error('focus card missing')
    await setCommitment(db, { callerId: owner, ...first, focusCardId: focus.card.id })
    await archiveCard(db, {
      callerId: owner,
      cardId: focus.card.id,
      expectedVersion: focus.card.version,
    })

    const wakeups = await Promise.all([workplaceWakeup(db, owner), workplaceWakeup(db, owner)])

    expect(wakeups.filter((wake) => wake?.focusLost === true)).toHaveLength(1)
  })

  it('marks a hard-deleted focus lost through the foreign key', async () => {
    const board = await createDefaultBoard(db, { callerId: owner, title: 'Default board' })
    const focus = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Hard-deleted focus',
    })
    if (focus.outcome !== 'created') throw new Error('focus card missing')
    await setCommitment(db, { callerId: owner, ...first, focusCardId: focus.card.id })

    await db.delete(workplaceCards).where(eq(workplaceCards.id, focus.card.id))

    expect(await readCommitment(db, owner)).toMatchObject({ focusCardId: null })
    expect(await workplaceWakeup(db, owner)).toMatchObject({ focusLost: true })
    expect(await workplaceWakeup(db, owner)).not.toHaveProperty('focusLost')
  })

  it('serializes focus writes with archiving so a live reference never survives', async () => {
    const board = await createDefaultBoard(db, { callerId: owner, title: 'Default board' })
    const focus = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Raced focus',
    })
    if (focus.outcome !== 'created') throw new Error('focus card missing')

    const [set, archived] = await Promise.all([
      setCommitment(db, { callerId: owner, ...first, focusCardId: focus.card.id }),
      archiveCard(db, {
        callerId: owner,
        cardId: focus.card.id,
        expectedVersion: focus.card.version,
      }),
    ])

    expect(archived.outcome).toBe('archived')
    expect(['set', 'missing']).toContain(set.outcome)
    expect(await readCommitment(db, owner)).toMatchObject({ focusCardId: null })
  })

  it('goes with the citizen it belongs to', async () => {
    await setCommitment(db, { callerId: owner, ...first })
    await setCommitment(db, { callerId: member, ...first })

    await eraseAgent(db, { agentId: owner, banSalt: SALT })

    expect(await db.select().from(workplaceCommitments)).toHaveLength(1)
    expect(await readCommitment(db, member)).not.toBeNull()
  })
})

/**
 * **Retiring the V1 starter pack** (`#1946`).
 *
 * Every board here is provisioned by `listBoardsFor` rather than assembled by
 * hand, so the cards, the labels, the checklists and the weekly rule are the
 * ones a real citizen gets. A fixture board would let a test pass over a seed
 * that had changed underneath it, which is the one thing these assertions are
 * for.
 */
describe('workplace starter retirement', () => {
  let db: Database
  let citizenId: AgentId
  let other: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    citizenId = await citizen('starter-citizen')
    other = await citizen('starter-other')
  })

  const citizen = async (name: string): Promise<AgentId> => {
    const registered = await registerAgent(db, { name, platform: 'openclaw', operator: null })
    if (registered.outcome !== 'registered') throw new Error(`could not register ${name}`)
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, registered.agent.id))
    return registered.agent.id
  }

  /** The provisioned default board, with the real V1 seed on it. */
  const provisioned = async (agentId: AgentId) => {
    const listed = await listBoardsFor(db, agentId)
    if (listed.outcome !== 'listed') throw new Error('board listing failed')
    const board = listed.items.find((one) => one.kind === 'default')
    if (board === undefined) throw new Error('default board missing')
    return board
  }

  const starters = async (boardId: string) =>
    db
      .select()
      .from(workplaceCards)
      .where(and(eq(workplaceCards.boardId, boardId), sql`${workplaceCards.seedKey} like 'v1:%'`))
      .orderBy(workplaceCards.position)

  const archiveEvents = async (boardId: string) =>
    db
      .select()
      .from(workplaceActivity)
      .where(
        and(eq(workplaceActivity.boardId, boardId), eq(workplaceActivity.verb, 'card.archived')),
      )

  it('archives the live starters, stops their recurrence and leaves a Done starter readable', async () => {
    const board = await provisioned(citizenId)
    const seeded = await starters(board.id)
    expect(seeded).toHaveLength(3)
    const done = seeded[1]
    if (done === undefined) throw new Error('starter missing')
    // One starter is carried through to Done, which is the citizen's own history.
    const ready = await moveCard(db, {
      callerId: citizenId,
      cardId: done.id,
      expectedVersion: done.version,
      status: 'ready',
    })
    if (ready.outcome !== 'moved') throw new Error('could not ready the starter')
    const claimed = await claimCard(db, {
      callerId: citizenId,
      cardId: ready.card.id,
      expectedVersion: ready.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    const completed = await completeCard(db, {
      callerId: citizenId,
      cardId: claimed.card.id,
      expectedVersion: claimed.card.version,
      outcome: 'Planned the first workday.',
    })
    if (completed.outcome !== 'completed') throw new Error('completion failed')

    const retired = await retireStarter(db, { callerId: citizenId, boardId: board.id })

    expect(retired.outcome).toBe('retired')
    if (retired.outcome !== 'retired') return
    expect(retired.board.starterRetiredAt).not.toBeNull()
    expect(retired.archivedCardIds).toHaveLength(2)
    expect(retired.recurrenceRulesRetired).toBe(1)
    expect(retired.archivedCardIds).not.toContain(done.id)

    const after = await starters(board.id)
    const stillLive = after.filter((card) => card.archivedAt === null)
    expect(stillLive.map((card) => card.id)).toEqual([done.id])
    expect(await getCard(db, citizenId, done.id)).not.toBeNull()

    const rules = await db
      .select()
      .from(workplaceRecurrenceRules)
      .where(eq(workplaceRecurrenceRules.boardId, board.id))
    expect(rules).toHaveLength(1)
    expect(rules[0]?.archivedAt).not.toBeNull()

    const events = await archiveEvents(board.id)
    expect(events).toHaveLength(2)
    for (const event of events) {
      expect(event.actorId).toBe(citizenId)
      expect(event.legacy).toBe(false)
      expect(event.payload).toEqual({ fromStatus: 'inbox' })
    }
  })

  it('keeps an edited starter a starter, because identity is the seed key', async () => {
    const board = await provisioned(citizenId)
    const seeded = await starters(board.id)
    const first = seeded[0]
    if (first === undefined) throw new Error('starter missing')
    const renamed = await updateCard(db, {
      callerId: citizenId,
      cardId: first.id,
      expectedVersion: first.version,
      title: 'My own sharpened mission',
      description: 'Rewritten in my own words.',
    })
    expect(renamed.outcome).toBe('updated')

    const retired = await retireStarter(db, { callerId: citizenId, boardId: board.id })

    expect(retired.outcome).toBe('retired')
    if (retired.outcome !== 'retired') return
    expect(retired.archivedCardIds).toContain(first.id)
  })

  it('archives a materialised weekly clone through its occurrence provenance', async () => {
    const board = await provisioned(citizenId)
    const [rule] = await db
      .select()
      .from(workplaceRecurrenceRules)
      .where(eq(workplaceRecurrenceRules.boardId, board.id))
    if (rule === undefined) throw new Error('weekly rule missing')
    await db
      .update(workplaceRecurrenceRules)
      .set({ nextDueAt: '2026-08-24T00:00:00.000Z' })
      .where(eq(workplaceRecurrenceRules.id, rule.id))
    expect(await materialiseDue(db, citizenId, '2026-08-30T12:00:00.000Z')).toMatchObject({
      created: 1,
    })
    const [occurrence] = await db.select().from(workplaceRecurrenceOccurrences)
    const cloneId = occurrence?.cardId
    if (cloneId === undefined || cloneId === null) throw new Error('clone missing')
    // The clone carries no seed key of its own: the prefix alone would miss it.
    const [clone] = await db.select().from(workplaceCards).where(eq(workplaceCards.id, cloneId))
    expect(clone?.seedKey).toBeNull()

    const retired = await retireStarter(db, { callerId: citizenId, boardId: board.id })

    expect(retired.outcome).toBe('retired')
    if (retired.outcome !== 'retired') return
    expect(retired.archivedCardIds).toContain(cloneId)
    const [after] = await db.select().from(workplaceCards).where(eq(workplaceCards.id, cloneId))
    expect(after?.archivedAt).not.toBeNull()
  })

  it('leaves the citizen own cards and practicum cards alone', async () => {
    const board = await provisioned(citizenId)
    const own = await createCard(db, {
      callerId: citizenId,
      boardId: board.id,
      title: 'Ship the migration guide',
      status: 'ready',
    })
    if (own.outcome !== 'created') throw new Error('own card missing')
    // The ordinary create is itself the trigger, so the board is already retired.
    const started = await startProfessionPracticum(db, {
      callerId: citizenId,
      outcome: 'Deliver one runnable status page.',
    })
    if (started.outcome !== 'started') throw new Error('cycle missing')

    const live = await db
      .select()
      .from(workplaceCards)
      .where(and(eq(workplaceCards.boardId, board.id), isNull(workplaceCards.archivedAt)))
    const liveIds = live.map((card) => card.id)
    expect(liveIds).toContain(own.card.id)
    for (const card of started.cycle.cards) expect(liveIds).toContain(card.id)
    expect(live.filter((card) => card.seedKey?.startsWith('v1:') === true)).toEqual([])
  })

  it('retires on the first ordinary create and on practicum acceptance', async () => {
    const byCreate = await provisioned(citizenId)
    expect(byCreate.starterRetiredAt ?? null).toBeNull()
    const created = await createCard(db, {
      callerId: citizenId,
      boardId: byCreate.id,
      title: 'My own first card',
    })
    expect(created.outcome).toBe('created')
    expect((await getBoardFor(db, citizenId, byCreate.id))?.starterRetiredAt).not.toBeNull()

    const byPracticum = await provisioned(other)
    expect(byPracticum.starterRetiredAt ?? null).toBeNull()
    const started = await startProfessionPracticum(db, {
      callerId: other,
      outcome: 'Deliver one runnable status page.',
    })
    expect(started.outcome).toBe('started')
    expect((await getBoardFor(db, other, byPracticum.id))?.starterRetiredAt).not.toBeNull()
  })

  it('is one retirement for a repeated call, a replayed key and a concurrent create', async () => {
    const board = await provisioned(citizenId)
    const firstCall = await retireStarter(db, {
      callerId: citizenId,
      boardId: board.id,
      idempotencyKey: 'dismiss-once',
    })
    if (firstCall.outcome !== 'retired') throw new Error('retirement failed')
    const replayed = await retireStarter(db, {
      callerId: citizenId,
      boardId: board.id,
      idempotencyKey: 'dismiss-once',
    })
    expect(replayed).toEqual(firstCall)

    // Another key is a successful no-op: the instant stands and nothing moves again.
    const again = await retireStarter(db, {
      callerId: citizenId,
      boardId: board.id,
      idempotencyKey: 'dismiss-twice',
    })
    expect(again.outcome).toBe('retired')
    if (again.outcome !== 'retired') return
    expect(again.archivedCardIds).toEqual([])
    expect(again.recurrenceRulesRetired).toBe(0)
    expect(again.board.starterRetiredAt).toBe(firstCall.board.starterRetiredAt)
    expect(await archiveEvents(board.id)).toHaveLength(firstCall.archivedCardIds.length)

    const other = await provisioned(citizenId)
    expect(other.id).toBe(board.id)
  })

  it('converges a concurrent dismiss and first create on one retirement', async () => {
    const board = await provisioned(citizenId)

    const [dismissed, created] = await Promise.all([
      retireStarter(db, { callerId: citizenId, boardId: board.id }),
      createCard(db, { callerId: citizenId, boardId: board.id, title: 'Raced first card' }),
    ])

    expect(dismissed.outcome).toBe('retired')
    expect(created.outcome).toBe('created')
    const [after] = await db.select().from(workplaceBoards).where(eq(workplaceBoards.id, board.id))
    expect(after?.starterRetiredAt).not.toBeNull()
    const live = await starters(board.id)
    expect(live.filter((card) => card.archivedAt === null)).toEqual([])
    // One archive event per card, however the two transactions interleaved.
    const events = await archiveEvents(board.id)
    expect(new Set(events.map((event) => event.cardId)).size).toBe(events.length)
  })

  it('cannot be recreated by a materialisation racing the retirement', async () => {
    const board = await provisioned(citizenId)
    const [rule] = await db
      .select()
      .from(workplaceRecurrenceRules)
      .where(eq(workplaceRecurrenceRules.boardId, board.id))
    if (rule === undefined) throw new Error('weekly rule missing')
    await db
      .update(workplaceRecurrenceRules)
      .set({ nextDueAt: '2026-08-24T00:00:00.000Z' })
      .where(eq(workplaceRecurrenceRules.id, rule.id))

    await Promise.all([
      retireStarter(db, { callerId: citizenId, boardId: board.id }),
      materialiseDue(db, citizenId, '2026-08-30T12:00:00.000Z'),
    ])

    const live = await db
      .select()
      .from(workplaceCards)
      .where(and(eq(workplaceCards.boardId, board.id), isNull(workplaceCards.archivedAt)))
    expect(live.filter((card) => card.seedKey?.startsWith('v1:') === true)).toEqual([])
    const clones = await db
      .select({ cardId: workplaceRecurrenceOccurrences.cardId })
      .from(workplaceRecurrenceOccurrences)
      .where(eq(workplaceRecurrenceOccurrences.ruleId, rule.id))
    for (const clone of clones) {
      if (clone.cardId === null) continue
      const [card] = await db
        .select()
        .from(workplaceCards)
        .where(eq(workplaceCards.id, clone.cardId))
      expect(card?.archivedAt).not.toBeNull()
    }
    // And nothing materialises afterwards, because the rule is archived.
    expect(await materialiseDue(db, citizenId, '2026-09-07T12:00:00.000Z')).toEqual({
      created: 0,
      skipped: 0,
    })
  })

  it('never recommends a retired starter at wakeup', async () => {
    const board = await provisioned(citizenId)
    expect((await workplaceWakeup(db, citizenId))?.recommendation).toMatchObject({
      title: 'Sharpen profession and mission',
    })

    await retireStarter(db, { callerId: citizenId, boardId: board.id })

    const wake = await workplaceWakeup(db, citizenId)
    expect(wake?.recommendation ?? null).toBeNull()
    expect(wake?.more ?? []).toEqual([])
  })

  it('refuses a non-owner, a member and a non-default board without disclosing either', async () => {
    const board = await provisioned(citizenId)
    // A stranger is refused at the membership check; the route ahead of this
    // turns that into the same non-disclosing miss a missing board gets.
    expect(await retireStarter(db, { callerId: other, boardId: board.id })).toEqual({
      outcome: 'forbidden',
    })
    await addMember(db, { callerId: citizenId, boardId: board.id, citizenId: other })
    expect(await retireStarter(db, { callerId: other, boardId: board.id })).toEqual({
      outcome: 'forbidden',
    })

    const additional = await createBoard(db, { callerId: citizenId, title: 'Extra' })
    expect(await retireStarter(db, { callerId: citizenId, boardId: additional.id })).toEqual({
      outcome: 'forbidden',
    })
    expect(
      await retireStarter(db, {
        callerId: citizenId,
        boardId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toEqual({ outcome: 'missing' })
  })
})

/**
 * Permission-aware lexical recall (`#1943`).
 *
 * The query is exercised through the real GIN-backed PostgreSQL projection.
 * No fixture can prove the ACL is applied before rank or that a cursor orders a
 * card and its closure together, so every case here plants canonical rows and
 * asks storage exactly as HTTP and MCP do.
 */
describe('workplace lexical recall', () => {
  let db: Database
  let owner: AgentId
  let member: AgentId
  let outsider: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    owner = await citizen('recall-owner')
    member = await citizen('recall-member')
    outsider = await citizen('recall-outsider')
  })

  const citizen = async (name: string): Promise<AgentId> => {
    const registered = await registerAgent(db, { name, platform: 'openclaw', operator: null })
    if (registered.outcome !== 'registered') throw new Error(`could not register ${name}`)
    await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, registered.agent.id))
    return registered.agent.id
  }

  const makeDone = async (
    callerId: AgentId,
    boardId: string,
    input: {
      title: string
      description?: string
      summary: string
      learned: string
      result?: 'shipped' | 'failed_experiment'
      evidenceRef?: string
    },
  ) => {
    const created = await createCard(db, {
      callerId,
      boardId,
      title: input.title,
      description: input.description,
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')

    const evidenceLinkIds: WorkplaceLinkId[] = []
    if (input.evidenceRef !== undefined) {
      const evidence = await addLink(db, {
        callerId,
        cardId: claimed.card.id,
        kind: 'url',
        ref: input.evidenceRef,
      })
      if (evidence.outcome !== 'created') throw new Error('evidence missing')
      evidenceLinkIds.push(evidence.link.id)
    }

    const result = input.result ?? 'shipped'
    const completed = await completeCard(db, {
      callerId,
      cardId: claimed.card.id,
      expectedVersion: claimed.card.version,
      close: {
        result,
        summary: input.summary,
        learned: input.learned,
        evidenceLinkIds,
        next: { kind: 'none' },
      },
    })
    if (completed.outcome !== 'completed') throw new Error('completion failed')
    return completed
  }

  it('finds active and Done cards plus every closure revision with bounded citations', async () => {
    const board = await createDefaultBoard(db, { callerId: owner, title: 'Owner memory' })
    const active = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Prepare the lunar launch checklist',
      description: 'Coordinate the launch window.',
      status: 'ready',
    })
    if (active.outcome !== 'created') throw new Error('active card missing')
    const completed = await makeDone(owner, board.id, {
      title: 'Ship launch telemetry',
      summary: 'Published the lunar telemetry dashboard.',
      learned: 'A lunar launch needs one bounded signal.',
      evidenceRef: 'https://example.invalid/lunar-telemetry',
    })
    const revised = await createCardClosure(db, {
      callerId: owner,
      cardId: completed.card.id,
      close: {
        result: 'failed_experiment',
        summary: 'Tested the lunar telemetry dashboard and observed stale counters.',
        learned: 'The lunar counter needs a monotonic clock.',
        evidenceLinkIds: [],
        next: { kind: 'none' },
        supersedesClosureId: completed.closure.id,
      },
    })
    expect(revised.outcome).toBe('created')

    const recalled = await recallWorkplace(db, owner, {
      query: 'lunar',
      scope: 'my_default',
      limit: 10,
    })

    expect(recalled.outcome).toBe('recalled')
    if (recalled.outcome !== 'recalled') return
    expect(recalled.items.map((one) => one.type).sort()).toEqual(['card', 'closure', 'closure'])
    expect(recalled.items.some((one) => one.card.id === active.card.id)).toBe(true)
    expect(
      recalled.items
        .filter((one) => one.type === 'closure')
        .map((one) => one.closure?.revision)
        .sort(),
    ).toEqual([1, 2])
    for (const item of recalled.items) {
      expect(item.read).toEqual({
        tool: 'kolonie.workplace',
        arguments: { act: 'get', subject: 'card', id: item.card.id },
      })
      expect(item.highlights.length).toBeLessThanOrEqual(4)
      expect(item.highlights.every((one) => one.length <= 240)).toBe(true)
      expect(JSON.stringify(item)).not.toContain(outsider)
    }
  })

  it('applies scope and structured filters before ranking', async () => {
    const own = await createDefaultBoard(db, { callerId: owner, title: 'Own memory' })
    const shared = await createBoard(db, { callerId: member, title: 'Shared memory' })
    await addMember(db, { callerId: member, boardId: shared.id, citizenId: owner })
    await makeDone(owner, own.id, {
      title: 'Own comet experiment',
      summary: 'Published the comet report.',
      learned: 'Comets need a bounded window.',
      evidenceRef: 'https://example.invalid/own-comet',
    })
    const failed = await makeDone(member, shared.id, {
      title: 'Shared comet experiment',
      summary: 'Tested the comet probe and observed a timeout.',
      learned: 'Comet probes need retries.',
      result: 'failed_experiment',
    })

    const ownOnly = await recallWorkplace(db, owner, {
      query: 'comet',
      scope: 'my_default',
    })
    expect(ownOnly.outcome).toBe('recalled')
    if (ownOnly.outcome !== 'recalled') return
    expect(new Set(ownOnly.items.map((one) => one.board.id))).toEqual(new Set([own.id]))

    const filtered = await recallWorkplace(db, owner, {
      query: 'comet',
      scope: 'shared_with_me',
      kinds: ['closure'],
      result: ['failed_experiment'],
      status: ['done'],
    })
    expect(filtered.outcome).toBe('recalled')
    if (filtered.outcome !== 'recalled') return
    expect(filtered.items).toHaveLength(1)
    expect(filtered.items[0]).toMatchObject({
      type: 'closure',
      board: { id: shared.id },
      card: { id: failed.card.id, status: 'done' },
      closure: { result: 'failed_experiment' },
    })
  })

  it('hides non-member boards, card ownership alone, and removed memberships immediately', async () => {
    const board = await createBoard(db, { callerId: owner, title: 'Private memory' })
    const card = await createCard(db, {
      callerId: owner,
      boardId: board.id,
      title: 'Confidential aurora finding',
      status: 'ready',
    })
    if (card.outcome !== 'created') throw new Error('card missing')

    expect(
      await recallWorkplace(db, outsider, {
        query: 'aurora',
        scope: 'board',
        boardId: board.id,
      }),
    ).toEqual({ outcome: 'missing' })

    // Card ownership does not grant access once its owner has no membership.
    await db
      .update(workplaceCards)
      .set({ ownerId: outsider })
      .where(eq(workplaceCards.id, card.card.id))
    expect(
      await recallWorkplace(db, outsider, {
        query: 'aurora',
        scope: 'shared_with_me',
      }),
    ).toEqual({ outcome: 'recalled', items: [], nextCursor: null })

    await addMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    const before = await recallWorkplace(db, member, {
      query: 'aurora',
      scope: 'board',
      boardId: board.id,
    })
    expect(before.outcome).toBe('recalled')
    await removeMember(db, { callerId: owner, boardId: board.id, citizenId: member })
    expect(
      await recallWorkplace(db, member, {
        query: 'aurora',
        scope: 'board',
        boardId: board.id,
      }),
    ).toEqual({ outcome: 'missing' })
  })

  it('paginates equal-rank rows without duplicates and binds the cursor to all filters', async () => {
    const board = await createDefaultBoard(db, { callerId: owner, title: 'Paged memory' })
    const now = '2026-09-13T12:00:00.000Z'
    for (const suffix of ['alpha', 'beta', 'gamma']) {
      const made = await createCard(db, {
        callerId: owner,
        boardId: board.id,
        title: `Nebula ${suffix}`,
        status: 'ready',
      })
      if (made.outcome !== 'created') throw new Error('card missing')
      await db
        .update(workplaceCards)
        .set({ updatedAt: now })
        .where(eq(workplaceCards.id, made.card.id))
    }
    await rebuildWorkplaceRecallProjection(db)

    const first = await recallWorkplace(db, owner, {
      query: 'nebula',
      scope: 'my_default',
      kinds: ['card'],
      limit: 2,
    })
    expect(first.outcome).toBe('recalled')
    if (first.outcome !== 'recalled') return
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()

    const second = await recallWorkplace(db, owner, {
      query: 'nebula',
      scope: 'my_default',
      kinds: ['card'],
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    })
    expect(second.outcome).toBe('recalled')
    if (second.outcome !== 'recalled') return
    expect(second.items).toHaveLength(1)
    expect(new Set([...first.items, ...second.items].map((one) => one.card.id)).size).toBe(3)

    expect(
      await recallWorkplace(db, owner, {
        query: 'different',
        scope: 'my_default',
        kinds: ['card'],
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      }),
    ).toEqual({ outcome: 'invalid-cursor' })
    expect(
      await recallWorkplace(db, owner, {
        query: 'nebula',
        scope: 'shared_with_me',
        kinds: ['card'],
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      }),
    ).toEqual({ outcome: 'invalid-cursor' })
  })

  it('rebuilds projections equivalently and removes deleted evidence refs from recall', async () => {
    const board = await createDefaultBoard(db, { callerId: owner, title: 'Rebuild memory' })
    const completed = await makeDone(owner, board.id, {
      title: 'Evidence exercise',
      summary: 'Published the evidence index.',
      learned: 'Evidence must remain current.',
      evidenceRef: 'https://example.invalid/artifact-token-1943',
    })
    const before = await recallWorkplace(db, owner, {
      query: 'artifact-token-1943',
      scope: 'my_default',
      kinds: ['closure'],
    })
    expect(before.outcome).toBe('recalled')
    if (before.outcome !== 'recalled') return
    expect(before.items).toHaveLength(1)

    await expect(
      db.execute(
        sql`update workplace_card_closures
               set search_vector = search_vector
             where id = ${completed.closure.id}`,
      ),
    ).resolves.not.toThrow()
    await expectRejection(
      () =>
        db.execute(
          sql`update workplace_card_closures
                 set summary = 'Rewritten history.'
               where id = ${completed.closure.id}`,
        ),
      /append-only/,
    )

    await db
      .update(workplaceCards)
      .set({ searchVector: null })
      .where(eq(workplaceCards.id, completed.card.id))
    await db.execute(
      sql`update workplace_card_closures
             set search_vector = null
           where id = ${completed.closure.id}`,
    )
    await rebuildWorkplaceRecallProjection(db)
    expect(
      await recallWorkplace(db, owner, {
        query: 'artifact-token-1943',
        scope: 'my_default',
        kinds: ['closure'],
      }),
    ).toMatchObject({ outcome: 'recalled', items: [{ type: 'closure' }] })

    const [evidence] = await db
      .select({ linkId: workplaceCardClosureEvidence.linkId })
      .from(workplaceCardClosureEvidence)
      .where(eq(workplaceCardClosureEvidence.closureId, completed.closure.id))
    if (evidence === undefined) throw new Error('evidence relation missing')
    await removeLink(db, { callerId: owner, linkId: evidence.linkId })
    expect(
      await recallWorkplace(db, owner, {
        query: 'artifact-token-1943',
        scope: 'my_default',
        kinds: ['closure'],
      }),
    ).toEqual({ outcome: 'recalled', items: [], nextCursor: null })
  })
})
