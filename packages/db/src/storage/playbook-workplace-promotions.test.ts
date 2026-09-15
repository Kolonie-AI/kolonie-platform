import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type AgentId,
  type WorkplaceCardClosureResult,
  type WorkplaceLinkId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  addMember,
  addLink,
  claimCard,
  completeCard,
  createBoard,
  createCard,
  createCardClosure,
  createDefaultBoard,
} from './workplace.js'
import { eraseAgent } from './erasure.js'
import {
  draftPlaybookWithWorkplaceSources,
  playbookBySlug,
  playbookWorkplaceProvenance,
} from './playbooks.js'

const target = databaseTestTarget()

describe('workplace playbook promotion storage (#1945)', () => {
  let db: Database
  let author: AgentId
  let stranger: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    author = await citizen('author')
    stranger = await citizen('stranger')
  })

  const citizen = async (name: string): Promise<AgentId> => {
    const registered = await registerAgent(db, { name, platform: 'openclaw', operator: null })
    if (registered.outcome !== 'registered') throw new Error(`could not register ${name}`)
    return registered.agent.id
  }

  const makeCardWithClosure = async (
    callerId: AgentId,
    boardId: string,
    title: string,
    result: WorkplaceCardClosureResult,
    options?: { readonly legacy?: boolean },
  ) => {
    const card = await createCard(db, {
      callerId,
      boardId,
      title,
      status: 'ready',
    })
    if (card.outcome !== 'created') throw new Error(`card create failed: ${card.outcome}`)
    const claimed = await claimCard(db, {
      callerId,
      cardId: card.card.id,
      expectedVersion: card.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error(`card claim failed: ${claimed.outcome}`)
    const evidenceLinkIds: WorkplaceLinkId[] = []
    if (result === 'shipped') {
      const link = await addLink(db, {
        callerId,
        cardId: card.card.id,
        kind: 'url',
        ref: 'https://example.com/proof',
      })
      if (link.outcome !== 'created') throw new Error('link create failed')
      evidenceLinkIds.push(link.link.id)
    }
    if (options?.legacy) {
      const completed = await completeCard(db, {
        callerId,
        cardId: card.card.id,
        expectedVersion: claimed.card.version,
        outcome: `Legacy completion for ${title}`,
      })
      if (completed.outcome !== 'completed') throw new Error('legacy complete failed')
      return { card: completed.card, closure: completed.closure }
    }
    const close =
      result === 'abandoned'
        ? {
            result: 'abandoned' as const,
            summary: `Closed ${title}.`,
            learned: 'Documented lesson.',
            evidenceLinkIds,
            next: { kind: 'sentence' as const, text: 'Will not continue.' },
          }
        : result === 'failed_experiment'
          ? {
              result: 'failed_experiment' as const,
              summary: `Tried ${title} and observed 500 error.`,
              learned: 'Documented lesson.',
              evidenceLinkIds,
              next: { kind: 'none' as const },
            }
          : {
              result: 'shipped' as const,
              summary: `Closed ${title}.`,
              learned: 'Documented lesson.',
              evidenceLinkIds,
              next: { kind: 'none' as const },
            }
    const completed = await completeCard(db, {
      callerId,
      cardId: card.card.id,
      expectedVersion: claimed.card.version,
      close,
    })
    if (completed.outcome !== 'completed') throw new Error('structured complete failed')
    return { card: completed.card, closure: completed.closure }
  }

  const validDraft = {
    title: 'Repeatable Deployment Procedure',
    summary: 'A tested procedure derived from real workplace executions.',
    requiredAccounts: [],
    steps: [
      { title: 'Check environment', detail: 'Inspect inputs.' },
      { title: 'Run deploy', detail: 'Execute deploy command.' },
    ],
  }

  it('promotes two distinct latest closures across boards into an editable draft with provenance', async () => {
    const board1 = await createDefaultBoard(db, { callerId: author, title: 'Board 1' })
    const board2 = await createBoard(db, { callerId: author, title: 'Board 2' })
    const c1 = await makeCardWithClosure(author, board1.id, 'Task A', 'shipped')
    const c2 = await makeCardWithClosure(author, board2.id, 'Task B', 'failed_experiment')

    const result = await draftPlaybookWithWorkplaceSources(db, {
      authorAgentId: author,
      slug: 'repeatable-deploy',
      draft: validDraft,
      closureIds: [c1.closure.id, c2.closure.id],
    })

    expect(result.outcome).toBe('written')
    if (result.outcome !== 'written') return
    expect(result.playbook.status).toBe('draft')
    expect(result.provenance).toEqual({
      sourceCount: 2,
      resultCounts: { shipped: 1, failed_experiment: 1, abandoned: 0, superseded: 0 },
    })

    const provenance = await playbookWorkplaceProvenance(db, result.playbook.id, author)
    expect(provenance?.provenanceDegraded).toBe(false)
    expect(provenance?.workplaceSources).toHaveLength(2)
    expect(provenance?.workplaceSources?.[0]?.read).toEqual({
      tool: 'kolonie.workplace',
      arguments: { act: 'get', subject: 'card', id: c1.card.id },
    })

    const anonymous = await playbookWorkplaceProvenance(db, result.playbook.id, null)
    expect(anonymous?.workplaceSources).toBeNull()
    expect(anonymous?.provenanceAtPromotion.sourceCount).toBe(2)
  })

  it('hides a source the reader cannot see and reports degraded provenance', async () => {
    const shared = await createBoard(db, { callerId: author, title: 'Shared Board' })
    const privateBoard = await createDefaultBoard(db, { callerId: author, title: 'Private Board' })
    const c1 = await makeCardWithClosure(author, shared.id, 'Shared Task', 'shipped')
    const c2 = await makeCardWithClosure(author, privateBoard.id, 'Private Task', 'shipped')
    await addMember(db, {
      callerId: author,
      boardId: shared.id,
      citizenId: stranger,
    })

    const promoted = await draftPlaybookWithWorkplaceSources(db, {
      authorAgentId: author,
      slug: 'partly-visible',
      draft: validDraft,
      closureIds: [c1.closure.id, c2.closure.id],
    })
    if (promoted.outcome !== 'written') throw new Error('promotion failed')

    const seenByStranger = await playbookWorkplaceProvenance(db, promoted.playbook.id, stranger)
    expect(seenByStranger?.workplaceSources).toHaveLength(1)
    expect(seenByStranger?.provenanceDegraded).toBe(true)
    expect(seenByStranger?.provenanceAtPromotion.sourceCount).toBe(2)
  })

  it('refuses when one closure is not visible to the caller', async () => {
    const authorBoard = await createDefaultBoard(db, { callerId: author, title: 'Author Board' })
    const strangerBoard = await createDefaultBoard(db, {
      callerId: stranger,
      title: 'Stranger Board',
    })
    const c1 = await makeCardWithClosure(author, authorBoard.id, 'Own Task', 'shipped')
    const c2 = await makeCardWithClosure(stranger, strangerBoard.id, 'Private Task', 'shipped')

    const result = await draftPlaybookWithWorkplaceSources(db, {
      authorAgentId: author,
      slug: 'stolen-provenance',
      draft: validDraft,
      closureIds: [c1.closure.id, c2.closure.id],
    })

    expect(result.outcome).toBe('forbidden-source')
    expect(await playbookBySlug(db, 'stolen-provenance')).toBeNull()
  })

  it('refuses when given only one closure or duplicate cards', async () => {
    const board = await createDefaultBoard(db, { callerId: author, title: 'Board' })
    const c1 = await makeCardWithClosure(author, board.id, 'Task A', 'shipped')

    const singleResult = await draftPlaybookWithWorkplaceSources(db, {
      authorAgentId: author,
      slug: 'single-source',
      draft: validDraft,
      closureIds: [c1.closure.id],
    })
    expect(singleResult.outcome).toBe('insufficient-sources')

    const c1Revision = await createCardClosure(db, {
      callerId: author,
      cardId: c1.card.id,
      close: {
        result: 'failed_experiment',
        summary: 'Tried the public endpoint and observed a 403 error.',
        learned: 'Better lesson.',
        evidenceLinkIds: [],
        next: { kind: 'none' },
        supersedesClosureId: c1.closure.id,
      },
    })
    if (c1Revision.outcome !== 'created') throw new Error('revision create failed')

    const duplicateCardResult = await draftPlaybookWithWorkplaceSources(db, {
      authorAgentId: author,
      slug: 'duplicate-cards',
      draft: validDraft,
      closureIds: [c1.closure.id, c1Revision.closure.id],
    })
    expect(duplicateCardResult.outcome).toBe('insufficient-sources')
  })

  it('refuses a superseded non-latest closure revision', async () => {
    const board = await createDefaultBoard(db, { callerId: author, title: 'Board' })
    const c1 = await makeCardWithClosure(author, board.id, 'Task A', 'shipped')
    const c2 = await makeCardWithClosure(author, board.id, 'Task B', 'shipped')

    const c1Revision = await createCardClosure(db, {
      callerId: author,
      cardId: c1.card.id,
      close: {
        result: 'failed_experiment',
        summary: 'Tried the public endpoint and observed a 403 error.',
        learned: 'Better lesson.',
        evidenceLinkIds: [],
        next: { kind: 'none' },
        supersedesClosureId: c1.closure.id,
      },
    })
    if (c1Revision.outcome !== 'created') throw new Error('revision create failed')

    const result = await draftPlaybookWithWorkplaceSources(db, {
      authorAgentId: author,
      slug: 'old-revision',
      draft: validDraft,
      closureIds: [c1.closure.id, c2.closure.id],
    })
    expect(result.outcome).toBe('stale-closure-revision')
  })

  it('refuses legacy completions as sources', async () => {
    const board = await createDefaultBoard(db, { callerId: author, title: 'Board' })
    const c1 = await makeCardWithClosure(author, board.id, 'Task A', 'shipped', { legacy: true })
    const c2 = await makeCardWithClosure(author, board.id, 'Task B', 'shipped')

    const result = await draftPlaybookWithWorkplaceSources(db, {
      authorAgentId: author,
      slug: 'legacy-source',
      draft: validDraft,
      closureIds: [c1.closure.id, c2.closure.id],
    })
    expect(result.outcome).toBe('legacy-closure')
  })

  it('refuses if neither source is shipped or failed_experiment', async () => {
    const board = await createDefaultBoard(db, { callerId: author, title: 'Board' })
    const c1 = await makeCardWithClosure(author, board.id, 'Task A', 'abandoned')
    const c2 = await makeCardWithClosure(author, board.id, 'Task B', 'abandoned')

    const result = await draftPlaybookWithWorkplaceSources(db, {
      authorAgentId: author,
      slug: 'all-abandoned',
      draft: validDraft,
      closureIds: [c1.closure.id, c2.closure.id],
    })
    expect(result.outcome).toBe('no-grounded-outcome')
  })

  it('rolls back all writes if slug is taken or transaction aborts', async () => {
    const board = await createDefaultBoard(db, { callerId: author, title: 'Board' })
    const c1 = await makeCardWithClosure(author, board.id, 'Task A', 'shipped')
    const c2 = await makeCardWithClosure(author, board.id, 'Task B', 'shipped')

    const first = await draftPlaybookWithWorkplaceSources(db, {
      authorAgentId: author,
      slug: 'collision-slug',
      draft: validDraft,
      closureIds: [c1.closure.id, c2.closure.id],
    })
    expect(first.outcome).toBe('written')

    const c3 = await makeCardWithClosure(author, board.id, 'Task C', 'shipped')
    const second = await draftPlaybookWithWorkplaceSources(db, {
      authorAgentId: author,
      slug: 'collision-slug',
      draft: validDraft,
      closureIds: [c2.closure.id, c3.closure.id],
    })
    expect(second.outcome).toBe('slug-taken')

    const sources = await db.execute(sql`select count(*) as count from workplace_playbook_sources`)
    expect(Number(sources[0]?.count)).toBe(2)
  })

  it('degrades provenance when a source is erased and never moves the public snapshot', async () => {
    const own = await createDefaultBoard(db, { callerId: author, title: 'Own Board' })
    const strangerBoard = await createDefaultBoard(db, {
      callerId: stranger,
      title: 'Stranger Board',
    })
    await addMember(db, { callerId: stranger, boardId: strangerBoard.id, citizenId: author })
    const c1 = await makeCardWithClosure(author, own.id, 'Task A', 'shipped')
    const c2 = await makeCardWithClosure(stranger, strangerBoard.id, 'Task B', 'failed_experiment')

    const promoted = await draftPlaybookWithWorkplaceSources(db, {
      authorAgentId: author,
      slug: 'erasure-test',
      draft: validDraft,
      closureIds: [c1.closure.id, c2.closure.id],
    })
    if (promoted.outcome !== 'written') throw new Error('promotion failed')

    const before = await playbookWorkplaceProvenance(db, promoted.playbook.id, author)
    expect(before?.workplaceSources).toHaveLength(2)
    expect(before?.provenanceDegraded).toBe(false)

    const erased = await eraseAgent(db, { agentId: stranger, banSalt: 'salt-salt-salt-salt' })
    expect(erased.outcome).toBe('erased')

    const playbook = await playbookBySlug(db, 'erasure-test')
    expect(playbook?.status).toBe('draft')

    const after = await playbookWorkplaceProvenance(db, promoted.playbook.id, author)
    expect(after?.provenanceAtPromotion).toEqual({
      sourceCount: 2,
      resultCounts: { shipped: 1, failed_experiment: 1, abandoned: 0, superseded: 0 },
    })
    expect(after?.workplaceSources).toHaveLength(1)
    expect(after?.provenanceDegraded).toBe(true)

    const anonymous = await playbookWorkplaceProvenance(db, promoted.playbook.id, null)
    expect(anonymous?.provenanceAtPromotion.sourceCount).toBe(2)
    expect(anonymous?.workplaceSources).toBeNull()
  })
})
