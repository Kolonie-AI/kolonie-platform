import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PERMISSION_AGGREGATE_FLOOR, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accounts, agents } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { holdingCounts } from './population.js'

const target = databaseTestTarget()

/**
 * How many citizens hold a proved account of a kind (#524).
 *
 * **Every test here is about what is left out.** The count itself is a `group
 * by`; what decides whether this figure is safe to answer a stranger with is the
 * floor, the opt-out, and the fact that nothing in the module can be asked to
 * narrow.
 */
describe('sizing the population', () => {
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

  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id as AgentId
  }

  /** One account, proved and available unless told otherwise. */
  const holding = async (
    label: string,
    kind: string,
    over: {
      readonly proved?: boolean
      readonly status?: 'in-use' | 'retired' | 'lost'
      readonly forWork?: boolean
    } = {},
  ): Promise<void> => {
    const agentId = await anAgent(label)
    const proved = over.proved ?? true

    await db.insert(accounts).values({
      agentId,
      kind,
      identifier: `${label}@example.test`,
      proved,
      // The table refuses a proved row with no date, and the other way round.
      provedAt: proved ? new Date().toISOString() : null,
      status: over.status ?? 'in-use',
      forWork: over.forWork ?? true,
    })
  }

  /** Enough of them to clear the floor. */
  const aCrowdHolding = async (kind: string, howMany: number): Promise<void> => {
    for (let i = 0; i < howMany; i += 1) await holding(`${kind}-${String(i)}`, kind)
  }

  it('counts citizens per kind, largest first', async () => {
    await aCrowdHolding('mailbox', 8)
    await aCrowdHolding('github', 5)

    expect(await holdingCounts(db)).toEqual([
      { kind: 'mailbox', citizens: 8 },
      { kind: 'github', citizens: 5 },
    ])
  })

  /**
   * `#524`: *"A floor below which nothing is reported."* Reported small is worse
   * than not reported: a number small enough to name three agents is a number
   * about three agents.
   */
  it('reports nothing at all about a kind below the floor', async () => {
    await aCrowdHolding('domain', PERMISSION_AGGREGATE_FLOOR - 1)

    expect(await holdingCounts(db)).toEqual([])
  })

  it('leaves out an account a citizen marked as not for work', async () => {
    await aCrowdHolding('mailbox', PERMISSION_AGGREGATE_FLOOR)
    await holding('opted-out', 'mailbox', { forWork: false })

    // The opted-out citizen is not inventory, so the count is the crowd's.
    expect(await holdingCounts(db)).toEqual([
      { kind: 'mailbox', citizens: PERMISSION_AGGREGATE_FLOOR },
    ])
  })

  it('leaves out what has only been declared', async () => {
    await aCrowdHolding('mailbox', PERMISSION_AGGREGATE_FLOOR)
    await holding('claimed-only', 'mailbox', { proved: false })

    expect(await holdingCounts(db)).toEqual([
      { kind: 'mailbox', citizens: PERMISSION_AGGREGATE_FLOOR },
    ])
  })

  it('leaves out an account that is retired or lost', async () => {
    await aCrowdHolding('mailbox', PERMISSION_AGGREGATE_FLOOR)
    await holding('gone', 'mailbox', { status: 'retired' })
    await holding('missing', 'mailbox', { status: 'lost' })

    expect(await holdingCounts(db)).toEqual([
      { kind: 'mailbox', citizens: PERMISSION_AGGREGATE_FLOOR },
    ])
  })

  /**
   * The privacy rule as a property of the module's surface rather than of a
   * filter somebody has to remember: there is nothing here that returns a row
   * about a citizen, and this asserts the shape that is returned instead.
   */
  it('answers in counts and carries nothing that could name anybody', async () => {
    await aCrowdHolding('mailbox', 6)

    const counts = await holdingCounts(db)
    expect(Object.keys(counts[0] ?? {}).sort()).toEqual(['citizens', 'kind'])
    expect(JSON.stringify(counts)).not.toContain('@example.test')
  })
})
