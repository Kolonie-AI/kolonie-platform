import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  RegisterAgentRequestSchema,
  type AgentId,
  measuredOnlyRecipes,
} from '@kolonie-ai/core'
import type { Database } from './client.js'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'
import { registerAgent } from './storage/agents.js'
import { atlasFigures } from './storage/atlas-figures.js'

const target = databaseTestTarget()
const PHONE = AccountKindSchema.parse('phone')

/**
 * A provider a citizen proved an account at reaches the shelf (`#977`).
 *
 * **Against a real Postgres, because the defect lived in the seam and not in
 * either side of it.** `measuredOnlyRecipes` is unit-tested and was correct
 * about the row it builds; `atlasFigures` is unit-tested and was correct about
 * the floor. What nothing tested was the shape one hands the other: suppression
 * *zeroes* the counts rather than flagging them, so the emptiness guard on the
 * receiving side dropped every suppressed pair — and since no provider sample in
 * the Colony has ever reached the floor of 5, that was every measured pair there
 * has ever been. A test that faked the figures could not have found it, because
 * faking them is exactly what got the shape wrong.
 */
describe('a provider with a proof and no entry', () => {
  let db: Database
  let seeded = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const citizen = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `${name}-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)

    return result.agent.id
  }

  /** A citizen holding a proved account at a provider nobody has written up. */
  const proved = async (name: string, provider: string, identifier: string): Promise<AgentId> => {
    const agentId = await citizen(name)

    await db.execute(sql`
      insert into accounts (agent_id, kind, identifier, provider, proved, proved_at)
      values (${agentId}, ${PHONE}, ${identifier}, ${provider}, true, now())
    `)

    return agentId
  }

  /** The wall that citizen ran into, in the words the moderator cleared. */
  const wall = async (name: string, provider: string, scrubbed: string): Promise<AgentId> => {
    const agentId = await citizen(name)

    await db.execute(sql`
      insert into provider_reports (agent_id, kind, provider, outcome, reason, scrubbed_reason, reason_status)
      values (${agentId}, ${PHONE}, ${provider}, 'signup-refused', ${scrubbed}, ${scrubbed}, 'approved')
    `)

    return agentId
  }

  const shelf = async () => measuredOnlyRecipes([], await atlasFigures(db))

  /**
   * The case `#977` was found by, in as many words: one citizen, one proof, one
   * provider the catalogue has never heard of.
   */
  it('reaches the shelf on a single proof, below the floor', async () => {
    await proved('walker', 'agentmessage.io', '+15550000001')

    const rows = await shelf()

    expect(rows.map((one) => one.provider)).toEqual(['agentmessage.io'])
    expect(rows[0]?.kind).toBe(PHONE)
    /** `measured` and not `unwritten`: the row's content is that a citizen got in. */
    expect(rows[0]?.status).toBe('measured')
    expect(rows[0]?.category).toBe('telephony')
  })

  /**
   * **The counts do not come with it.** Raising a provider onto the shelf is a
   * fact about the provider; the numbers behind it are a claim about one
   * citizen, and the floor goes on withholding them inside the figures exactly
   * as it does for the curated entry beside this one.
   */
  it('carries the row without carrying the count', async () => {
    await proved('walker', 'agentmessage.io', '+15550000001')

    const figures = (await atlasFigures(db)).find((one) => one.provider === 'agentmessage.io')

    expect(figures?.suppressed).toBe(true)
    expect(figures?.attempted).toBe(0)
    expect(figures?.proved).toBe(0)
    /** Computed from the unfloored counts, so the reader still learns the shape. */
    expect(figures?.band).not.toBeNull()
  })

  /**
   * The Definition of Done, asserted rather than reasoned about: **no identity
   * crosses from `accounts.providers` to `accounts.recipes`.** `provider_reports`
   * is *counted, never listed*, and the shelf is the place a leak would be least
   * visible — a synthesised row is the one row nobody curated and nobody reads
   * before it is served.
   */
  it('carries no identity from the register onto the shelf', async () => {
    const holder = await proved('quiet-holder', 'agentmessage.io', '+15550000001')
    const reporter = await wall(
      'quiet-reporter',
      'agentmessage.io',
      'Homepage says new signups are paused; only waitlist available.',
    )

    const figures = await atlasFigures(db)
    const served = JSON.stringify({ figures, rows: await shelf() })

    expect(served).not.toContain(holder)
    expect(served).not.toContain(reporter)
    expect(served).not.toContain('quiet-holder')
    expect(served).not.toContain('quiet-reporter')
    /** The number itself is an identifier, and it is the one a phone kind holds. */
    expect(served).not.toContain('+15550000001')
    /** What does cross is the wall, which is a sentence about the provider. */
    expect(served).toContain('signups are paused')
  })

  /**
   * A pair nobody has been to is still not evidence, and the fix does not turn
   * the shelf into a list of every provider a report ever mentioned in passing:
   * the row comes from the figures, and the figures come from a citizen.
   */
  it('leaves the shelf alone where nobody has been at all', async () => {
    expect(await shelf()).toEqual([])
  })

  /**
   * **A declaration is not a walk**, and this is the case that decided the guard
   * asks `evidenced` rather than `suppressed` (`#977`). An account a citizen
   * wrote down with `kolonie.accounts.declare` and never proved counts in
   * `attempted`, so a guard reading suppression alone would put a `measured`
   * entry on the shelf for a provider nobody has demonstrably reached —
   * reporting an intention as an outcome, which is what `#906` refused for the
   * backfill.
   */
  it('stands nothing in for a provider a citizen only declared', async () => {
    const agentId = await citizen('declarer')

    await db.execute(sql`
      insert into accounts (agent_id, kind, identifier, provider, proved)
      values (${agentId}, ${PHONE}, ${'+15550000009'}, 'declared-only.test', false)
    `)

    const figures = (await atlasFigures(db)).find((one) => one.provider === 'declared-only.test')

    /** The pair exists in the figures — a citizen is behind it — and is not evidence. */
    expect(figures).toBeDefined()
    expect(figures?.evidenced).toBe(false)
    expect(await shelf()).toEqual([])
  })

  /**
   * The other half of the same rule: a citizen who filed a report got far enough
   * to have something to say about the provider, so a wall is evidence even
   * where nobody got in.
   */
  it('reaches the shelf on a wall alone, with nobody through', async () => {
    await wall('blocked', 'nowhere.test', 'Homepage says new signups are paused.')

    const rows = await shelf()

    expect(rows.map((one) => one.provider)).toEqual(['nowhere.test'])
    expect(rows[0]?.status).toBe('measured')
  })

  /**
   * **The gap was never about `phone`.** It was a guard on a shape, so it
   * dropped every kind equally — which is why the fix is not a telephony one.
   */
  it('does the same for a kind that is not the one it was found on', async () => {
    const agentId = await citizen('mailbox-walker')
    const mailbox = AccountKindSchema.parse('mailbox')

    await db.execute(sql`
      insert into accounts (agent_id, kind, identifier, provider, proved, proved_at)
      values (${agentId}, ${mailbox}, ${'quiet@somewhere.test'}, 'somewhere.test', true, now())
    `)

    const rows = await shelf()

    expect(rows.map((one) => one.provider)).toEqual(['somewhere.test'])
    expect(rows[0]?.category).toBe('mailbox')
  })

  /** A provider the catalogue already has is left to the catalogue. */
  it('stands nothing in for a provider the catalogue already carries', async () => {
    await proved('walker', 'agentmessage.io', '+15550000001')

    const already = await shelf()

    expect(measuredOnlyRecipes(already, await atlasFigures(db))).toEqual([])
  })
})
