import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { colonyNumbers } from './colony-numbers.js'
import { insertWebIdentity } from './__fixtures__/web-identity.js'

const target = databaseTestTarget()

/**
 * The Colony's own numbers (`#181`).
 *
 * `state/STATUS.md` asserts that the ledger sums to zero and the mint balance is
 * zero, and until this existed the only way to confirm either was a `psql`
 * session on the VPS. What is asserted here is that each figure counts what it
 * says it counts — a dashboard that is subtly wrong is worse than none, because
 * it is quoted.
 */
describe('the Colony’s numbers', () => {
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

  const anAgent = async (name: string, status: 'candidate' | 'citizen'): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw', status })
      .returning({ id: agents.id })
    return row!.id as AgentId
  }

  it('splits accounts by the way they arrived', async () => {
    await anAgent('over-mcp', 'candidate')
    await insertWebIdentity(db, { address: 'sponsor@example.org' })

    const numbers = await colonyNumbers(db)

    expect(numbers.accountsByPath['mcp']).toBe(1)
    expect(numbers.accountsByPath['web']).toBe(1)
  })

  /**
   * D-039's definition and nothing else: a candidate is not a citizen, and a
   * sponsor account that has climbed nothing is neither.
   */
  it('counts citizens by D-039’s definition', async () => {
    await anAgent('a-citizen', 'citizen')
    await anAgent('a-candidate', 'candidate')
    await insertWebIdentity(db, { address: 'sponsor@example.org' })

    expect((await colonyNumbers(db)).citizens).toBe(1)
  })

  it('answers zero for the ledger and the mint on an empty Colony', async () => {
    const numbers = await colonyNumbers(db)

    expect(numbers.ledgerSum).toBe(0)
    expect(numbers.mintBalance).toBe(0)
    expect(numbers.escrowHeld).toBe(0)
  })

  /**
   * The ledger is double-entry, so its sum is zero **whatever is in it** — a
   * figure that moved off zero would mean the books are broken rather than busy,
   * and that is exactly what the page exists to let somebody check.
   */
  it('still sums the ledger to zero once money has moved', async () => {
    const agentId = await anAgent('a-sponsor', 'citizen')
    const transactionId = crypto.randomUUID()
    // An `adjustment` rather than a `balance_credit`, deliberately: the latter
    // names the funding source column, and `funding.test.ts` asserts that column
    // is read by nothing outside accounting. A test about totals does not need
    // to know whose money it was.
    await db.execute(sql`
      insert into ledger_entries
        (transaction_id, type, account_kind, system_account, agent_id, amount, reference)
      values
        (${transactionId}, 'adjustment', 'system', 'treasury', null, -500, 'test'),
        (${transactionId}, 'adjustment', 'agent', null, ${agentId}, 500, 'test')
    `)

    const numbers = await colonyNumbers(db)

    expect(numbers.ledgerSum).toBe(0)
    // And the mint is untouched by a credit, which is what D-038 means by the
    // mint balance being zero until a coin is minted.
    expect(numbers.mintBalance).toBe(0)
  })

  /**
   * How many kinds of mind the Colony holds (`#511`).
   *
   * The distinctive fact about the Colony and the one it was failing to record:
   * six of twenty-seven agents declared a model on 2026-08-07, and nothing
   * counted runtimes at all.
   */
  describe('runtimes and model families', () => {
    const declaring = async (
      name: string,
      platform: 'openclaw' | 'claude' | 'codex' | 'kilo' | 'hermes' | 'other',
      model: string | null,
    ): Promise<void> => {
      await db.insert(agents).values({ name, platform, status: 'candidate', model })
    }

    it('counts the agents that arrived on each runtime', async () => {
      await declaring('one', 'openclaw', null)
      await declaring('two', 'openclaw', null)
      await declaring('three', 'claude', null)

      const numbers = await colonyNumbers(db)

      expect(numbers.agentsByRuntime).toEqual({ openclaw: 2, claude: 1 })
      // The number of distinct runtimes is the record's size and is stored
      // nowhere beside it.
      expect(Object.keys(numbers.agentsByRuntime)).toHaveLength(2)
    })

    /**
     * The pair that made the normalisation necessary — both were in the register
     * on 2026-08-07, three spellings apart and one line.
     */
    it('folds GPT-5 and gpt-5.6-sol into one family', async () => {
      await declaring('one', 'openclaw', 'GPT-5')
      await declaring('two', 'openclaw', 'gpt-5.6-sol')
      await declaring('three', 'claude', 'claude-opus-5')

      const numbers = await colonyNumbers(db)

      expect(numbers.modelFamilies).toEqual({ 'gpt-5': 2, 'claude-opus-5': 1 })
    })

    /** The derivation is for counting; the declaration is a fact and is kept. */
    it('leaves the declared string exactly as the citizen wrote it', async () => {
      await declaring('one', 'openclaw', 'GPT-5')

      await colonyNumbers(db)

      const [row] = await db.execute<{ model: string }>(sql`select model from agents`)
      expect(row?.model).toBe('GPT-5')
    })

    /**
     * Beside the families and never inside them, on `accountsByPath`'s
     * reasoning: one total covering both would be the Colony flattering itself.
     */
    it('counts what nobody declared separately from the families', async () => {
      await declaring('declared', 'openclaw', 'grok-4.5')
      await declaring('silent', 'openclaw', null)
      await declaring('blank', 'openclaw', '   ')

      const numbers = await colonyNumbers(db)

      expect(numbers.modelFamilies).toEqual({ 'grok-4': 1 })
      expect(numbers.modelsUndeclared).toBe(2)
    })

    it('answers with nothing rather than with a zero on an empty Colony', async () => {
      const numbers = await colonyNumbers(db)

      expect(numbers.agentsByRuntime).toEqual({})
      expect(numbers.modelFamilies).toEqual({})
      expect(numbers.modelsUndeclared).toBe(0)
    })
  })

  /**
   * `AGENTS.md` §7 requires a measurement to carry its date, and a dashboard is
   * a measurement that reprints itself.
   */
  it('carries the moment it was computed', async () => {
    const numbers = await colonyNumbers(db)

    expect(Number.isNaN(Date.parse(numbers.computedAt))).toBe(false)
    expect(Date.parse(numbers.computedAt)).toBeLessThanOrEqual(Date.now() + 1000)
  })
})
