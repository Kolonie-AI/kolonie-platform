import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RegisterAgentRequestSchema, now as currentTime, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  countSmsSentInTotal,
  countSmsSentToAgent,
  countSmsSentToCountry,
  recordSmsSend,
  smsSentByCountry,
} from './sms.js'

const target = databaseTestTarget()

/**
 * The Colony's record of what SMS has cost it, and where it went (`#409`,
 * `#616`).
 *
 * The country is the column `#616` added and it is the one that makes SMS
 * pumping visible: the attack drives traffic at one destination, so *how many
 * went to one country today* is the question that tells it from ordinary use.
 */
describe('the SMS spend record', () => {
  let db: Database
  let agentId: AgentId
  let otherId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await register('caller')
    otherId = await register('bystander')
  })

  const register = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  /**
   * One recorded send.
   *
   * **The number is a documentation range** — `+99900000001` — because `#616`'s
   * definition of done says no phone number appears in a fixture, and a real
   * range in a test file is a real person's number to somebody reading it later.
   */
  let sequence = 0
  const sent = async (options: {
    readonly agent?: AgentId
    readonly country?: string | null
    readonly at?: string
  }) => {
    sequence += 1
    await recordSmsSend(db, {
      agentId: options.agent ?? agentId,
      to: `+9990000${String(sequence).padStart(4, '0')}`,
      vendorId: `SM${String(sequence).padStart(6, '0')}`,
      priceAmount: null,
      priceCurrency: null,
      country: options.country === undefined ? 'DE' : options.country,
      sentAt: (options.at ?? currentTime()) as never,
    })
  }

  const anHourAgo = () => new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const twoDaysAgo = () => new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

  it('counts one country’s share without counting another’s', async () => {
    await sent({ country: 'DE' })
    await sent({ country: 'DE', agent: otherId })
    await sent({ country: 'NG' })

    expect(await countSmsSentToCountry(db, 'DE', anHourAgo() as never)).toBe(2)
    expect(await countSmsSentToCountry(db, 'NG', anHourAgo() as never)).toBe(1)
  })

  /**
   * The ceiling bounds a day, not for ever. A citizen refused today has to be
   * able to try tomorrow, which is the same window every other count here uses.
   */
  it('does not count what fell out of the window', async () => {
    await sent({ country: 'DE', at: twoDaysAgo() })

    expect(await countSmsSentToCountry(db, 'DE', anHourAgo() as never)).toBe(0)
    expect(await countSmsSentInTotal(db, anHourAgo() as never)).toBe(0)
  })

  /** The ISO code is stored one way, so a caller's casing cannot split a country in two. */
  it('answers the same for either casing', async () => {
    await sent({ country: 'de' })

    expect(await countSmsSentToCountry(db, 'DE', anHourAgo() as never)).toBe(1)
    expect(await countSmsSentToCountry(db, 'de', anHourAgo() as never)).toBe(1)
  })

  /**
   * The rejection case, and the one that must not be modelled as zero. A send
   * whose country the carrier could not name happened and cost money: it counts
   * toward the Colony's total and toward no country's ceiling.
   */
  it('counts an unnamed destination in the total and against no country', async () => {
    await sent({ country: null })

    expect(await countSmsSentInTotal(db, anHourAgo() as never)).toBe(1)
    expect(await countSmsSentToCountry(db, 'DE', anHourAgo() as never)).toBe(0)
    expect(await countSmsSentToAgent(db, agentId, anHourAgo() as never)).toBe(1)
  })

  it('reports a period by country, busiest first, naming the unnamed', async () => {
    await sent({ country: 'NG' })
    await sent({ country: 'NG', agent: otherId })
    await sent({ country: 'DE' })
    await sent({ country: null })

    const rows = await smsSentByCountry(db, anHourAgo() as never, currentTime())

    expect(rows).toEqual([
      { country: 'NG', sent: 2 },
      { country: 'DE', sent: 1 },
      { country: 'unknown', sent: 1 },
    ])
  })
})
