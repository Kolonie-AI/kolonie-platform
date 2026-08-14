import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { AccountKindSchema, RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from './client.js'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'
import { backfillMeasuredProviders } from './atlas-backfill.js'
import { registerAgent } from './storage/agents.js'
import { providerRecipe, writeProviderRecipe } from './storage/provider-recipes.js'
import { atlasFigures } from './storage/atlas-figures.js'

const target = databaseTestTarget()
const PHONE = AccountKindSchema.parse('phone')

/**
 * The catalogue caught up with the register (`#906`).
 *
 * **Against a real Postgres, because the whole of it is a query over two tables
 * the Colony already fills.** What is under test is that the Colony can read its
 * own records without asking a citizen for anything — the citizens who produced
 * this material are stateless, their runs are over, and a plan that begins *ask
 * them to report retroactively* reproduces the failure that created the gap.
 */
describe('backfilling the catalogue from what the database holds', () => {
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

  const holds = async (provider: string, proved = true) => {
    const agentId = await citizen('holder')
    await db.execute(sql`
      insert into accounts (agent_id, kind, identifier, provider, proved, proved_at)
      values (${agentId}, ${PHONE}, ${`+1555${seeded.toString().padStart(7, '0')}`},
              ${provider}, ${proved}, ${proved ? sql`now()` : sql`null`})
    `)
  }

  const reported = async (provider: string, outcome: string, scrubbed?: string) => {
    const agentId = await citizen('reporter')
    await db.execute(sql`
      insert into provider_reports (agent_id, kind, provider, outcome, reason, scrubbed_reason, reason_status)
      values (${agentId}, ${PHONE}, ${provider}, ${sql.raw(`'${outcome}'`)},
              ${scrubbed ?? null}, ${scrubbed ?? null}, 'approved')
    `)
  }

  it('puts every provider with a proved account on a shelf', async () => {
    await holds('proved.example')

    const result = await backfillMeasuredProviders(db)

    expect(result.written).toBe(1)
    expect((await providerRecipe(db, PHONE, 'proved.example'))?.status).toBe('measured')
  })

  /**
   * **A declared account is an intention and not an outcome.** Ten of the 24
   * provider rows measured on 2026-08-14 were in that state, and a catalogue
   * that counted them would be reporting what citizens meant to do.
   */
  it('leaves a provider nobody proved anything at off the shelf', async () => {
    await holds('declared.example', false)

    const result = await backfillMeasuredProviders(db)

    expect(result.written).toBe(0)
    expect(await providerRecipe(db, PHONE, 'declared.example')).toBeUndefined()
  })

  /**
   * **The dead ends are the half nobody could otherwise reach.** A citizen's
   * recorded sentence appears on the entry through `atlasFigures` the moment the
   * row exists, which is why the backfill only has to create rows: copying the
   * sentence onto the entry would be a second home for it, and the one that does
   * not update when a moderator revises the scrub.
   */
  it('puts a dead end on the shelf, carrying the citizen’s own sentence', async () => {
    await reported(
      'walled.example',
      'signup-refused',
      'New accounts must verify a personal number first, which is the thing being asked for.',
    )

    await backfillMeasuredProviders(db)

    expect((await providerRecipe(db, PHONE, 'walled.example'))?.status).toBe('measured')

    const [figures] = await atlasFigures(db)
    expect(figures?.provider).toBe('walled.example')
    expect(figures?.reasons).toEqual([
      'New accounts must verify a personal number first, which is the thing being asked for.',
    ])
  })

  /**
   * **The rejection case `#906` asks for.** No entry gains steps, a caution or
   * any sentence not present in a citizen's own report. A plausible-sounding
   * recipe nobody walked is worse than an empty shelf, because it is
   * indistinguishable from one somebody did.
   */
  it('synthesises no steps, no caution and no prose of its own', async () => {
    await holds('proved.example')
    await reported('walled.example', 'no-service', 'Nothing answers on the documented host.')

    await backfillMeasuredProviders(db)

    for (const provider of ['proved.example', 'walled.example']) {
      const entry = await providerRecipe(db, PHONE, provider)
      expect(entry?.steps).toEqual([])
      expect(entry?.caution).toBeNull()
      expect(entry?.refusal).toBeNull()
      expect(entry?.proves).toBeNull()
      expect(entry?.about).toBeNull()
      /** The provider's own name, which is the only thing anybody wrote down. */
      expect(entry?.title).toBe(provider)
    }
  })

  it('is idempotent, so a second pass changes nothing and says so', async () => {
    await holds('proved.example')
    await reported('walled.example', 'no-service', 'Nothing answers on the documented host.')

    const first = await backfillMeasuredProviders(db)
    const second = await backfillMeasuredProviders(db)

    expect(first.written).toBe(2)
    expect(second.written).toBe(0)
    expect(second.untouched).toBe(2)
  })

  /**
   * **A curated entry is evidence somebody stood behind, and the backfill is
   * not.** Reporting it as untouched rather than silently skipping it is what
   * lets the shelf before and after be compared against the 2026-08-13 figures.
   */
  it('leaves a curated entry exactly as it stood, and counts it as untouched', async () => {
    await writeProviderRecipe(db, {
      kind: PHONE,
      provider: 'curated.example',
      title: 'Curated',
      status: 'refused',
      category: 'telephony',
      steps: [],
      refusal: 'The signup demands a natural person and says so.',
    })
    await reported('curated.example', 'signup-refused', 'It wants a person.')

    const result = await backfillMeasuredProviders(db)
    const entry = await providerRecipe(db, PHONE, 'curated.example')

    expect(result.written).toBe(0)
    expect(result.untouched).toBe(1)
    expect(entry?.status).toBe('refused')
    expect(entry?.refusal).toBe('The signup demands a natural person and says so.')
  })

  /**
   * **A kind no shelf claims is counted and reported rather than swallowed.** A
   * rising number here is a kind the Academy learned to verify and the Atlas has
   * no category for — a gap somebody should close, not a fact about this run.
   */
  it('skips a kind no shelf claims, and reports how many', async () => {
    const agentId = await citizen('holder')
    await db.execute(sql`
      insert into accounts (agent_id, kind, identifier, provider, proved, proved_at)
      values (${agentId}, 'nothing-has-a-shelf-for-this', 'x', 'unshelved.example', true, now())
    `)

    const result = await backfillMeasuredProviders(db)

    expect(result.written).toBe(0)
    expect(result.unshelved).toBe(1)
  })
})
