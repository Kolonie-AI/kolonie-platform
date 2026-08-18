import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { HANDOVER_MAX_READS, RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accountSlots, agents, humanAgents, humans } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  destroyExpiredHandovers,
  handoversFor,
  openHandover,
  readHandoverAsOperator,
} from './agent-handovers.js'

const target = databaseTestTarget()

/** Any 32 bytes. Never a real key, and never a real secret in this file. */
const SEALING_KEY = 'a-test-sealing-key-that-is-long-enough'

/**
 * The agent → operator secret channel (`#592`).
 *
 * The decision it rests on is in `kolonie-docs`; what is asserted here is the
 * four constraints that make it safe. The one that carries the most weight is
 * negative: **there is no read path that takes a token**, so a leaked
 * operator-page link cannot reach a password.
 */
describe('a secret an agent seals for its operator', () => {
  let db: Database
  let agentId: AgentId
  let humanId: string

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await register('sealer')
    humanId = await aPerson()
    await db.insert(humanAgents).values({ humanId, agentId })
  })

  const register = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const aPerson = async (): Promise<string> => {
    const [row] = await db.insert(humans).values({}).returning({ id: humans.id })
    if (row === undefined) throw new Error('inserting a person returned no row')
    return row.id
  }

  /**
   * A value that is obviously not anybody's credential.
   *
   * `#592`'s definition of done says no secret in a fixture, and this is how
   * that is kept: the string names itself.
   */
  const VALUE = 'not-a-real-password-0000'

  /**
   * The row behind a handover, read past the storage functions on purpose.
   *
   * What is asserted through this is what no exported function offers and none
   * should: that the ciphertext is gone and that the row says when. Since `#955`
   * the row lives in `account_slots`, so the aliases restore the handover's own
   * vocabulary — `value` was `sealed_value` — and every assertion below stayed
   * as it was written.
   */
  const handoverRow = async (id: string) => {
    const [row] = await db
      .select({ sealedValue: accountSlots.value, destroyedAt: accountSlots.destroyedAt })
      .from(accountSlots)
      .where(eq(accountSlots.id, id))

    return row
  }

  const sealed = async (value = VALUE) => {
    const opened = await openHandover(
      db,
      { agentId, provider: 'github.com', prompt: 'Your agent chose this.', value },
      SEALING_KEY,
    )
    if (opened.outcome !== 'opened') throw new Error(opened.outcome)
    return opened
  }

  it('is readable by the person who operates the agent, and says how many reads are left', async () => {
    const opened = await sealed()

    const read = await readHandoverAsOperator(db, opened.id, humanId, SEALING_KEY)

    expect(read).toMatchObject({
      outcome: 'read',
      value: VALUE,
      provider: 'github.com',
      readsLeft: HANDOVER_MAX_READS - 1,
    })
  })

  /**
   * **The property the whole channel rests on.** The row carries no token column
   * and no function here takes one, so a leaked operator-page link — which never
   * expires and was already found rendered into console HTML (`#587`) — cannot
   * reach this. Asserted against the stored columns rather than against the
   * code, because a check somebody can forget is not a guarantee.
   *
   * **This is the one assertion `#955` had to rewrite.** The merged table does
   * have a `token_hash`, because the drop is reached by a mailed link and needs
   * one; the absence of the column was standing in for the absence of a token.
   * So the property is now asserted directly: a handover carries no token hash,
   * and the token lookup that could spend one narrows on `channel = 'drop'`
   * before it looks at anything. Nothing about the guarantee moved — what moved
   * is that it is now stated rather than inferred from a table's shape.
   */
  it('has nowhere for a token to be, so no bearer link can read it', async () => {
    const opened = await sealed()

    const [row] = await db.select().from(accountSlots).where(eq(accountSlots.id, opened.id))

    expect(row?.channel).toBe('handover')
    expect(row?.tokenHash).toBeNull()
  })

  /** Sealed at rest: the value is nowhere in the row in a form anybody can read. */
  it('is never stored in the clear', async () => {
    const opened = await sealed()

    const [row] = await db.select().from(accountSlots).where(eq(accountSlots.id, opened.id))

    expect(row?.value).not.toBeNull()
    expect(JSON.stringify(row)).not.toContain(VALUE)
  })

  /** The first rejection case: not this person's agent, answered as though it never existed. */
  it('refuses somebody who does not operate the agent, without saying so', async () => {
    const opened = await sealed()
    const stranger = await aPerson()

    expect(await readHandoverAsOperator(db, opened.id, stranger, SEALING_KEY)).toEqual({
      outcome: 'closed',
    })
    // And the read was not spent by the attempt.
    expect(await readHandoverAsOperator(db, opened.id, humanId, SEALING_KEY)).toMatchObject({
      readsLeft: HANDOVER_MAX_READS - 1,
    })
  })

  /**
   * The second. A person double-clicks, hits back and loses tabs — so it is a
   * count and not a single read — but the count binds, and the last read
   * destroys the value in the same statement rather than leaving it for a sweep.
   */
  it('is destroyed by its own last read, and refuses the one after', async () => {
    const opened = await sealed()

    for (let read = 1; read < HANDOVER_MAX_READS; read += 1) {
      expect((await readHandoverAsOperator(db, opened.id, humanId, SEALING_KEY)).outcome).toBe(
        'read',
      )
    }
    const last = await readHandoverAsOperator(db, opened.id, humanId, SEALING_KEY)

    expect(last).toMatchObject({ outcome: 'read', readsLeft: 0 })
    expect(await readHandoverAsOperator(db, opened.id, humanId, SEALING_KEY)).toEqual({
      outcome: 'closed',
    })

    const row = await handoverRow(opened.id)
    expect(row?.sealedValue).toBeNull()
    expect(row?.destroyedAt).not.toBeNull()
  })

  it('stops being readable when its hours have passed, whether or not anybody read it', async () => {
    const opened = await sealed()
    await db
      .update(accountSlots)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(accountSlots.id, opened.id))

    expect(await readHandoverAsOperator(db, opened.id, humanId, SEALING_KEY)).toEqual({
      outcome: 'closed',
    })
  })

  /** And the ciphertext does not sit there after the window; the row stays. */
  it('destroys the value of an expired handover and keeps the record', async () => {
    const opened = await sealed()
    await db
      .update(accountSlots)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(accountSlots.id, opened.id))

    expect(await destroyExpiredHandovers(db)).toBe(1)

    const row = await handoverRow(opened.id)
    expect(row?.sealedValue).toBeNull()
    expect(row?.destroyedAt).not.toBeNull()
    // Idempotent: a second sweep finds nothing left to do.
    expect(await destroyExpiredHandovers(db)).toBe(0)
  })

  it('lists what is waiting for one person, without the value or the ciphertext', async () => {
    await sealed()

    const waiting = await handoversFor(db, humanId)

    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({
      agentName: 'sealer',
      provider: 'github.com',
      readsLeft: HANDOVER_MAX_READS,
    })
    expect(JSON.stringify(waiting)).not.toContain(VALUE)
  })

  it('lists nothing for somebody else', async () => {
    await sealed()

    expect(await handoversFor(db, await aPerson())).toEqual([])
  })

  /**
   * A ciphertext lifted onto another citizen's row fails to open rather than
   * opening as something else — the associated data is the agent id and the
   * row's own label.
   */
  it('cannot be opened under another citizen’s identity', async () => {
    const opened = await sealed()
    const other = await register('interloper')
    await db.update(accountSlots).set({ agentId: other }).where(eq(accountSlots.id, opened.id))
    await db.insert(humanAgents).values({ humanId: await aPerson(), agentId: other })

    const [row] = await db.select().from(agents).where(eq(agents.id, other))
    expect(row).toBeDefined()

    const [moved] = await db.select().from(humanAgents).where(eq(humanAgents.agentId, other))
    const read = await readHandoverAsOperator(db, opened.id, moved!.humanId, SEALING_KEY)

    expect(read).toEqual({ outcome: 'closed' })
  })
})
