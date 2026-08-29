import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { eraseAgent } from './erasure.js'
import {
  addMember,
  archiveBoard,
  blockCard,
  claimCard,
  completeCard,
  createBoard,
  createCard,
  createDefaultBoard,
  getBoardFor,
  getCard,
  handoverCard,
  listBoardsFor,
  listCards,
  moveCard,
  removeMember,
  updateCard,
} from './workplace.js'
import { workplaceCards } from '../schema/index.js'

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

  const citizen = async (name: string): Promise<AgentId> => {
    const registered = await registerAgent(db, {
      name,
      platform: 'openclaw',
      operator: null,
    })
    if (registered.outcome !== 'registered') throw new Error(`could not register ${name}`)
    return registered.agent.id
  }

  const defaultBoard = async (callerId = owner) =>
    createDefaultBoard(db, { callerId, title: 'Default board' })

  it('hides a board from a citizen that is not a member, the same as a missing id', async () => {
    const board = await defaultBoard()
    expect(await getBoardFor(db, stranger, board.id)).toBeNull()
    expect(await getBoardFor(db, stranger, '00000000-0000-4000-8000-000000000000')).toBeNull()
    expect(await getBoardFor(db, stranger, 'not-a-uuid')).toBeNull()
    expect(await listBoardsFor(db, stranger)).toEqual([])
  })

  it('lists owned and member boards together', async () => {
    const owned = await defaultBoard()
    const extra = await createBoard(db, { callerId: member, title: 'Shared' })
    await addMember(db, { callerId: member, boardId: extra.id, citizenId: owner })
    const listed = await listBoardsFor(db, owner)
    expect(listed.map((one) => one.id).sort()).toEqual([owned.id, extra.id].sort())
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

  it('refuses a non-member write', async () => {
    const board = await defaultBoard()
    expect(await createCard(db, { callerId: stranger, boardId: board.id, title: 'Nope' })).toEqual({
      outcome: 'unknown',
    })
    expect(
      await addMember(db, { callerId: stranger, boardId: board.id, citizenId: member }),
    ).toEqual({ outcome: 'unknown' })
  })

  it('cannot remove the owner membership', async () => {
    const board = await defaultBoard()
    expect(
      await removeMember(db, { callerId: owner, boardId: board.id, citizenId: owner }),
    ).toEqual({ outcome: 'default-board-protected' })
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
    expect(listed.items[0]).not.toHaveProperty('comments')
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
})
