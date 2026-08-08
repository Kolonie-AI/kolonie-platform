import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PERMISSION_AGGREGATE_FLOOR, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import {
  addWish,
  wantedProviderCounts,
  markWanted,
  removeWish,
  wantedWishesFor,
  wishBlocksHandoff,
  wishesFor,
} from './account-wishes.js'

const target = databaseTestTarget()

/**
 * The list an agent and its operator share (#527).
 *
 * **The two properties worth a real database** are the ones a fake could hold
 * wrongly forever: that one provider is one row however many times either side
 * writes it, and that the gate refuses only what is on the list and undecided.
 */
describe('the shared account list', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id as AgentId
  }

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await anAgent('planner')
  })

  describe('adding', () => {
    it('keeps what the agent was doing when it noticed', async () => {
      const added = await addWish(db, {
        agentId,
        provider: 'figma.com',
        author: 'citizen',
        noticedWhile: 'I failed three tasks that wanted a design file.',
      })

      expect(added.outcome).toBe('added')
      expect(added.wish.noticedWhile).toBe('I failed three tasks that wanted a design file.')
      expect(added.wish.wantedAt).toBeNull()
    })

    /**
     * The column's whole value is that it means *the agent noticed this while
     * working*. A row with an operator's prose in it would look identical to a
     * legitimate one and would make every count over the column wrong.
     */
    it('refuses to record an operator as having noticed anything', async () => {
      const added = await addWish(db, {
        agentId,
        provider: 'trello.com',
        author: 'operator',
        noticedWhile: 'I think it should have this.',
      })

      expect(added.wish.noticedWhile).toBeNull()
    })

    it('is one row per provider however many times either side adds it', async () => {
      await addWish(db, { agentId, provider: 'trello.com', author: 'citizen' })
      const again = await addWish(db, { agentId, provider: 'trello.com', author: 'operator' })

      expect(again.outcome).toBe('already-listed')
      // The first author stands: the column records who first noticed, not
      // whose item it is.
      expect(again.wish.author).toBe('citizen')
      expect(await wishesFor(db, agentId)).toHaveLength(1)
    })
  })

  describe('the operator’s mark', () => {
    beforeEach(async () => {
      await addWish(db, { agentId, provider: 'trello.com', author: 'citizen' })
    })

    it('turns a wish into something that may be attempted', async () => {
      expect(await wishBlocksHandoff(db, agentId, 'trello.com')).toBe(true)

      expect(await markWanted(db, agentId, 'trello.com')).toBe(true)

      expect(await wishBlocksHandoff(db, agentId, 'trello.com')).toBe(false)
      expect((await wantedWishesFor(db, agentId)).map((wish) => wish.provider)).toEqual([
        'trello.com',
      ])
    })

    it('does not move the date when it is made twice', async () => {
      await markWanted(db, agentId, 'trello.com')
      const [first] = await wishesFor(db, agentId)

      expect(await markWanted(db, agentId, 'trello.com')).toBe(false)

      const [second] = await wishesFor(db, agentId)
      expect(second?.wantedAt).toBe(first?.wantedAt)
    })

    it('is withdrawn by taking the item off the list, which is the only way', async () => {
      await markWanted(db, agentId, 'trello.com')
      expect(await removeWish(db, agentId, 'trello.com')).toBe(true)

      expect(await wishesFor(db, agentId)).toEqual([])
      // And with the row gone, the gate is back to not applying at all.
      expect(await wishBlocksHandoff(db, agentId, 'trello.com')).toBe(false)
    })
  })

  /**
   * The gate is narrow on purpose: a provider nobody wrote down is not gated.
   * Making the list a permission system would mean an agent could make its own
   * work harder by recording that it needs something.
   */
  it('does not gate a provider that is on nobody’s list', async () => {
    expect(await wishBlocksHandoff(db, agentId, 'never-mentioned.com')).toBe(false)
  })

  it('is one agent’s plan and never another’s', async () => {
    const other = await anAgent('somebody-else')
    await addWish(db, { agentId, provider: 'trello.com', author: 'citizen' })

    expect(await wishesFor(db, other)).toEqual([])
    expect(await wishBlocksHandoff(db, other, 'trello.com')).toBe(false)
  })

  /**
   * The aggregate (#534): what a population of autonomous agents is trying to
   * reach and cannot.
   */
  describe('what agents are asking for', () => {
    /** Enough citizens to clear the floor, all wanting the same thing. */
    const aCrowdWanting = async (provider: string, howMany: number): Promise<void> => {
      for (let i = 0; i < howMany; i += 1) {
        const other = await anAgent(`${provider}-${String(i)}`)
        await addWish(db, { agentId: other, provider, author: 'citizen' })
      }
    }

    it('counts citizens per provider, most wanted first', async () => {
      await aCrowdWanting('figma.com', 7)
      await aCrowdWanting('notion.so', 5)

      expect(await wantedProviderCounts(db)).toEqual([
        { provider: 'figma.com', citizens: 7 },
        { provider: 'notion.so', citizens: 5 },
      ])
    })

    /**
     * Three agents wanting something is not a market signal, it is three
     * identifiable agents — and the suppression is in the `having` clause rather
     * than in a caller a second one could skip.
     */
    it('reports nothing about a provider below the floor', async () => {
      await aCrowdWanting('obscure.example', PERMISSION_AGGREGATE_FLOOR - 1)

      expect(await wantedProviderCounts(db)).toEqual([])
    })

    /**
     * An operator's entry is a fact about a person's plan for one agent, which
     * is a different and much weaker claim than *agents are hitting this*.
     */
    it('does not count what operators put on lists', async () => {
      for (let i = 0; i < 9; i += 1) {
        const other = await anAgent(`operator-added-${String(i)}`)
        await addWish(db, { agentId: other, provider: 'trello.com', author: 'operator' })
      }

      expect(await wantedProviderCounts(db)).toEqual([])
    })

    it('carries no identity of any kind', async () => {
      await aCrowdWanting('figma.com', 6)

      const counts = await wantedProviderCounts(db)
      expect(JSON.stringify(counts)).not.toContain('figma.com-0')
      expect(Object.keys(counts[0] ?? {}).sort()).toEqual(['citizens', 'provider'])
    })
  })

  it('refuses a note longer than the column allows', async () => {
    await expectRejection(
      () =>
        addWish(db, {
          agentId,
          provider: 'trello.com',
          author: 'citizen',
          noticedWhile: 'x'.repeat(601),
        }),
      /account_wishes_note_length/,
    )
  })
})
