import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ATLAS_FIGURE_FLOOR,
  ATLAS_RETENTION_DAYS,
  AccountKindSchema,
  RegisterAgentRequestSchema,
  type AgentId,
} from '@kolonie-ai/core'
import { sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { atlasFigures } from './atlas-figures.js'
import { registerAgent } from './agents.js'

const target = databaseTestTarget()
const kind = AccountKindSchema.parse('mailbox')

/**
 * What the Colony measured about a provider (`#545`).
 *
 * Against a real Postgres, because the whole of the issue is a query: whether
 * the floor suppresses in SQL, whether a count is of citizens rather than of
 * rows, and whether the retention figure asks about accounts old enough to ask
 * about are all properties of the statement and of nothing else.
 */
describe('the measured figures behind an Atlas entry', () => {
  let db: Database

  let seeded = 0

  const citizen = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `${name}-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)

    return result.agent.id
  }

  /** A citizen holding an account here, proved or not, and how long ago. */
  const holds = async (input: {
    readonly name: string
    readonly provider: string
    readonly proved?: boolean
    readonly provedDaysAgo?: number
    readonly hoursToProve?: number
    readonly status?: 'in-use' | 'retired' | 'lost'
  }) => {
    const agentId = await citizen(input.name)
    const proved = input.proved ?? true
    const daysAgo = input.provedDaysAgo ?? 0
    const hours = input.hoursToProve ?? 1

    await db.execute(sql`
      insert into accounts (agent_id, kind, identifier, provider, proved, proved_at, created_at, status)
      values (
        ${agentId}, ${kind}, ${`${input.name}@example.test`}, ${input.provider}, ${proved},
        ${proved ? sql`now() - (${sql.raw(String(daysAgo))} * interval '1 day')` : sql`null`},
        now() - (${sql.raw(String(daysAgo))} * interval '1 day')
          - (${sql.raw(String(hours))} * interval '1 hour'),
        ${input.status ?? 'in-use'}
      )
    `)
  }

  /** A citizen saying it did not get one. */
  const reported = async (input: {
    readonly name: string
    readonly provider: string
    readonly outcome: string
    readonly scrubbed?: string
  }) => {
    const agentId = await citizen(input.name)

    await db.execute(sql`
      insert into provider_reports (agent_id, kind, provider, outcome, reason, scrubbed_reason, reason_status)
      values (${agentId}, ${kind}, ${input.provider}, ${sql.raw(`'${input.outcome}'`)},
              ${input.scrubbed ?? null}, ${input.scrubbed ?? null}, 'approved')
    `)
  }

  const only = async (provider: string) =>
    (await atlasFigures(db)).find((one) => one.provider === provider)

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  /**
   * **Attempted is a union of two tables**, because that is what the Colony
   * genuinely knows: who ended up holding something, and who said they did not.
   */
  it('counts everyone who tried, whether or not they got through', async () => {
    for (let i = 0; i < 4; i++) await holds({ name: `held-${i}`, provider: 'mail.tm' })
    for (let i = 0; i < 3; i++)
      await reported({ name: `gave-up-${i}`, provider: 'mail.tm', outcome: 'abandoned' })

    const figures = await only('mail.tm')

    expect(figures?.attempted).toBe(7)
    expect(figures?.proved).toBe(4)
  })

  it('counts a citizen once however many rows it has', async () => {
    await holds({ name: 'twice', provider: 'mail.tm' })
    await db.execute(sql`
      insert into accounts (agent_id, kind, identifier, provider, proved, proved_at)
      select agent_id, ${kind}, 'second@example.test', 'mail.tm', true, now() from accounts limit 1
    `)
    for (let i = 0; i < 4; i++) await holds({ name: `other-${i}`, provider: 'mail.tm' })

    expect((await only('mail.tm'))?.attempted).toBe(5)
  })

  /**
   * **Where they stopped is the number a provider actually pays attention to**,
   * and the four outcomes are the steps the Colony records rather than an
   * invented breakdown.
   */
  it('says where they stopped, by outcome, and what they said', async () => {
    for (let i = 0; i < 3; i++)
      await reported({
        name: `refused-${i}`,
        provider: 'walled.test',
        outcome: 'signup-refused',
        scrubbed: 'The form rejects an honest answer to are-you-human.',
      })
    for (let i = 0; i < 2; i++)
      await reported({ name: `nothing-${i}`, provider: 'walled.test', outcome: 'no-service' })

    const figures = await only('walled.test')

    expect(figures?.refused).toBe(3)
    expect(figures?.stopped).toEqual(
      expect.arrayContaining([
        { outcome: 'signup-refused', citizens: 3 },
        { outcome: 'no-service', citizens: 2 },
      ]),
    )
    expect(figures?.reasons).toContain('The form rejects an honest answer to are-you-human.')
  })

  /** Unmoderated words never reach a reader, so a reason nothing approved is absent. */
  it('never publishes a reason the moderator has not approved', async () => {
    for (let i = 0; i < 5; i++)
      await reported({ name: `quiet-${i}`, provider: 'quiet.test', outcome: 'abandoned' })

    expect((await only('quiet.test'))?.reasons).toEqual([])
  })

  it('gives the median hours to proof, not the mean', async () => {
    await holds({ name: 'fast-1', provider: 'quick.test', hoursToProve: 1 })
    await holds({ name: 'fast-2', provider: 'quick.test', hoursToProve: 1 })
    await holds({ name: 'middle', provider: 'quick.test', hoursToProve: 2 })
    await holds({ name: 'slow-1', provider: 'quick.test', hoursToProve: 3 })
    // One citizen who came back three weeks later must not decide the figure.
    await holds({ name: 'slow-2', provider: 'quick.test', hoursToProve: 500 })

    expect((await only('quick.test'))?.medianHoursToProof).toBe(2)
  })

  /**
   * **The figure that makes the rest trustworthy.** A signup reversed a week
   * later is not a success, and only accounts old enough to ask about count
   * toward the base.
   */
  describe(`what is still held after ${ATLAS_RETENTION_DAYS} days`, () => {
    it('counts only accounts old enough to ask about', async () => {
      for (let i = 0; i < 3; i++)
        await holds({
          name: `kept-${i}`,
          provider: 'sticky.test',
          provedDaysAgo: ATLAS_RETENTION_DAYS + 5,
        })
      await holds({
        name: 'dropped',
        provider: 'sticky.test',
        provedDaysAgo: ATLAS_RETENTION_DAYS + 5,
        status: 'lost',
      })
      // Proved yesterday: nothing can yet be said about it, so it is in neither number.
      await holds({ name: 'brand-new', provider: 'sticky.test', provedDaysAgo: 1 })

      const figures = await only('sticky.test')

      expect(figures?.heldLongEnoughToAsk).toBe(4)
      expect(figures?.stillHeld).toBe(3)
    })

    it('says nothing rather than zero while nothing is old enough', async () => {
      for (let i = 0; i < 5; i++)
        await holds({ name: `new-${i}`, provider: 'fresh.test', provedDaysAgo: 1 })

      const figures = await only('fresh.test')

      expect(figures?.heldLongEnoughToAsk).toBe(0)
      expect(figures?.stillHeld).toBeNull()
    })
  })

  describe('the floor', () => {
    /**
     * `#147`: *"no aggregate may be reducible to a single citizen."* A provider
     * two citizens attempted is a fact about those two, however the row is
     * phrased.
     */
    it('suppresses a row below it, and says that it did', async () => {
      await holds({ name: 'lonely', provider: 'rare.test' })

      const figures = await only('rare.test')

      expect(figures?.suppressed).toBe(true)
      expect(figures?.attempted).toBe(0)
      expect(figures?.proved).toBe(0)
      expect(figures?.reasons).toEqual([])
    })

    it('publishes a row that clears it', async () => {
      for (let i = 0; i < ATLAS_FIGURE_FLOOR; i++)
        await holds({ name: `common-${i}`, provider: 'busy.test' })

      const figures = await only('busy.test')

      expect(figures?.suppressed).toBe(false)
      expect(figures?.attempted).toBe(ATLAS_FIGURE_FLOOR)
    })

    /**
     * A provider sees its own numbers in full, because that is what it is buying
     * — and it sees **its own**. Passing the audience without naming a provider
     * must not open the unfloored whole catalogue.
     */
    it('does not apply to a provider reading its own entry', async () => {
      await holds({ name: 'lonely', provider: 'rare.test' })

      const [figures] = await atlasFigures(db, { audience: 'provider', provider: 'rare.test' })

      expect(figures?.suppressed).toBe(false)
      expect(figures?.attempted).toBe(1)
    })

    it('still applies when a provider audience names nobody', async () => {
      await holds({ name: 'lonely', provider: 'rare.test' })

      expect((await atlasFigures(db, { audience: 'provider' }))[0]?.suppressed).toBe(true)
    })

    /**
     * **The band survives the floor because it is read before the floor runs**
     * (`#792`). Off the zeroed row a lone walk that succeeded would band as *few
     * got through* — a claim about the provider the Colony has not measured —
     * and the entry page would print the opposite of what happened.
     */
    it('bands a suppressed row from the counts it is not publishing', async () => {
      await holds({ name: 'lonely', provider: 'rare.test' })

      const figures = await only('rare.test')

      expect(figures?.suppressed).toBe(true)
      expect(figures?.attempted).toBe(0)
      expect(figures?.band).toBe('most-got-through')
    })

    /** And where the walk stopped, for the same reason and out of the same counts. */
    it('names a suppressed row’s commonest stop', async () => {
      await reported({ name: 'walled', provider: 'rare.test', outcome: 'signup-refused' })
      await reported({ name: 'gave-up', provider: 'rare.test', outcome: 'abandoned' })
      await reported({ name: 'walled-too', provider: 'rare.test', outcome: 'signup-refused' })

      const figures = await only('rare.test')

      expect(figures?.suppressed).toBe(true)
      expect(figures?.stopped).toEqual([])
      expect(figures?.commonestStop).toBe('signup-refused')
    })

    it('gives a provider audience only the provider it named', async () => {
      await holds({ name: 'one', provider: 'rare.test' })
      await holds({ name: 'two', provider: 'other.test' })

      const rows = await atlasFigures(db, { audience: 'provider', provider: 'rare.test' })

      expect(rows.map((one) => one.provider)).toEqual(['rare.test'])
    })
  })

  /**
   * A poor number is published like any other. There is no code path that hides
   * one, and this is the test that would fail if somebody added it.
   */
  it('publishes a bad result exactly as it publishes a good one', async () => {
    for (let i = 0; i < 10; i++)
      await reported({ name: `stuck-${i}`, provider: 'hopeless.test', outcome: 'signup-refused' })

    const figures = await only('hopeless.test')

    expect(figures?.attempted).toBe(10)
    expect(figures?.proved).toBe(0)
    expect(figures?.suppressed).toBe(false)
  })

  it('names no citizen in anything it returns', async () => {
    for (let i = 0; i < 6; i++) await holds({ name: `someone-${i}`, provider: 'mail.tm' })

    const serialised = JSON.stringify(await atlasFigures(db))

    expect(serialised).not.toContain('someone-')
    expect(serialised).not.toContain('@example.test')
  })
})
