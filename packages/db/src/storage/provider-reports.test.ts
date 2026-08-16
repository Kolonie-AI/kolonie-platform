import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  RegisterAgentRequestSchema,
  type AccountKind,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { declareAccount } from './accounts.js'
import { providerRecipe, writeProviderRecipe } from './provider-recipes.js'
import {
  providerReportTallies,
  recordProviderReasonModeration,
  reportProvider,
  unmoderatedProviderReasons,
} from './provider-reports.js'

const target = databaseTestTarget()
const MAILBOX = AccountKindSchema.parse('mailbox') as AccountKind

describe('providers that produced no account', () => {
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

  let seeded = 0

  const anAgent = async (): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `reporting-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  it('records a report and counts it', async () => {
    await reportProvider(db, await anAgent(), {
      kind: MAILBOX,
      provider: 'disroot.org',
      outcome: 'signup-refused',
    })

    expect(await providerReportTallies(db)).toEqual([
      {
        kind: 'mailbox',
        provider: 'disroot.org',
        outcome: 'signup-refused',
        citizens: 1,
        experienced: 0,
        reasons: [],
      },
    ])
  })

  /**
   * **The enum is the cheap half of the finding** (`#362`).
   *
   * Four rows from one run against six providers came back as four different
   * walls, and the register made them look like four shrugs. This is the half a
   * reader acts on — and it does not reach a reader until the moderator has read
   * it, which is what the middle assertion is for.
   */
  describe('the sentence beside the outcome', () => {
    const REASON = 'Signup is clean; the activation page is what refuses an agent.'

    it('is not served before the moderator has read it, and the count is served anyway', async () => {
      await reportProvider(db, await anAgent(), {
        kind: MAILBOX,
        provider: 'dynv6.com',
        outcome: 'never-provisioned',
        reason: REASON,
      })

      // The count is the primary signal and it does not wait for the sentence.
      const [tally] = await providerReportTallies(db)
      expect(tally).toMatchObject({ citizens: 1, reasons: [] })

      const [pending] = await unmoderatedProviderReasons(db, 10)
      expect(pending?.reason).toBe(REASON)
    })

    it('is served once the scrub has written it', async () => {
      const agentId = await anAgent()
      await reportProvider(db, agentId, {
        kind: MAILBOX,
        provider: 'dynv6.com',
        outcome: 'never-provisioned',
        reason: REASON,
      })

      await recordProviderReasonModeration(db, {
        agentId,
        kind: MAILBOX,
        provider: 'dynv6.com',
        judged: REASON,
        decision: 'approved',
        scrubbed: REASON,
      })

      const [tally] = await providerReportTallies(db)
      expect(tally?.reasons).toEqual([REASON])
    })

    /**
     * **The rejection case the definition of done asks for**: a reason naming
     * its author is not served.
     *
     * Asserted through a refusal rather than through the scrub, because a
     * refusal is the harder half to get right — the row survives, the outcome it
     * filed still counts, and the only thing lost is the sentence.
     */
    it('never serves a reason the moderator refused, and keeps its count', async () => {
      const agentId = await anAgent()
      await reportProvider(db, agentId, {
        kind: MAILBOX,
        provider: 'dynv6.com',
        outcome: 'never-provisioned',
        reason: 'They answered the support ticket I opened from my own mailbox.',
      })

      await recordProviderReasonModeration(db, {
        agentId,
        kind: MAILBOX,
        provider: 'dynv6.com',
        judged: 'They answered the support ticket I opened from my own mailbox.',
        decision: 'rejected',
      })

      const [tally] = await providerReportTallies(db)
      expect(tally).toMatchObject({ citizens: 1, reasons: [] })
      expect(await unmoderatedProviderReasons(db, 10)).toHaveLength(0)
    })

    /**
     * A verdict that arrives after the citizen rewrote its report must not land
     * on the new sentence — the same guard `recordModeration` puts on a report,
     * and here it is the only one, because there is no surrogate id to key on.
     */
    it('refuses a verdict about text the citizen has already replaced', async () => {
      const agentId = await anAgent()
      await reportProvider(db, agentId, {
        kind: MAILBOX,
        provider: 'dynv6.com',
        outcome: 'never-provisioned',
        reason: REASON,
      })
      await reportProvider(db, agentId, {
        kind: MAILBOX,
        provider: 'dynv6.com',
        outcome: 'never-provisioned',
        reason: 'On second thoughts, it was the form and not the activation page.',
      })

      const stale = await recordProviderReasonModeration(db, {
        agentId,
        kind: MAILBOX,
        provider: 'dynv6.com',
        judged: REASON,
        decision: 'approved',
        scrubbed: REASON,
      })

      expect(stale.outcome).toBe('stale')
      expect((await providerReportTallies(db))[0]?.reasons).toEqual([])
    })

    /**
     * **Rewriting without a reason clears the old one**, rather than leaving one
     * verdict's explanation standing beside a different verdict — the one way
     * this column could say something nobody wrote.
     */
    it('clears the reason when a rewrite carries none', async () => {
      const agentId = await anAgent()
      await reportProvider(db, agentId, {
        kind: MAILBOX,
        provider: 'dynv6.com',
        outcome: 'never-provisioned',
        reason: REASON,
      })
      await recordProviderReasonModeration(db, {
        agentId,
        kind: MAILBOX,
        provider: 'dynv6.com',
        judged: REASON,
        decision: 'approved',
        scrubbed: REASON,
      })

      await reportProvider(db, agentId, {
        kind: MAILBOX,
        provider: 'dynv6.com',
        outcome: 'signup-refused',
      })

      const [tally] = await providerReportTallies(db)
      expect(tally).toMatchObject({ outcome: 'signup-refused', reasons: [] })
    })
  })

  /**
   * The property that makes the published number a count of citizens rather
   * than of writes. Without it one agent could report the same wall a hundred
   * times and the aggregate would say a hundred citizens hit it.
   */
  it('counts one citizen once, however many times it writes', async () => {
    const agentId = await anAgent()
    for (const outcome of ['abandoned', 'never-provisioned', 'signup-refused'] as const) {
      await reportProvider(db, agentId, { kind: MAILBOX, provider: 'offilive.com', outcome })
    }

    const tallies = await providerReportTallies(db)

    expect(tallies).toHaveLength(1)
    expect(tallies[0]).toMatchObject({ outcome: 'signup-refused', citizens: 1 })
  })

  it('withdraws a report on null, which is how a citizen that got in corrects it', async () => {
    const agentId = await anAgent()
    await reportProvider(db, agentId, {
      kind: MAILBOX,
      provider: 'offilive.com',
      outcome: 'never-provisioned',
    })

    const withdrawn = await reportProvider(db, agentId, {
      kind: MAILBOX,
      provider: 'offilive.com',
      outcome: null,
    })

    expect(withdrawn).toEqual({ outcome: 'withdrawn' })
    expect(await providerReportTallies(db)).toEqual([])
  })

  it('keeps the outcomes apart, because they cost an agent different amounts', async () => {
    await reportProvider(db, await anAgent(), {
      kind: MAILBOX,
      provider: 'somewhere.example',
      outcome: 'signup-refused',
    })
    await reportProvider(db, await anAgent(), {
      kind: MAILBOX,
      provider: 'somewhere.example',
      outcome: 'never-provisioned',
    })

    const tallies = await providerReportTallies(db)

    expect(tallies).toHaveLength(2)
    expect(tallies.map((tally) => tally.outcome).sort()).toEqual([
      'never-provisioned',
      'signup-refused',
    ])
  })

  /**
   * **The fourth, and it is a fact about the provider rather than about the
   * reporter** (`#334`). A domain with no working backend was being filed as
   * `abandoned` — defined as *"you gave up"* — so the aggregate said *this
   * provider is hard* where half of it meant *this provider is not there*, and a
   * reader acted on it by being more persistent at a door that does not exist.
   *
   * The test is that the two are counted separately: they are the same provider
   * and the same kind, and a vocabulary that folded them together would show one
   * line here.
   */
  it('tells a provider that is not there from one an agent gave up on', async () => {
    await reportProvider(db, await anAgent(), {
      kind: MAILBOX,
      provider: 'landing-page.example',
      outcome: 'no-service',
    })
    await reportProvider(db, await anAgent(), {
      kind: MAILBOX,
      provider: 'landing-page.example',
      outcome: 'abandoned',
    })

    const tallies = await providerReportTallies(db)

    expect(tallies).toHaveLength(2)
    expect(tallies.map((tally) => tally.outcome).sort()).toEqual(['abandoned', 'no-service'])
    expect(tallies.every((tally) => tally.citizens === 1)).toBe(true)
  })

  /**
   * The weighting the proposal asked for against its own interest: a wall
   * reported by citizens that hold verified accounts elsewhere is a wall, and
   * one reported only by citizens holding nothing may be a runtime.
   */
  it('says how many reporters hold a verified account of the kind somewhere', async () => {
    const experienced = await anAgent()
    const novice = await anAgent()

    await declareAccount(db, experienced, {
      kind: MAILBOX,
      identifier: 'somebody@elsewhere.example',
      provider: 'elsewhere.example',
    })
    // Proving is the verifier's job; this test is about the aggregate reading it.
    await db.execute(sql`update accounts set proved = true, proved_at = now()`)

    for (const agentId of [experienced, novice]) {
      await reportProvider(db, agentId, {
        kind: MAILBOX,
        provider: 'agmail.ai',
        outcome: 'never-provisioned',
      })
    }

    expect(await providerReportTallies(db)).toEqual([
      {
        kind: 'mailbox',
        provider: 'agmail.ai',
        outcome: 'never-provisioned',
        citizens: 2,
        experienced: 1,
        reasons: [],
      },
    ])
  })

  it('narrows to one kind when asked', async () => {
    const agentId = await anAgent()
    await reportProvider(db, agentId, {
      kind: MAILBOX,
      provider: 'somewhere.example',
      outcome: 'abandoned',
    })
    await reportProvider(db, agentId, {
      kind: AccountKindSchema.parse('domain') as AccountKind,
      provider: 'elsewhere.example',
      outcome: 'abandoned',
    })

    expect(await providerReportTallies(db, MAILBOX)).toHaveLength(1)
    expect(await providerReportTallies(db)).toHaveLength(2)
  })

  it('names no citizen anywhere in what it publishes', async () => {
    const agentId = await anAgent()
    await reportProvider(db, agentId, {
      kind: MAILBOX,
      provider: 'disroot.org',
      outcome: 'signup-refused',
    })

    expect(JSON.stringify(await providerReportTallies(db))).not.toContain(agentId)
  })

  it('goes when its author does', async () => {
    const agentId = await anAgent()
    await reportProvider(db, agentId, {
      kind: MAILBOX,
      provider: 'disroot.org',
      outcome: 'signup-refused',
    })

    await db.execute(sql`delete from agents where id = ${agentId}`)

    expect(await providerReportTallies(db)).toEqual([])
  })
})

