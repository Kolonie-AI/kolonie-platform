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
import { finishWalk, recordWalkStep, walkInProgress } from './account-walks.js'
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

  /**
   * **The counted read and the named read stay apart** (`#960`).
   *
   * An Atlas entry names the citizens who walked it; these figures are counted
   * and never listed, and the header of the query says why — no agent id, no
   * identifier, no unmoderated text. The two are one page and two reads, and the
   * cheapest way to break that is to widen this one because the handle was
   * already joined a few lines away. So the walk is real here, and the assertion
   * is over the whole answer rather than over a field somebody would have to
   * remember to add.
   */
  it('names no walker, however many citizens walked the provider', async () => {
    for (let i = 0; i < 5; i++) await holds({ name: `held-${i}`, provider: 'mail.tm' })

    const registered = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'walked-mail-tm', platform: 'openclaw' }),
    )
    if (registered.outcome !== 'registered') throw new Error(registered.outcome)
    const walkId = await walkInProgress(db, registered.agent.id, { kind, provider: 'mail.tm' })
    await recordWalkStep(db, walkId, { actor: 'agent' })
    await finishWalk(db, walkId, { outcome: 'proved' })

    const figures = await atlasFigures(db)

    expect(figures.some((one) => one.provider === 'mail.tm')).toBe(true)
    expect(JSON.stringify(figures)).not.toContain('walked-mail-tm')
    expect(JSON.stringify(figures)).not.toContain(registered.agent.id)
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
    })

    /**
     * **The counts are floored and the sentences are not** (`#904`).
     *
     * The floor exists because no aggregate may be reducible to a single
     * citizen, and a rate computed from one attempt is exactly that. A sentence
     * a citizen wrote about a provider's signup form is a different object —
     * and, measured 2026-08-14, one `kolonie.accounts.providers` already serves
     * to any caller with no floor of any kind. Suppressing it here protected
     * nothing and split one answer across two calls, which `kolonie-docs#352`
     * refuses by name.
     */
    it('keeps the sentence on a suppressed row, because it is published anyway', async () => {
      await reported({
        name: 'only-one',
        provider: 'quiet-wall.test',
        outcome: 'signup-refused',
        scrubbed: 'The form demands a business number before it will issue one.',
      })

      const figures = await only('quiet-wall.test')

      expect(figures?.suppressed).toBe(true)
      expect(figures?.attempted).toBe(0)
      expect(figures?.reasons).toEqual([
        'The form demands a business number before it will issue one.',
      ])
    })

    /**
     * **A reason nobody wrote stays absent, and the row still counts.** Measured
     * 2026-08-14, 10 of 16 recorded dead ends carry none. `#904` makes a reason
     * required going forward for the three outcomes that are claims about a
     * provider; the rows already filed keep their count and show nothing.
     */
    it('shows nothing for a report that carried no reason, and still counts it', async () => {
      for (let i = 0; i < ATLAS_FIGURE_FLOOR; i++)
        await reported({
          name: `wordless-${i}`,
          provider: 'silent.test',
          outcome: 'never-provisioned',
        })

      // One of them found the words. The other four are the rows already filed.
      await reported({
        name: 'spoke-up',
        provider: 'silent.test',
        outcome: 'never-provisioned',
        scrubbed: 'Signup returns 200 and the account never appears.',
      })

      const figures = await only('silent.test')

      expect(figures?.suppressed).toBe(false)
      expect(figures?.stopped).toEqual([
        { outcome: 'never-provisioned', citizens: ATLAS_FIGURE_FLOOR + 1 },
      ])
      /** Five of the six said nothing, and the count above is what says six. */
      expect(figures?.reasons).toEqual(['Signup returns 200 and the account never appears.'])
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

    /**
     * **The half of a suppressed row that was missing** (`#1167`).
     *
     * `#792` let the band and the commonest stop through the floor because
     * neither is a count — and on a small row those two are the *pessimistic*
     * half of what is known. A provider three citizens gave up on and a fourth
     * abandoned and then got into published *few got through* and *walks stop
     * most often where they gave up*, with the count that balances them zeroed,
     * permanently: a walk closes once and cannot honestly be restated afterwards
     * (`#1062`, `#1165`). `anyProved` is the other half, and it clears the floor
     * on the same rule the floor is made of — *a citizen got in here* names
     * nobody, and *three did* is a number about three citizens.
     */
    it('says a citizen got in, on a row whose counts it has zeroed', async () => {
      for (let i = 0; i < 3; i++)
        await reported({ name: `gave-up-${i}`, provider: 'late.test', outcome: 'abandoned' })

      const agentId = await citizen('came-back')
      const walkId = await walkInProgress(db, agentId, { kind, provider: 'late.test' })
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await finishWalk(db, walkId, { outcome: 'abandoned' })
      // The afternoon: the same citizen ends up with an account after all.
      await db.execute(sql`
        insert into accounts (agent_id, kind, identifier, provider, proved, proved_at)
        values (${agentId}, ${kind}, 'came-back@example.test', 'late.test', true, now())
      `)

      const figures = await only('late.test')

      expect(figures?.suppressed).toBe(true)
      expect(figures?.proved).toBe(0)
      expect(figures?.anyProved).toBe(true)
      /** And the pessimistic half is untouched: this stands beside it, not over it. */
      expect(figures?.band).toBe('few-got-through')
      expect(figures?.commonestStop).toBe('abandoned')
    })

    /**
     * **Nothing rewrites the walk** (`#1167`, and `#1062` by name). The morning
     * happened; `anyProved` is the later fact standing beside it. The unique
     * index on rewarded walks is what makes a second walk reputation
     * unreachable, and the assertion here is that proving the account opened no
     * second walk for it to be paid on.
     */
    it('leaves the abandoned walk exactly as it was closed', async () => {
      const agentId = await citizen('came-back')
      const walkId = await walkInProgress(db, agentId, { kind, provider: 'late.test' })
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await finishWalk(db, walkId, { outcome: 'abandoned' })
      await db.execute(sql`
        insert into accounts (agent_id, kind, identifier, provider, proved, proved_at)
        values (${agentId}, ${kind}, 'came-back@example.test', 'late.test', true, now())
      `)

      const walks = await db.execute<{ outcome: string; rewarded_at: string | null }>(sql`
        select outcome, rewarded_at from account_walks where agent_id = ${agentId}
      `)

      expect(walks.map((row) => row.outcome)).toEqual(['abandoned'])
      expect(walks[0]?.rewarded_at).toBeNull()
      /** And the figures still say where it stopped, alongside the arrival. */
      expect((await only('late.test'))?.commonestStop).toBe('abandoned')
      expect((await only('late.test'))?.anyProved).toBe(true)
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

  /**
   * The figures and the direction axis (`#990` point 1).
   *
   * `#976` scoped the verdict and left these counts summed, and said so: a
   * counter that counts attempts is true whichever direction was walked. That
   * held while nothing carried a direction. It stopped holding the moment
   * citizens could scope their own reports, because *eight attempts, six
   * failed* then no longer says which eight — and `atlasBand` reads exactly
   * these numbers, so the shelf ordering was reading them too.
   */
  describe('what a reader who asked for one capability is counted', () => {
    const phone = AccountKindSchema.parse('phone')

    /** A citizen saying it did not get one, on the kind that has two. */
    const reportedPhone = async (input: {
      readonly name: string
      readonly provider: string
      readonly direction: 'inbound' | 'outbound' | 'both' | null
      readonly outcome?: string
    }) => {
      const agentId = await citizen(input.name)

      await db.execute(sql`
        insert into provider_reports (agent_id, kind, provider, outcome, reason, scrubbed_reason,
                                      reason_status, direction)
        values (${agentId}, ${phone}, ${input.provider},
                ${sql.raw(`'${input.outcome ?? 'signup-refused'}'`)},
                'the wall', 'the wall', 'approved', ${input.direction})
      `)
    }

    /** A citizen holding a number here, proved — an account carries no direction. */
    const holdsPhone = async (input: { readonly name: string; readonly provider: string }) => {
      const agentId = await citizen(input.name)

      await db.execute(sql`
        insert into accounts (agent_id, kind, identifier, provider, proved, proved_at)
        values (${agentId}, ${phone}, ${`+1555${seeded}`}, ${input.provider}, true, now())
      `)
    }

    const at = async (provider: string, direction?: 'inbound' | 'outbound' | 'both') =>
      (await atlasFigures(db, direction === undefined ? {} : { direction })).find(
        (one) => one.provider === provider,
      )

    /**
     * **Asking nothing gets the sum.** The alternative — keeping the figures
     * permanently split — needs a rule for the reader who asked no direction
     * question, and every version of that rule either invents a default
     * direction or hides half the evidence from somebody who asked for none of
     * it.
     */
    it('sums every direction for a reader who asked about none', async () => {
      for (let i = 0; i < 6; i++)
        await reportedPhone({ name: `in-${i}`, provider: 'agentphone.test', direction: 'inbound' })
      for (let i = 0; i < 6; i++)
        await reportedPhone({
          name: `out-${i}`,
          provider: 'agentphone.test',
          direction: 'outbound',
        })

      expect((await at('agentphone.test'))?.attempted).toBe(12)
    })

    it('counts only the reports that answer the direction asked', async () => {
      for (let i = 0; i < 6; i++)
        await reportedPhone({ name: `in-${i}`, provider: 'agentphone.test', direction: 'inbound' })
      for (let i = 0; i < 6; i++)
        await reportedPhone({
          name: `out-${i}`,
          provider: 'agentphone.test',
          direction: 'outbound',
        })

      expect((await at('agentphone.test', 'inbound'))?.attempted).toBe(6)
      expect((await at('agentphone.test', 'outbound'))?.attempted).toBe(6)
    })

    /**
     * The same conservative reading `directionAnswers` states: a report written
     * before anybody thought to ask which way it pointed is evidence for
     * whoever asks, because reading it as one direction would hide a real
     * refusal from half the readers who need it.
     */
    it('lets an unscoped report answer whichever direction is asked', async () => {
      for (let i = 0; i < 6; i++)
        await reportedPhone({ name: `old-${i}`, provider: 'agentphone.test', direction: null })

      expect((await at('agentphone.test', 'inbound'))?.attempted).toBe(6)
      expect((await at('agentphone.test', 'outbound'))?.attempted).toBe(6)
    })

    it('answers a reader asking about both with whatever there is', async () => {
      for (let i = 0; i < 6; i++)
        await reportedPhone({ name: `in-${i}`, provider: 'agentphone.test', direction: 'inbound' })
      for (let i = 0; i < 6; i++)
        await reportedPhone({
          name: `out-${i}`,
          provider: 'agentphone.test',
          direction: 'outbound',
        })

      expect((await at('agentphone.test', 'both'))?.attempted).toBe(12)
    })

    /**
     * **The accounts half is never narrowed**, because an account carries no
     * direction to narrow it by. Inferring one from the kind is wrong in both
     * directions at once: the `phone` skill is earned inbound, and citizens go
     * on to send from the numbers they hold.
     */
    it('leaves everyone who got through counted, whichever direction is asked', async () => {
      for (let i = 0; i < 6; i++)
        await holdsPhone({ name: `held-${i}`, provider: 'agentphone.test' })
      for (let i = 0; i < 6; i++)
        await reportedPhone({
          name: `out-${i}`,
          provider: 'agentphone.test',
          direction: 'outbound',
        })

      expect((await at('agentphone.test', 'inbound'))?.proved).toBe(6)
      expect((await at('agentphone.test', 'inbound'))?.attempted).toBe(6)
      expect((await at('agentphone.test', 'outbound'))?.proved).toBe(6)
      expect((await at('agentphone.test', 'outbound'))?.attempted).toBe(12)
    })

    /**
     * The worked example from `#976`, now with numbers under it: six citizens
     * stopped by A2P registration, which is a sending wall, and six holding a
     * number that receives. A reader sent to earn `phone` needs the inbound
     * band, and before this the band it got was computed from the sending
     * failures.
     */
    it('bands the two capabilities apart', async () => {
      for (let i = 0; i < 6; i++)
        await holdsPhone({ name: `held-${i}`, provider: 'agentphone.test' })
      for (let i = 0; i < 6; i++)
        await reportedPhone({
          name: `out-${i}`,
          provider: 'agentphone.test',
          direction: 'outbound',
        })

      expect((await at('agentphone.test', 'inbound'))?.band).not.toBe(
        (await at('agentphone.test', 'outbound'))?.band,
      )
      expect((await at('agentphone.test', 'inbound'))?.refused).toBe(0)
      expect((await at('agentphone.test', 'outbound'))?.refused).toBe(6)
    })

    it('scopes the sentences with the counts', async () => {
      for (let i = 0; i < 6; i++)
        await reportedPhone({
          name: `out-${i}`,
          provider: 'agentphone.test',
          direction: 'outbound',
        })

      expect((await at('agentphone.test', 'inbound'))?.reasons).toEqual([])
      expect((await at('agentphone.test', 'outbound'))?.reasons).toEqual(['the wall'])
    })

    /**
     * **A direction narrows the sample and the floor is right about the
     * remainder.** Nothing here exempts a scoped read: a rate computed from two
     * citizens is a claim about two citizens whichever way they went.
     */
    it('suppresses a direction whose sample falls below the floor', async () => {
      for (let i = 0; i < 6; i++)
        await reportedPhone({
          name: `out-${i}`,
          provider: 'agentphone.test',
          direction: 'outbound',
        })
      for (let i = 0; i < ATLAS_FIGURE_FLOOR - 1; i++)
        await reportedPhone({ name: `in-${i}`, provider: 'agentphone.test', direction: 'inbound' })

      expect((await at('agentphone.test'))?.suppressed).toBe(false)
      expect((await at('agentphone.test', 'inbound'))?.suppressed).toBe(true)
      expect((await at('agentphone.test', 'inbound'))?.attempted).toBe(0)
    })

    /**
     * **The scoping narrows what a row says and never which rows exist.** A
     * provider dropped for one reader would be the Colony saying *this provider
     * has no page* to that reader on the grounds that the citizens who went
     * there went the other way — which is the argument for walking it rather
     * than against listing it. `evidenced` goes with the row for the same
     * reason: `backfillMeasuredProviders` has no direction to ask about, and
     * the two must not disagree.
     */
    it('keeps a provider on the shelf when every report went the other way', async () => {
      for (let i = 0; i < 6; i++)
        await reportedPhone({
          name: `out-${i}`,
          provider: 'agentphone.test',
          direction: 'outbound',
        })

      const inbound = await at('agentphone.test', 'inbound')

      expect(inbound).toBeDefined()
      expect(inbound?.evidenced).toBe(true)
      expect(inbound?.attempted).toBe(0)
      expect(inbound?.stopped).toEqual([])
    })

    /**
     * A kind with no axis has no direction on any of its rows, so every one of
     * them is unscoped and every reader is answered — the mailbox figures do
     * not move when somebody asks a question that cannot be about them.
     */
    it('leaves a kind that has no axis alone', async () => {
      for (let i = 0; i < 6; i++)
        await reported({ name: `mail-${i}`, provider: 'mail.tm', outcome: 'signup-refused' })

      expect((await at('mail.tm', 'inbound'))?.attempted).toBe(6)
      expect((await at('mail.tm'))?.attempted).toBe(6)
    })
  })
})
