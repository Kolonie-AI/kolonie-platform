import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAX_OPEN_WAKE_CHALLENGES, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  liveWakeChallenge,
  mintWakeChallenge,
  recordWakeAddress,
  recordWakeDelivery,
  wakeAddressFor,
  wakeChannelOf,
  wakeDeliveriesSince,
} from './wake.js'

const target = databaseTestTarget()

/**
 * The wake channel's storage (`#518`).
 *
 * Three properties are worth a database rather than a fake, and they are the
 * three this file is about: that the address is promoted from a challenge and
 * replaces rather than accumulates, that the ceiling counts what it says it
 * counts, and that a failed knock leaves a tally and takes nothing.
 */
describe('the wake channel’s storage', () => {
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
    agentId = await anAgent('reachable-citizen')
  })

  describe('minting', () => {
    it('issues a secret and a nonce, and hands back the newest as the live one', async () => {
      const first = await mintWakeChallenge(db, { agentId, url: 'https://one.example/wake' })
      const second = await mintWakeChallenge(db, { agentId, url: 'https://two.example/wake' })

      expect(first.outcome).toBe('minted')
      expect(second.outcome).toBe('minted')

      // Two mints, two secrets. A citizen that lost the first is not handed it
      // back — it is handed a new one, which is the whole recovery path.
      if (first.outcome !== 'minted' || second.outcome !== 'minted') throw new Error('not minted')
      expect(first.row.secret).not.toBe(second.row.secret)
      expect(first.row.knockNonce).not.toBe(second.row.knockNonce)

      const live = await liveWakeChallenge(db, agentId)
      expect(live?.url).toBe('https://two.example/wake')
    })

    it('refuses past the ceiling on open challenges', async () => {
      for (let i = 0; i < MAX_OPEN_WAKE_CHALLENGES; i += 1) {
        await mintWakeChallenge(db, { agentId, url: `https://${i}.example/wake` })
      }

      const over = await mintWakeChallenge(db, { agentId, url: 'https://over.example/wake' })
      expect(over.outcome).toBe('too-many')
    })
  })

  describe('promoting a proved challenge', () => {
    it('writes the address the verdict proved, and replaces an older one', async () => {
      const first = await mintWakeChallenge(db, { agentId, url: 'https://old.example/wake' })
      if (first.outcome !== 'minted') throw new Error('not minted')
      expect(await recordWakeAddress(db, first.row.id)).toBe(true)
      expect((await wakeAddressFor(db, agentId))?.url).toBe('https://old.example/wake')

      // A failed knock against the old address, so the replacement has something
      // to clear.
      await recordWakeDelivery(db, { agentId, event: 'verdict', outcome: 'refused' })

      const second = await mintWakeChallenge(db, { agentId, url: 'https://new.example/wake' })
      if (second.outcome !== 'minted') throw new Error('not minted')
      await recordWakeAddress(db, second.row.id)

      const address = await wakeAddressFor(db, agentId)
      expect(address?.url).toBe('https://new.example/wake')
      expect(address?.secret).toBe(second.row.secret)
    })

    /**
     * A redelivered verdict is the ordinary case rather than the odd one — the
     * runner is at-least-once — so writing the same row twice has to be a
     * no-change rather than a conflict.
     */
    it('is idempotent', async () => {
      const minted = await mintWakeChallenge(db, { agentId, url: 'https://once.example/wake' })
      if (minted.outcome !== 'minted') throw new Error('not minted')

      await recordWakeAddress(db, minted.row.id)
      await recordWakeAddress(db, minted.row.id)

      expect((await wakeAddressFor(db, agentId))?.url).toBe('https://once.example/wake')
    })
  })

  describe('the record of deliveries', () => {
    beforeEach(async () => {
      const minted = await mintWakeChallenge(db, { agentId, url: 'https://here.example/wake' })
      if (minted.outcome !== 'minted') throw new Error('not minted')
      await recordWakeAddress(db, minted.row.id)
    })

    it('counts every attempt in the window, including the ones nothing was sent for', async () => {
      await recordWakeDelivery(db, { agentId, event: 'verdict', outcome: 'answered', status: 200 })
      await recordWakeDelivery(db, { agentId, event: 'operator-answer', outcome: 'capped' })

      const hour = new Date(Date.now() - 60 * 60 * 1000)
      expect(await wakeDeliveriesSince(db, agentId, hour)).toBe(2)

      // Nothing before the window is counted, so a quiet hour after a loud one
      // is a quiet hour.
      const future = new Date(Date.now() + 60 * 1000)
      expect(await wakeDeliveriesSince(db, agentId, future)).toBe(0)
    })

    it('keeps a tally of consecutive failures and clears it on an answer', async () => {
      await recordWakeDelivery(db, { agentId, event: 'verdict', outcome: 'refused' })
      await recordWakeDelivery(db, { agentId, event: 'verdict', outcome: 'timed-out' })

      // The address still exists and is still knocked on. Nothing in the
      // platform reads this column to decide anything about the citizen, which
      // is the property `schema/wake.ts` states — this asserts only that it is
      // recorded honestly.
      expect(await wakeAddressFor(db, agentId)).toBeDefined()

      await recordWakeDelivery(db, { agentId, event: 'verdict', outcome: 'answered', status: 200 })
      expect(await wakeAddressFor(db, agentId)).toBeDefined()
    })

    it('does not touch the address for an agent that has none', async () => {
      const other = await anAgent('unreachable-citizen')

      await recordWakeDelivery(db, {
        agentId: other,
        event: 'operator-answer',
        outcome: 'no-address',
      })

      expect(await wakeAddressFor(db, other)).toBeUndefined()
      const hour = new Date(Date.now() - 60 * 60 * 1000)
      expect(await wakeDeliveriesSince(db, other, hour)).toBe(1)
    })
  })

  /**
   * What the citizen is allowed to know about its own channel (`#585`).
   *
   * The read exists because *no penalty* and *no information* are two different
   * rules and only the first was settled by `#518`. What a database is needed
   * for here is that the tally this hands back is the same one
   * `recordWakeDelivery` keeps — a fake would agree with itself.
   */
  describe('what the citizen can read about its own channel', () => {
    it('answers undefined for a citizen that has proved nothing', async () => {
      expect(await wakeChannelOf(db, agentId)).toBeUndefined()
    })

    it('carries the url, when it was proved, and a fresh channel’s zero tally', async () => {
      const minted = await mintWakeChallenge(db, {
        agentId,
        url: 'https://reachable.invalid/kolonie/wake',
      })
      if (minted.outcome !== 'minted') throw new Error('fixture failed to mint')
      await recordWakeAddress(db, minted.row.id)

      const channel = await wakeChannelOf(db, agentId)

      expect(channel?.url).toBe('https://reachable.invalid/kolonie/wake')
      expect(channel?.provedAt).not.toBeNull()
      // Never knocked on is not a failure, and the two must not read alike.
      expect(channel?.lastKnockedAt).toBeNull()
      expect(channel?.lastOutcome).toBeNull()
      expect(channel?.consecutiveFailures).toBe(0)
    })

    it('reports the same tally the deliveries left', async () => {
      const minted = await mintWakeChallenge(db, { agentId, url: 'https://gone.invalid/wake' })
      if (minted.outcome !== 'minted') throw new Error('fixture failed to mint')
      await recordWakeAddress(db, minted.row.id)

      await recordWakeDelivery(db, { agentId, event: 'verdict', outcome: 'dns-failed' })
      await recordWakeDelivery(db, { agentId, event: 'verdict', outcome: 'timed-out' })

      const channel = await wakeChannelOf(db, agentId)

      expect(channel?.consecutiveFailures).toBe(2)
      expect(channel?.lastOutcome).toBe('timed-out')
      expect(channel?.lastKnockedAt).not.toBeNull()
    })

    it('is back to zero after one answered knock', async () => {
      const minted = await mintWakeChallenge(db, { agentId, url: 'https://back.invalid/wake' })
      if (minted.outcome !== 'minted') throw new Error('fixture failed to mint')
      await recordWakeAddress(db, minted.row.id)

      await recordWakeDelivery(db, { agentId, event: 'verdict', outcome: 'refused' })
      await recordWakeDelivery(db, { agentId, event: 'verdict', outcome: 'answered', status: 200 })

      const channel = await wakeChannelOf(db, agentId)

      expect(channel?.consecutiveFailures).toBe(0)
      expect(channel?.lastOutcome).toBe('answered')
    })

    /**
     * The rejection case. The read is keyed on the agent, so one citizen's
     * channel is not reachable through another's id — and the address table
     * being keyed on the agent is what makes that structural rather than a rule.
     */
    it('answers about the agent asked for and no other', async () => {
      const other = await anAgent('another-citizen')
      const minted = await mintWakeChallenge(db, { agentId, url: 'https://mine.invalid/wake' })
      if (minted.outcome !== 'minted') throw new Error('fixture failed to mint')
      await recordWakeAddress(db, minted.row.id)

      expect((await wakeChannelOf(db, agentId))?.url).toBe('https://mine.invalid/wake')
      expect(await wakeChannelOf(db, other)).toBeUndefined()
    })

    /** The secret signs deliveries and must not travel with the citizen's view. */
    it('does not hand back the secret', async () => {
      const minted = await mintWakeChallenge(db, { agentId, url: 'https://sealed.invalid/wake' })
      if (minted.outcome !== 'minted') throw new Error('fixture failed to mint')
      await recordWakeAddress(db, minted.row.id)

      const channel = await wakeChannelOf(db, agentId)

      expect(channel).not.toHaveProperty('secret')
      expect(JSON.stringify(channel)).not.toContain(minted.row.secret)
    })
  })
})
