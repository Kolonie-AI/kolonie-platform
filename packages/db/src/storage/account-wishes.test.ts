import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PERMISSION_AGGREGATE_FLOOR, type AgentId } from '@kolonie-ai/core'
import { eq } from 'drizzle-orm'
import type { Database } from '../client.js'
import { agents, atlasProposals } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import {
  addWish,
  wantedProviderCounts,
  markWanted,
  removeWish,
  wantedWishesFor,
  wishBlocksHandoff,
  wishesFor,
  wishesWithAtlas,
} from './account-wishes.js'
import { decideProviderProposal, pendingProviderProposals } from './atlas-proposals.js'
import { writeProviderRecipe } from './provider-recipes.js'

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

    it('adds agent context to the row an operator put there first', async () => {
      const first = await addWish(db, { agentId, provider: 'github.com', author: 'operator' })
      await markWanted(db, agentId, 'github.com')
      const [wanted] = await wishesFor(db, agentId)

      const enriched = await addWish(db, {
        agentId,
        provider: 'github.com',
        author: 'citizen',
        noticedWhile: 'Publishing a proof exposed the account bottleneck.',
      })

      expect(enriched.outcome).toBe('context-added')
      expect(enriched.wish).toMatchObject({
        id: first.wish.id,
        author: 'operator',
        noticedWhile: 'Publishing a proof exposed the account bottleneck.',
        wantedAt: wanted?.wantedAt,
      })
      const again = await addWish(db, {
        agentId,
        provider: 'github.com',
        author: 'citizen',
        noticedWhile: 'A later retry must not replace the original context.',
      })
      expect(again.outcome).toBe('already-listed')
      expect(again.wish.noticedWhile).toBe('Publishing a proof exposed the account bottleneck.')
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

  /**
   * What became of the proposal the wish raised (`#859`).
   *
   * **A real database, because the answer is a join and not a decision.** Nothing
   * stores where a provider stands: the queue holds the verdict, the catalogue
   * holds the entry, and this reads both on every look. A fake would let the two
   * agree forever, which is precisely what they do not do — accepting a proposal
   * writes a listing, so the pair exists for every provider that got on the map
   * by being asked for.
   */
  describe('where a wished-for provider stands with the Colony', () => {
    const anEntry = async (provider: string): Promise<void> => {
      await writeProviderRecipe(db, {
        kind: 'api' as never,
        provider,
        title: provider,
        status: 'joinable',
        category: 'data-apis',
        steps: [{ actor: 'agent', instruction: 'sign up' }],
        proves: 'provider-post',
      })
    }

    /** The proposal a wish just raised, so a steward can decide it. */
    const proposalFor = async (provider: string): Promise<string> => {
      const [raised] = (await pendingProviderProposals(db)).filter(
        (entry) => entry.proposal.provider === provider,
      )
      if (raised === undefined) throw new Error(`no pending proposal for ${provider}`)
      return raised.proposal.id
    }

    const atlasFor = async (provider: string) => {
      const [wish] = (await wishesWithAtlas(db, agentId)).filter(
        (entry) => entry.wish.provider === provider,
      )
      return wish?.atlas
    }

    it('tells the citizen its wish reached the Colony and nobody has decided it', async () => {
      const added = await addWish(db, { agentId, provider: 'notion.so', author: 'citizen' })

      expect(added.alsoProposed).toBe(true)
      expect(added.atlas).toEqual({ answer: 'pending' })
      expect(await atlasFor('notion.so')).toEqual({ answer: 'pending' })
    })

    /**
     * A provider already on the map raises nothing, and *nothing was raised* is
     * the one thing `alsoProposed` could already say. The answer beside it is
     * what tells the citizen why.
     */
    it('raises nothing for a provider the Atlas already holds', async () => {
      await anEntry('trello.com')

      const added = await addWish(db, { agentId, provider: 'trello.com', author: 'citizen' })

      expect(added.alsoProposed).toBe(false)
      expect(added.atlas).toEqual({ answer: 'listed' })
    })

    it('carries the reason a steward refused it', async () => {
      await addWish(db, { agentId, provider: 'notion.so', author: 'citizen' })

      await decideProviderProposal(db, await proposalFor('notion.so'), {
        action: 'refuse',
        reason: 'there is no API an agent can use once it holds the account',
      })

      expect(await atlasFor('notion.so')).toEqual({
        answer: 'refused',
        reason: 'there is no API an agent can use once it holds the account',
      })
    })

    it('names the entry a merged proposal turned out to be', async () => {
      await anEntry('cloudflare.com')
      await addWish(db, { agentId, provider: 'workers.cloudflare.com', author: 'citizen' })

      await decideProviderProposal(db, await proposalFor('workers.cloudflare.com'), {
        action: 'merge',
        into: 'cloudflare.com',
      })

      expect(await atlasFor('workers.cloudflare.com')).toEqual({
        answer: 'merged',
        into: 'cloudflare.com',
      })
    })

    /**
     * Accepting writes the listing, so both rows exist from the moment of the
     * decision — and *unwritten until somebody walks it* is an answer that goes
     * stale the day somebody does.
     */
    it('lets the entry outrank the proposal that asked for it', async () => {
      await addWish(db, { agentId, provider: 'notion.so', author: 'citizen' })

      await decideProviderProposal(db, await proposalFor('notion.so'), {
        action: 'accept',
        category: 'knowledge-docs',
      })

      expect(await atlasFor('notion.so')).toEqual({ answer: 'listed' })
    })

    /**
     * A refused wish stays on the list. Taking it off would answer *what became
     * of this* by destroying the question, and the citizen is the party the
     * decision was owed to.
     */
    it('keeps every wish on the list whatever became of it', async () => {
      await addWish(db, { agentId, provider: 'notion.so', author: 'citizen' })
      await addWish(db, { agentId, provider: 'figma.com', author: 'citizen' })

      await decideProviderProposal(db, await proposalFor('notion.so'), {
        action: 'refuse',
        reason: 'it sells to people rather than to agents',
      })

      const listed = await wishesWithAtlas(db, agentId)
      expect(listed.map((entry) => entry.wish.provider)).toEqual(['notion.so', 'figma.com'])
      expect(listed).toHaveLength((await wishesFor(db, agentId)).length)
    })

    it('is one agent’s list and never another’s', async () => {
      const other = await anAgent('reads-its-own')
      await addWish(db, { agentId, provider: 'notion.so', author: 'citizen' })

      expect(await wishesWithAtlas(db, other)).toEqual([])
    })

    /**
     * The rejection case, and it is the one the sentence depends on: a refusal
     * carries the reason a citizen is told, or it is not written at all. The
     * fallback in `wishAtlasAnswer` exists for a constraint that is relaxed, not
     * for a row this database will accept.
     */
    it('refuses a refusal that says nothing', async () => {
      await addWish(db, { agentId, provider: 'notion.so', author: 'citizen' })

      await expectRejection(
        () =>
          db
            .update(atlasProposals)
            .set({ status: 'refused', decidedAt: new Date().toISOString() })
            .where(eq(atlasProposals.provider, 'notion.so')),
        /atlas_proposals_refusal_says_why/,
      )
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
