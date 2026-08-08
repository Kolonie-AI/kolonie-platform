import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { AccountKindSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { addWish, markWanted, removeWish, wantedAccountsFor } from './account-wishes.js'
import { writeProviderRecipe, listAtlasProvider } from './provider-recipes.js'
import { declareAccount } from './accounts.js'

const target = databaseTestTarget()

/**
 * What the operator has said yes to, as the digest reads it (`#581`).
 *
 * **The mark used to do nothing an operator could see.** `wantedWishesFor` was
 * exported, tested, and called by nothing in the platform; the timestamp's only
 * live effect was that one MCP call stopped refusing, on a call the agent had no
 * reason to make. This is the read that finally has a caller, and what these
 * tests pin is the two filters that decide what a citizen is told about.
 */
describe('the accounts an operator has marked', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db.execute<{ id: string }>(
      sql`insert into agents (name, platform) values (${name}, 'claude') returning id`,
    )
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id as AgentId
  }

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await anAgent('marked')
  })

  const listed = async (provider: string) => {
    await addWish(db, { agentId, provider, author: 'operator' })
  }

  it('names a provider the operator marked', async () => {
    await listed('somewhere.example')
    await markWanted(db, agentId, 'somewhere.example')

    const wanted = await wantedAccountsFor(db, agentId)

    expect(wanted).toHaveLength(1)
    expect(wanted[0]?.provider).toBe('somewhere.example')
    expect(wanted[0]?.wantedAt).not.toBeNull()
  })

  /**
   * The rejection case `#581` names. **An unmarked entry is one the operator is
   * still considering**, and `#527` reserves the mark as the one gesture that
   * means *you may act on this*. A digest carrying unmarked entries would be
   * asking for work nobody approved.
   */
  it('says nothing about an entry that is on the list and unmarked', async () => {
    await listed('considering.example')

    expect(await wantedAccountsFor(db, agentId)).toEqual([])
  })

  /**
   * **A mark that has been satisfied is not an open request.** Repeating it
   * every waking would be the digest nagging about finished work, which is how a
   * section a citizen is supposed to act on becomes one it learns to skip.
   */
  it('drops a provider the citizen already holds an account at', async () => {
    await listed('held.example')
    await markWanted(db, agentId, 'held.example')
    await declareAccount(db, agentId, {
      kind: AccountKindSchema.parse('mailbox'),
      identifier: 'agent@held.example',
      provider: 'held.example',
    })

    expect(await wantedAccountsFor(db, agentId)).toEqual([])
  })

  it('says nothing about another agent’s marks', async () => {
    const other = await anAgent('somebody-else')
    await addWish(db, { agentId: other, provider: 'theirs.example', author: 'operator' })
    await markWanted(db, other, 'theirs.example')

    expect(await wantedAccountsFor(db, agentId)).toEqual([])
  })

  /** Removing an entry takes it out of the digest, which is what `#581` asks. */
  it('says nothing about an entry that was marked and then removed', async () => {
    await listed('changed-my-mind.example')
    await markWanted(db, agentId, 'changed-my-mind.example')
    await removeWish(db, agentId, 'changed-my-mind.example')

    expect(await wantedAccountsFor(db, agentId)).toEqual([])
  })

  describe('what it says the catalogue holds', () => {
    it('carries a written recipe’s status and its steps', async () => {
      await writeProviderRecipe(db, {
        kind: AccountKindSchema.parse('github'),
        provider: 'walked.example',
        title: 'Walked',
        status: 'joinable',
        category: 'code-hosting',
        steps: [
          { actor: 'agent', instruction: 'Name the handle.' },
          { actor: 'operator', instruction: 'Accept the terms.', ask: 'Please accept the terms.' },
        ],
        proves: 'rung',
      })
      await listed('walked.example')
      await markWanted(db, agentId, 'walked.example')

      const [wanted] = await wantedAccountsFor(db, agentId)

      expect(wanted?.status).toBe('joinable')
      // Derived from the steps by the same function the Atlas pages use, so the
      // digest and the page cannot answer differently about one provider.
      expect(wanted?.operatorNeed).toBe('operator-needed')
      expect(wanted?.operatorNeedIsGuess).toBe(false)
    })

    /**
     * The other rejection case `#581` names, from the storage side: **a provider
     * with no recipe still comes back.** Filtering it out would make the citizen
     * unable to see what its operator asked for, and a provider nobody has
     * written up is exactly the signal `#534` is built on.
     */
    it('carries a listed provider nobody has walked, rather than dropping it', async () => {
      await listAtlasProvider(db, {
        kind: AccountKindSchema.parse('mailbox'),
        provider: 'listed.example',
        title: 'Listed',
        category: 'mailbox',
      })
      await listed('listed.example')
      await markWanted(db, agentId, 'listed.example')

      const [wanted] = await wantedAccountsFor(db, agentId)

      expect(wanted?.status).toBe('unwritten')
    })

    /**
     * **`null` is not `unwritten`.** The first says the Colony has never heard
     * of this provider and the second that it lists it and nobody has walked it
     * — and the free-text field takes anything, so both arrive here.
     */
    it('says the catalogue holds nothing for a provider it has never heard of', async () => {
      await listed('unheard.example')
      await markWanted(db, agentId, 'unheard.example')

      const [wanted] = await wantedAccountsFor(db, agentId)

      expect(wanted?.status).toBeNull()
    })
  })
})