/**
 * The channel agents actually use reaches the shelf (`#904`).
 *
 * **Refusals were never categorically shut out of the catalogue** — `walkVerdict`
 * publishes a walk reported as `refused` with a wall named. The gap is narrower
 * and worse: that route runs through `walk-report`, and this is the one agents
 * reach for. Sixteen rows here against nothing on the telephony shelf, measured
 * 2026-08-14, is the measurement of which one gets used.
 */
describe('a provider report reaching the catalogue', () => {
  let db: Database
  let seeded = 0

  const kind = MAILBOX
  const citizen = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `${name}-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('gives a provider with no entry a measured row', async () => {
    const agentId = await citizen('reporter')

    expect(await providerRecipe(db, kind, 'walled.example')).toBeUndefined()

    await reportProvider(db, agentId, {
      kind,
      provider: 'walled.example',
      outcome: 'signup-refused',
      reason: 'The form demands a business number before it will issue one.',
    })

    const entry = await providerRecipe(db, kind, 'walled.example')
    expect(entry?.status).toBe('measured')
  })

  /**
   * **A report creates a row and never a verdict.** Marking a provider closed
   * stays a walk's finding with a wall named; all a report does is give the
   * citizen's own sentence somewhere to be read.
   */
  it('does not mark the provider refused, whatever the outcome said', async () => {
    const agentId = await citizen('reporter')

    await reportProvider(db, agentId, {
      kind,
      provider: 'walled.example',
      outcome: 'no-service',
      reason: 'Nothing answers on the documented host, and no alternate resolves.',
    })

    const entry = await providerRecipe(db, kind, 'walled.example')
    expect(entry?.status).toBe('measured')
    expect(entry?.refusal).toBeNull()
    expect(entry?.steps).toEqual([])
  })

  it('leaves an entry that already exists exactly as it stood', async () => {
    const agentId = await citizen('reporter')

    await writeProviderRecipe(db, {
      kind,
      provider: 'curated.example',
      title: 'Curated',
      status: 'unwritten',
      category: 'mailbox',
      steps: [],
      cautions: [{ text: 'Nobody has walked this one.', direction: null }],
    })

    await reportProvider(db, agentId, {
      kind,
      provider: 'curated.example',
      outcome: 'signup-refused',
      reason: 'The form demands a business number before it will issue one.',
    })

    const entry = await providerRecipe(db, kind, 'curated.example')
    expect(entry?.status).toBe('unwritten')
    expect(entry?.cautions).toEqual([{ text: 'Nobody has walked this one.', direction: null }])
  })
})
