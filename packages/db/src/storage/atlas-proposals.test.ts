import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PERMISSION_AGGREGATE_FLOOR, providerFromUrl, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  decideProviderProposal,
  pendingProviderProposals,
  proposeProvider,
} from './atlas-proposals.js'
import { addWish } from './account-wishes.js'
import { recordProviderEnquiry } from './provider-enquiries.js'
import { providerRecipe, writeProviderRecipe } from './provider-recipes.js'

const target = databaseTestTarget()

/**
 * One proposal queue, three doors (`#600`).
 *
 * **What is asserted here is that the three doors reach one queue**, and that
 * the queue answers *how many parties asked* without answering *who*.
 */
describe('one proposal queue, three doors', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  async function anAgent(name: string): Promise<AgentId> {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })

    if (row === undefined) throw new Error('inserting an agent returned no row')

    return row.id as AgentId
  }

  async function anEntry(provider: string): Promise<void> {
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

  describe('the doors', () => {
    it("raises a proposal from an agent's wish, with no second tool", async () => {
      const agent = await anAgent('wisher')

      const added = await addWish(db, {
        agentId: agent,
        provider: 'notion.so',
        author: 'citizen',
        noticedWhile: 'writing up a walk',
      })

      expect(added.alsoProposed).toBe(true)

      const queue = await pendingProviderProposals(db)
      expect(queue.map((row) => row.proposal.provider)).toEqual(['notion.so'])
      expect(queue[0]?.proposal.source).toBe('citizen')
      /** The citizen's own sentence, which is the half an operator cannot supply. */
      expect(queue[0]?.proposal.why).toBe('writing up a walk')
    })

    it("raises one from an operator's wish, under its own door", async () => {
      const agent = await anAgent('operated')

      await addWish(db, { agentId: agent, provider: 'linear.app', author: 'operator' })

      expect((await pendingProviderProposals(db))[0]?.proposal.source).toBe('operator')
    })

    it('raises one from a provider writing in, and keeps the enquiry', async () => {
      await recordProviderEnquiry(db, {
        product: 'Notion',
        url: 'https://www.notion.so/',
        contact: 'hello@notion.so',
        wants: 'agents keeping their notes with us',
      })

      const queue = await pendingProviderProposals(db)

      expect(queue[0]?.proposal.provider).toBe('notion.so')
      expect(queue[0]?.proposal.source).toBe('provider')
      expect(queue[0]?.proposal.why).toBe('agents keeping their notes with us')
    })

    /**
     * **The commercial record is the point of that table and the proposal is a
     * by-product.** Losing the by-product is not a reason to refuse a provider
     * that wrote in.
     */
    it('records an enquiry whose url nobody can parse, and raises nothing', async () => {
      await recordProviderEnquiry(db, {
        product: 'Something',
        url: 'ask me',
        contact: 'someone@example.test',
        wants: 'to be listed',
      })

      expect(await pendingProviderProposals(db)).toHaveLength(0)
    })

    it('says nothing where the Atlas already holds the provider', async () => {
      await anEntry('trello.com')
      const agent = await anAgent('holder')

      const added = await addWish(db, {
        agentId: agent,
        provider: 'trello.com',
        author: 'citizen',
      })

      expect(added.alsoProposed).toBe(false)
      expect(await pendingProviderProposals(db)).toHaveLength(0)
    })
  })

  describe('one row per provider', () => {
    it('leaves the first door and the first sentence in place when a second party asks', async () => {
      await proposeProvider(db, { provider: 'notion.so', source: 'citizen', why: 'the first' })
      const again = await proposeProvider(db, {
        provider: 'notion.so',
        source: 'provider',
        why: 'the second',
      })

      expect(again.outcome).toBe('already-known')

      const queue = await pendingProviderProposals(db)
      expect(queue).toHaveLength(1)
      expect(queue[0]?.proposal.source).toBe('citizen')
      expect(queue[0]?.proposal.why).toBe('the first')
    })

    /**
     * A provider a steward refused last month does not silently return to the
     * queue because a fourth agent wished for it.
     */
    it('does not reopen a decided proposal', async () => {
      const raised = await proposeProvider(db, { provider: 'notion.so', source: 'citizen' })
      if (raised.outcome !== 'raised') throw new Error('expected it to be raised')

      await decideProviderProposal(db, raised.proposal.id, {
        action: 'refuse',
        reason: 'no API an agent can use',
      })

      const again = await proposeProvider(db, { provider: 'notion.so', source: 'provider' })

      expect(again.outcome).toBe('already-known')
      expect(await pendingProviderProposals(db)).toHaveLength(0)
    })
  })

  describe('how many asked, and never who', () => {
    it('counts citizens and operators separately, and never adds them', async () => {
      for (let n = 0; n < PERMISSION_AGGREGATE_FLOOR; n += 1) {
        await addWish(db, {
          agentId: await anAgent(`citizen-${String(n)}`),
          provider: 'notion.so',
          author: 'citizen',
        })
      }
      for (let n = 0; n < PERMISSION_AGGREGATE_FLOOR; n += 1) {
        await addWish(db, {
          agentId: await anAgent(`operated-${String(n)}`),
          provider: 'notion.so',
          author: 'operator',
        })
      }

      const [row] = await pendingProviderProposals(db)

      expect(row?.citizens).toBe(PERMISSION_AGGREGATE_FLOOR)
      expect(row?.operators).toBe(PERMISSION_AGGREGATE_FLOOR)
    })

    /**
     * **Three agents wanting something is not a market signal, it is three
     * identifiable agents.** The row still appears — hiding it would hide work
     * from the steward whose queue it is — and the count reads as nothing.
     */
    it('suppresses a count below the aggregate floor, and keeps the row', async () => {
      await addWish(db, {
        agentId: await anAgent('lonely'),
        provider: 'notion.so',
        author: 'citizen',
      })

      const [row] = await pendingProviderProposals(db)

      expect(row?.proposal.provider).toBe('notion.so')
      expect(row?.citizens).toBe(0)
    })
  })

  describe('what a steward may do', () => {
    async function pending(provider = 'notion.so'): Promise<string> {
      const raised = await proposeProvider(db, { provider, source: 'citizen' })
      if (raised.outcome !== 'raised') throw new Error('expected it to be raised')

      return raised.proposal.id
    }

    it('lists an accepted provider, with no steps invented', async () => {
      const id = await pending()

      const decided = await decideProviderProposal(db, id, {
        action: 'accept',
        category: 'knowledge-docs',
      })

      expect(decided.outcome).toBe('decided')

      const entry = await providerRecipe(db, 'notes' as never, 'notion.so')
      expect(entry?.status).toBe('unwritten')
      expect(entry?.steps).toHaveLength(0)
      expect(entry?.proves).toBeNull()
      expect(entry?.category).toBe('knowledge-docs')
      expect(await pendingProviderProposals(db)).toHaveLength(0)
    })

    /** The rejection case `#600` names: a proposal accepted twice. */
    it('refuses a second decision on the same proposal', async () => {
      const id = await pending()

      await decideProviderProposal(db, id, { action: 'accept', category: 'knowledge-docs' })
      const again = await decideProviderProposal(db, id, {
        action: 'accept',
        category: 'data-apis',
      })

      expect(again.outcome).toBe('not-pending')
      /** And no second entry on a second shelf. */
      expect(await providerRecipe(db, 'api' as never, 'notion.so')).toBeUndefined()
    })

    it('records a refusal with the reason the proposer is told', async () => {
      const id = await pending()

      const decided = await decideProviderProposal(db, id, {
        action: 'refuse',
        reason: 'there is no API an agent can use once it holds the account',
      })

      expect(decided.outcome).toBe('decided')
      if (decided.outcome !== 'decided') return
      expect(decided.proposal.status).toBe('refused')
      expect(decided.proposal.decidedReason).toContain('no API')
    })

    it('merges into an entry that exists', async () => {
      await anEntry('cloudflare.com')
      const id = await pending('workers.cloudflare.com')

      const decided = await decideProviderProposal(db, id, {
        action: 'merge',
        into: 'cloudflare.com',
      })

      expect(decided.outcome).toBe('decided')
      if (decided.outcome !== 'decided') return
      expect(decided.proposal.mergedInto).toBe('cloudflare.com')
    })

    it('refuses a merge into an entry the catalogue does not hold', async () => {
      const id = await pending()

      expect(
        (await decideProviderProposal(db, id, { action: 'merge', into: 'nowhere.test' })).outcome,
      ).toBe('no-such-entry')
      /** And it stays in the queue rather than being quietly decided. */
      expect(await pendingProviderProposals(db)).toHaveLength(1)
    })
  })

  describe('the url a provider typed', () => {
    it('reads one provider out of the shapes a person writes', () => {
      for (const written of ['https://notion.so/', 'www.notion.so', 'notion.so', 'NOTION.SO']) {
        expect(providerFromUrl(written)).toBe('notion.so')
      }
    })

    /** A subdomain really is a different shelf entry, so nothing folds it. */
    it('keeps a subdomain, which is its own entry', () => {
      expect(providerFromUrl('https://workers.cloudflare.com')).toBe('workers.cloudflare.com')
    })

    it('says nothing where nothing usable is there', () => {
      expect(providerFromUrl('ask me')).toBeUndefined()
      expect(providerFromUrl('')).toBeUndefined()
    })
  })
})
