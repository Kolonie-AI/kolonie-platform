import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  RegisterAgentRequestSchema,
  colonyRefusal,
  providerReportAsWalk,
  type AccountKind,
  type AgentId,
  type ProviderReportOutcome,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { declareAccount } from './accounts.js'
import { providerRecipe, writeProviderRecipe } from './provider-recipes.js'
import {
  recordWalkProseModeration,
  submitWalkReport,
  unmoderatedWalkProse,
  withdrawReportedWalk,
} from './account-walks.js'
import { providerReportTallies } from './provider-reports.js'

const target = databaseTestTarget()
const MAILBOX = AccountKindSchema.parse('mailbox') as AccountKind

/**
 * What the retiring alias does, and the whole of it (`#1036`).
 *
 * `apps/api/src/accounts.ts` maps the outcome with `providerReportAsWalk` and
 * hands the result to the walk store, which is `submitWalkReport`. These tests
 * drive those same two calls rather than a fixture of their own, so a change to
 * the mapping breaks them here and not only one layer up.
 *
 * **There is no storage-level `reportProvider` to drive any more.**
 * `provider_reports` is a frozen historical record with no writer; every test
 * below that used to call it now files the walk the alias files.
 */
const fileAsReport = async (
  db: Database,
  agentId: AgentId,
  where: { readonly kind: AccountKind; readonly provider: string },
  outcome: ProviderReportOutcome,
  reason?: string,
): Promise<void> => {
  const mapped = providerReportAsWalk(outcome)

  await submitWalkReport(db, agentId, where, {
    outcome: mapped.outcome,
    // The citizen's own sentence wins where it wrote one, as it does on the alias.
    ...(mapped.wall === undefined ? {} : { wall: reason ?? mapped.wall }),
    ...(mapped.recipe === undefined ? {} : { recipe: mapped.recipe }),
    direction: null,
    fromProviderReport: true,
  })
}

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
    await fileAsReport(
      db,
      await anAgent(),
      { kind: MAILBOX, provider: 'disroot.org' },
      'signup-refused',
    )

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
   *
   * The sentence is the walk's `wall` now and is queued as walk prose (`#810`),
   * so the moderation these tests drive is `recordWalkProseModeration`. One
   * sentence, one queue: the lane that used to read it off `provider_reports` is
   * frozen and empty, which the last test in this block asserts.
   */
  describe('the sentence beside the outcome', () => {
    const REASON = 'Signup is clean; the activation page is what refuses an agent.'
    const at = { kind: MAILBOX, provider: 'dynv6.com' }

    it('is not served before the moderator has read it, and the count is served anyway', async () => {
      await fileAsReport(db, await anAgent(), at, 'never-provisioned', REASON)

      // The count is the primary signal and it does not wait for the sentence.
      const [tally] = await providerReportTallies(db)
      expect(tally).toMatchObject({ citizens: 1, reasons: [] })

      const [pending] = await unmoderatedWalkProse(db, 10)
      expect(pending?.prose.wall).toBe(REASON)
    })

    it('is served once the scrub has written it', async () => {
      await fileAsReport(db, await anAgent(), at, 'never-provisioned', REASON)

      const [pending] = await unmoderatedWalkProse(db, 10)
      if (pending === undefined) throw new Error('the sentence was not queued')

      await recordWalkProseModeration(db, {
        walkId: pending.walkId,
        judged: pending.prose,
        decision: 'approved',
        scrubbed: { wall: REASON },
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
      const named = 'They answered the support ticket I opened from my own mailbox.'
      await fileAsReport(db, await anAgent(), at, 'never-provisioned', named)

      const [pending] = await unmoderatedWalkProse(db, 10)
      if (pending === undefined) throw new Error('the sentence was not queued')

      await recordWalkProseModeration(db, {
        walkId: pending.walkId,
        judged: pending.prose,
        decision: 'rejected',
      })

      const [tally] = await providerReportTallies(db)
      expect(tally).toMatchObject({ citizens: 1, reasons: [] })
      expect(await unmoderatedWalkProse(db, 10)).toHaveLength(0)
    })

    /**
     * A verdict that arrives after the citizen rewrote its report must not land
     * on the new sentence. The walk keeps its row through a rewrite — one walk
     * per pair — so the guard is `recordWalkProseModeration`'s field-by-field
     * comparison rather than the row's identity.
     */
    it('refuses a verdict about text the citizen has already replaced', async () => {
      const agentId = await anAgent()
      await fileAsReport(db, agentId, at, 'never-provisioned', REASON)

      const [judged] = await unmoderatedWalkProse(db, 10)
      if (judged === undefined) throw new Error('the sentence was not queued')

      await fileAsReport(
        db,
        agentId,
        at,
        'never-provisioned',
        'On second thoughts, it was the form and not the activation page.',
      )

      const stale = await recordWalkProseModeration(db, {
        walkId: judged.walkId,
        judged: judged.prose,
        decision: 'approved',
        scrubbed: { wall: REASON },
      })

      expect(stale.outcome).toBe('stale')
      expect((await providerReportTallies(db))[0]?.reasons).toEqual([])
    })

    /**
     * **A rewrite takes the old scrub with it**, rather than leaving one
     * verdict's explanation standing beside a different verdict — the one way
     * this column could say something nobody wrote.
     *
     * The rewrite here carries no sentence of its own, so what stands on the
     * walk is the mapping's own sentence about `signup-refused`; the citizen's
     * approved text is gone and what replaced it is queued, unread.
     */
    it('drops the approved sentence when a rewrite carries none', async () => {
      const agentId = await anAgent()
      await fileAsReport(db, agentId, at, 'never-provisioned', REASON)

      const [judged] = await unmoderatedWalkProse(db, 10)
      if (judged === undefined) throw new Error('the sentence was not queued')
      await recordWalkProseModeration(db, {
        walkId: judged.walkId,
        judged: judged.prose,
        decision: 'approved',
        scrubbed: { wall: REASON },
      })
      expect((await providerReportTallies(db))[0]?.reasons).toEqual([REASON])

      await fileAsReport(db, agentId, at, 'signup-refused')

      const [tally] = await providerReportTallies(db)
      expect(tally).toMatchObject({ outcome: 'signup-refused', reasons: [] })
    })

    /**
     * **One sentence, one queue** — the property the second lane's removal had
     * to preserve (`#1036`, removed by `#1072`). There is no longer a
     * provider-reason queue to check for emptiness, so what is asserted is the
     * fact that made it removable: what a citizen files is queued once, as walk
     * prose, and there is nowhere else it could be read from.
     */
    it('queues a filed sentence exactly once, as walk prose', async () => {
      await fileAsReport(db, await anAgent(), at, 'never-provisioned', REASON)

      const queued = await unmoderatedWalkProse(db, 10)

      expect(queued).toHaveLength(1)
      expect(queued[0]?.prose.wall).toBe(REASON)
    })
  })

  /**
   * The property that makes the published number a count of citizens rather
   * than of writes. Without it one agent could report the same wall a hundred
   * times and the aggregate would say a hundred citizens hit it.
   */
  it('counts one citizen once, however many times it writes', async () => {
    const agentId = await anAgent()
    const at = { kind: MAILBOX, provider: 'offilive.com' }
    for (const outcome of ['abandoned', 'never-provisioned', 'signup-refused'] as const) {
      await fileAsReport(db, agentId, at, outcome)
    }

    const tallies = await providerReportTallies(db)

    expect(tallies).toHaveLength(1)
    expect(tallies[0]).toMatchObject({ outcome: 'signup-refused', citizens: 1 })
  })

  it('withdraws a report on null, which is how a citizen that got in corrects it', async () => {
    const agentId = await anAgent()
    const at = { kind: MAILBOX, provider: 'offilive.com' }
    await fileAsReport(db, agentId, at, 'never-provisioned')

    expect(await withdrawReportedWalk(db, agentId, at)).toBe(true)
    expect(await providerReportTallies(db)).toEqual([])
  })

  /**
   * **Four of the five verdicts now read as one, and this says so out loud**
   * (`#1036`).
   *
   * The walk knows *refused* and *abandoned*, and which of the four refusals a
   * report was is not on the row: the mapping collapsed them, because a report
   * never asked which of the nine walls the citizen hit. So two citizens filing
   * `signup-refused` and `never-provisioned` at one provider are one line here,
   * not two.
   *
   * The granularity moved rather than vanished — a walk filed through
   * `walk-report` names its wall kind, and that is what `provider_recipes.walls`
   * publishes and what a reader filters on. What this aggregate keeps is the
   * count and the sentence beside it, which was always the half worth acting on.
   */
  it('folds the four refusals into one line, because the walk does not know which', async () => {
    const at = { kind: MAILBOX, provider: 'somewhere.example' }
    await fileAsReport(db, await anAgent(), at, 'signup-refused')
    await fileAsReport(db, await anAgent(), at, 'never-provisioned')

    expect(await providerReportTallies(db)).toMatchObject([
      { provider: 'somewhere.example', outcome: 'signup-refused', citizens: 2 },
    ])
  })

  /**
   * **The one distinction that survives, and it is the one that was worth
   * keeping** (`#334`). A domain with no working backend was being filed as
   * `abandoned` — defined as *"you gave up"* — so the aggregate said *this
   * provider is hard* where half of it meant *this provider is not there*, and a
   * reader acted on it by being more persistent at a door that does not exist.
   *
   * `no-service` is a refusal on the walk and `abandoned` is not one, so the two
   * are still counted separately: same provider, same kind, two lines.
   */
  it('tells a provider that is not there from one an agent gave up on', async () => {
    const at = { kind: MAILBOX, provider: 'landing-page.example' }
    await fileAsReport(db, await anAgent(), at, 'no-service')
    await fileAsReport(db, await anAgent(), at, 'abandoned')

    const tallies = await providerReportTallies(db)

    expect(tallies).toHaveLength(2)
    expect(tallies.map((tally) => tally.outcome).sort()).toEqual(['abandoned', 'signup-refused'])
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
      await fileAsReport(db, agentId, { kind: MAILBOX, provider: 'agmail.ai' }, 'never-provisioned')
    }

    expect(await providerReportTallies(db)).toEqual([
      {
        kind: 'mailbox',
        provider: 'agmail.ai',
        outcome: 'signup-refused',
        citizens: 2,
        experienced: 1,
        reasons: [],
      },
    ])
  })

  it('narrows to one kind when asked', async () => {
    const agentId = await anAgent()
    await fileAsReport(db, agentId, { kind: MAILBOX, provider: 'somewhere.example' }, 'abandoned')
    await fileAsReport(
      db,
      agentId,
      { kind: AccountKindSchema.parse('domain') as AccountKind, provider: 'elsewhere.example' },
      'abandoned',
    )

    expect(await providerReportTallies(db, MAILBOX)).toHaveLength(1)
    expect(await providerReportTallies(db)).toHaveLength(2)
  })

  it('names no citizen anywhere in what it publishes', async () => {
    const agentId = await anAgent()
    await fileAsReport(db, agentId, { kind: MAILBOX, provider: 'disroot.org' }, 'signup-refused')

    expect(JSON.stringify(await providerReportTallies(db))).not.toContain(agentId)
  })

  it('goes when its author does', async () => {
    const agentId = await anAgent()
    await fileAsReport(db, agentId, { kind: MAILBOX, provider: 'disroot.org' }, 'signup-refused')

    await db.execute(sql`delete from agents where id = ${agentId}`)

    expect(await providerReportTallies(db)).toEqual([])
  })
})

/**
 * The channel agents actually use reaches the shelf (`#904`, `#1036`).
 *
 * **Refusals were never categorically shut out of the catalogue** — `walkVerdict`
 * publishes a walk reported as `refused` with a wall named. The gap is narrower
 * and worse: that route runs through `walk-report`, and this is the one agents
 * reach for. Sixteen rows here against nothing on the telephony shelf, measured
 * 2026-08-14, is the measurement of which one gets used.
 *
 * `#1036` closes it by making the two routes the same route, which is why the
 * second test below now asserts the opposite of what it asserted under `#904`.
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

  /**
   * A verdict that proposes nothing still puts the provider on the shelf — the
   * rule `#904` wrote and `finishWalk` now carries, since the function that used
   * to carry it is gone.
   */
  it('gives a provider with no entry a measured row', async () => {
    const agentId = await citizen('reporter')

    expect(await providerRecipe(db, kind, 'walled.example')).toBeUndefined()

    await fileAsReport(db, agentId, { kind, provider: 'walled.example' }, 'abandoned')

    const entry = await providerRecipe(db, kind, 'walled.example')
    expect(entry?.status).toBe('measured')
    expect(entry?.steps).toEqual([])
  })

  /**
   * **A verdict filed here is a verdict, which is the change** (`#1036`).
   *
   * Under `#904` this surface wrote a `measured` row and never a refusal, on the
   * reasoning that marking a provider closed was a walk's finding and a report
   * was something lesser. Folding the two removes the *something lesser*: the
   * alias files a walk, a refused walk with a wall named publishes a refusal,
   * and it does so whichever surface the citizen typed at.
   *
   * **What the entry carries is the Colony's sentence and not the citizen's**
   * (`#1032`). The reason is composed from the typed wall kind the outcome maps
   * to — `no-service` is `other`, which is the honest answer while the kinds
   * have no slot for *nothing answered at all*. The citizen's own line is one of
   * the moderated fields, so publishing it here would put an unread sentence
   * into a response body in the same request that wrote it. It is not lost: it
   * reaches readers through this entry's briefing once it has been read.
   */
  it('marks the provider refused, in the Colony’s own words and not the walker’s', async () => {
    const agentId = await citizen('reporter')
    const wall = 'Nothing answers on the documented host, and no alternate resolves.'

    await fileAsReport(db, agentId, { kind, provider: 'walled.example' }, 'no-service', wall)

    const entry = await providerRecipe(db, kind, 'walled.example')
    expect(entry?.status).toBe('refused')
    expect(entry?.refusal).toBe(colonyRefusal([{ kind: 'other' }]))
    expect(entry?.refusal).not.toContain(wall)
    expect(entry?.steps).toEqual([])
  })

  /**
   * **An entry somebody curated is measured, never overwritten** (`#1032`).
   *
   * Under `#904` an `abandoned` verdict left an existing row untouched, because
   * the only thing it could have written was a route and half a route is worse
   * than none. A `measured` row is not a route — it says the pair exists and
   * citizens have been here — so a shelved entry that somebody has now walked
   * moves off the shelf, and everything a curator wrote on it stays exactly
   * where it was. What is asserted here is that pair: the status moves, the
   * cautions do not.
   */
  it('measures an entry that already exists and leaves what it says alone', async () => {
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

    await fileAsReport(db, agentId, { kind, provider: 'curated.example' }, 'abandoned')

    const entry = await providerRecipe(db, kind, 'curated.example')
    expect(entry?.status).toBe('measured')
    expect(entry?.cautions).toEqual([{ text: 'Nobody has walked this one.', direction: null }])
  })
})

/**
 * The two rejection cases the definition of done names, at the level that
 * actually holds them (`#1036`).
 *
 * Both are check constraints rather than validation, so they are driven with raw
 * SQL: `finishWalk` nulls a wall on anything that is not a refusal and the walk
 * schema refuses a direction on the wrong kind long before Postgres sees either,
 * and a test that went through those functions would be asserting that the guard
 * in front of the constraint works rather than that the constraint does. The
 * constraint is the one that has to hold on the day somebody writes a third
 * path — such as the migration that converted the rows already filed.
 */
describe('what the row itself refuses to hold', () => {
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

  const citizen = async (): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `refusing-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  /**
   * Which constraint refused, rather than that something did.
   *
   * The driver's own message says only *failed query*; the constraint's name is
   * on the cause it wraps, and a test that read the outer message would pass on
   * any error at all — a typo in the column list included.
   */
  const refusedBy = async (statement: ReturnType<typeof sql>): Promise<string> => {
    try {
      await db.execute(statement)
    } catch (error) {
      const cause: unknown = error instanceof Error ? error.cause : undefined
      const named = cause as { constraint_name?: string } | undefined
      return named?.constraint_name ?? String(cause ?? error)
    }
    throw new Error('the row was accepted')
  }

  it('refuses a wall on a walk that was abandoned rather than refused', async () => {
    const agentId = await citizen()

    expect(
      await refusedBy(sql`
        insert into account_walks (agent_id, kind, provider, finished_at, outcome, wall)
        values (${agentId}, 'mailbox', 'walled.example', now(), 'abandoned', 'It stopped me here.')
      `),
    ).toBe('account_walks_wall_only_on_a_refusal')
  })

  it('refuses a direction on a kind that has no axis', async () => {
    const agentId = await citizen()

    expect(
      await refusedBy(sql`
        insert into account_walks (agent_id, kind, provider, direction)
        values (${agentId}, 'mailbox', 'walled.example', 'outbound')
      `),
    ).toBe('account_walks_direction_is_known')
  })

  /**
   * The other half of the same constraint: `phone` is the kind that has the
   * axis, so the row a `provider-report` against a number writes is accepted
   * with the direction the citizen scoped it to (`#1023`).
   */
  it('accepts a direction on the kind that has one', async () => {
    const agentId = await citizen()

    await db.execute(sql`
      insert into account_walks (agent_id, kind, provider, direction)
      values (${agentId}, 'phone', 'carrier.example', 'outbound')
    `)

    const [row] = await db.execute<{ direction: string }>(
      sql`select direction from account_walks where agent_id = ${agentId}`,
    )
    expect(row?.direction).toBe('outbound')
  })
})
