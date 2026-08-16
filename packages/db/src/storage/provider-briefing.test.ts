import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  CURRENT_PROVIDER_CLAIM_WALKS,
  figureKey,
  type AgentId,
  type ProviderBriefingClaim,
} from '@kolonie-ai/core'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../client.js'
import { providerBriefings } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { finishWalk, recordWalkProseModeration, walkInProgress } from './account-walks.js'
import { renameProvider } from './atlas-renames.js'
import { providerRecipe, writeProviderRecipe } from './provider-recipes.js'
import {
  markProviderBriefingStale,
  providerBriefingCorpus,
  providerBriefingCounts,
  providerBriefingsAt,
  readProviderBriefing,
  readProviderDescription,
  staleProviderBriefings,
  writeProviderBriefing,
  writeProviderDescription,
} from './provider-briefing.js'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * The Colony's write-up of a provider, against a real Postgres (`#831`).
 *
 * **What only a database can answer**, which is the division `briefing.test.ts`
 * draws: the currency rule is a pure function tested in `packages/core`, and what
 * is asserted here is the query that supplies its window — a count over every
 * finished walk of a provider, which no fake can be trusted to reproduce. The rest
 * is the same list `task_briefings` had to earn: the round trip, the empty
 * synthesis that deletes rather than stores, the rename resolved before anything
 * is matched, and a stored claim that no longer validates costing that claim
 * alone.
 */
describe('the briefing the Colony writes about a provider', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    const agent = await registerAgent(db, { name: 'walker', platform: 'openclaw', operator: null })
    if (agent.outcome !== 'registered') throw new Error('could not register the walking agent')
    agentId = agent.agent.id
  })

  const where = { kind: kind('mailbox'), provider: 'somewhere.example' }

  const aClaim = (overrides: Partial<ProviderBriefingClaim> = {}): ProviderBriefingClaim => ({
    section: 'wall',
    text: 'Signup asks for a phone number on the last step.',
    walks: 1,
    platforms: { openclaw: 1 },
    lastSupportedAt: new Date().toISOString(),
    sources: [crypto.randomUUID()],
    ...overrides,
  })

  /**
   * One finished walk of `where`, moderated unless a test says otherwise.
   *
   * The prose goes in `did`, which every outcome keeps — `wall` is stored only on
   * a refusal, so a helper that used it would silently produce a wordless walk the
   * moment a test asked for a walk that got through. A refusal still names one,
   * because the column check refuses a refusal that does not.
   *
   * **Each walk says something of its own** (`#1104`). A report that repeats a
   * published one is stored as the repeat it is and never published again, so a
   * helper handing every walk the same sentence would have produced one walk with
   * prose and a queue of copies — which is not what these counts are about.
   */
  const aWalk = async (
    options: {
      readonly outcome?: 'proved' | 'refused' | 'abandoned'
      readonly said?: string
      readonly moderated?: boolean
    } = {},
  ): Promise<string> => {
    const did =
      options.said ??
      `I filled in the signup form and it wanted a number to text, ticket ${crypto.randomUUID()}.`
    const outcome = options.outcome ?? 'abandoned'
    const wall = outcome === 'refused' ? 'it wanted a phone number' : undefined
    const prose = wall === undefined ? { did } : { did, wall }
    const walkId = await walkInProgress(db, agentId, where)
    await finishWalk(db, walkId, { outcome, did, ...(wall === undefined ? {} : { wall }) })

    if (options.moderated !== false) {
      const written = await recordWalkProseModeration(db, {
        walkId,
        judged: prose,
        decision: 'approved',
        scrubbed: prose,
      })
      if (written.outcome !== 'written') throw new Error('the moderation did not land')
    }

    return walkId
  }

  describe('storing one', () => {
    it('reads back what was written, with the model and the date beside it', async () => {
      await writeProviderBriefing(db, { ...where, claims: [aClaim()], model: 'fake/test-model' })

      const briefing = await readProviderBriefing(db, where)

      expect(briefing?.kind).toBe('mailbox')
      expect(briefing?.provider).toBe('somewhere.example')
      expect(briefing?.model).toBe('fake/test-model')
      expect(briefing?.writtenAt).toEqual(expect.any(String))
      expect(briefing?.claims[0]?.text).toBe('Signup asks for a phone number on the last step.')
    })

    /**
     * The distinction the nullable pair exists for: a row created by the
     * dirty-marking is *not written up yet*, and that is a different answer from
     * *nobody has walked this*. Both read as no briefing, and neither is an error.
     */
    it('answers nothing for a provider queued but never written up', async () => {
      expect(await readProviderBriefing(db, where)).toBeUndefined()

      await markProviderBriefingStale(db, where)

      expect(await readProviderBriefing(db, where)).toBeUndefined()
      expect(await providerBriefingCounts(db)).toEqual({ written: 0, stale: 1 })
    })

    /**
     * **No claims, no row** (`#611`). A briefing with nothing in it makes an offer
     * that cannot be met and reads as coverage where there is none — so the
     * synthesis that produces nothing removes what was there rather than emptying
     * it, and the queue entry goes with it.
     */
    it('deletes the row when a later synthesis produces nothing', async () => {
      await writeProviderBriefing(db, { ...where, claims: [aClaim()], model: 'fake/test-model' })
      await writeProviderBriefing(db, { ...where, claims: [], model: 'fake/test-model' })

      expect(await readProviderBriefing(db, where)).toBeUndefined()
      expect(await providerBriefingCounts(db)).toEqual({ written: 0, stale: 0 })
      expect(await staleProviderBriefings(db, 10)).toEqual([])
    })

    /**
     * The flag is cleared whatever happened while the synthesis was in flight. A
     * briefing is allowed to be one walk behind; the next approved walk queues it
     * again, and until then a tick that rewrote it would spend a model call to
     * produce the text it already has.
     */
    it('takes the provider off the queue once it has been written', async () => {
      await markProviderBriefingStale(db, where)
      await writeProviderBriefing(db, { ...where, claims: [aClaim()], model: 'fake/test-model' })

      expect(await staleProviderBriefings(db, 10)).toEqual([])
      expect(await providerBriefingCounts(db)).toEqual({ written: 1, stale: 0 })
    })

    /**
     * **The seam that keeps a briefing honest**, and the reason the marking lives
     * inside `recordWalkProseModeration` rather than beside its callers: a path
     * that approved prose and forgot to queue the provider would leave a citizen
     * reading a wall that has since been described as gone.
     */
    it('queues the provider when a walk of it is approved', async () => {
      await aWalk()

      expect(await staleProviderBriefings(db, 10)).toEqual([where])
    })
  })

  /**
   * Which claims stand in the foreground, and it is the half of the rule a fake
   * cannot supply: the window is a query over every finished walk of the provider.
   */
  describe('the currency of a claim', () => {
    const long = 200 * 24 * 60 * 60 * 1000
    const old = () => new Date(Date.now() - long).toISOString()

    const write = async (claim: ProviderBriefingClaim) =>
      writeProviderBriefing(db, { ...where, claims: [claim], model: 'fake/test-model' })

    it('leaves an old claim current while the provider has had few walks', async () => {
      for (let i = 0; i < CURRENT_PROVIDER_CLAIM_WALKS - 1; i++) await aWalk({ moderated: false })
      await write(aClaim({ lastSupportedAt: old() }))

      const briefing = await readProviderBriefing(db, where)

      expect(briefing?.claims[0]?.current).toBe(true)
    })

    /**
     * Both bounds have to be past before a claim is demoted, and this is the case
     * that pins the walk one: twenty walks have finished since, and the claim is
     * older than the day bound is generous about.
     */
    it('demotes a claim the walks have moved past, once it is old as well', async () => {
      for (let i = 0; i < CURRENT_PROVIDER_CLAIM_WALKS; i++) await aWalk({ moderated: false })
      await write(aClaim({ lastSupportedAt: old() }))

      const briefing = await readProviderBriefing(db, where)

      expect(briefing?.claims[0]?.current).toBe(false)
      // Demoted, never deleted: a wall that stood in June can be gone in
      // September, and a reader is shown the claim with its date beside it.
      expect(briefing?.claims).toHaveLength(1)
    })

    /** The day bound is the more generous one, and it wins on its own. */
    it('keeps a recent claim current however many walks have finished since', async () => {
      for (let i = 0; i < CURRENT_PROVIDER_CLAIM_WALKS + 5; i++) await aWalk({ moderated: false })
      await write(aClaim({ lastSupportedAt: new Date().toISOString() }))

      expect((await readProviderBriefing(db, where))?.claims[0]?.current).toBe(true)
    })

    /**
     * **A walk whose words were refused still happened.** The window measures how
     * much has gone on at the provider since a claim was last confirmed, and
     * counting only the servable walks would make a busy provider look quiet and
     * hold a stale claim in the foreground. The walks above are unmoderated on
     * purpose; this is the same count with the moderation, and it must not differ.
     */
    it('counts every finished walk, moderated or not', async () => {
      for (let i = 0; i < CURRENT_PROVIDER_CLAIM_WALKS; i++) await aWalk()
      await write(aClaim({ lastSupportedAt: old() }))

      expect((await readProviderBriefing(db, where))?.claims[0]?.current).toBe(false)
    })

    /** A walk of another provider is not evidence that this one moved on. */
    it('counts only the walks of the provider in question', async () => {
      for (let i = 0; i < CURRENT_PROVIDER_CLAIM_WALKS; i++) {
        const walkId = await walkInProgress(db, agentId, {
          kind: where.kind,
          provider: 'elsewhere.example',
        })
        await finishWalk(db, walkId, { outcome: 'proved' })
      }
      await write(aClaim({ lastSupportedAt: old() }))

      expect((await readProviderBriefing(db, where))?.claims[0]?.current).toBe(true)
    })
  })

  /**
   * **A stored claim that no longer validates costs that claim, never the
   * provider** (`#729`). The failure the task side learned the hard way: a
   * briefing is guidance, and losing one sentence of it is incomparably better
   * than losing the Atlas entry it hangs off.
   */
  it('drops a claim it cannot serve and serves the rest', async () => {
    const good = aClaim({ text: 'The confirmation mail arrived within a minute.' })
    await writeProviderBriefing(db, { ...where, claims: [good], model: 'fake/test-model' })

    await db
      .update(providerBriefings)
      .set({
        claims: [
          { ...good, section: 'a section nobody defined' },
          good,
        ] as unknown as ProviderBriefingClaim[],
      })
      .where(
        and(eq(providerBriefings.kind, where.kind), eq(providerBriefings.provider, where.provider)),
      )

    const briefing = await readProviderBriefing(db, where)

    expect(briefing?.claims).toHaveLength(1)
    expect(briefing?.claims[0]?.text).toBe('The confirmation mail arrived within a minute.')
  })

  /**
   * What an Atlas entry reads: every kind at one provider, keyed the way its
   * figures already are so a page holding both looks them up the same way.
   */
  describe('every briefing at one provider', () => {
    it('keys them the way the figures are keyed, and answers for one provider', async () => {
      await writeProviderBriefing(db, { ...where, claims: [aClaim()], model: 'fake/test-model' })
      await writeProviderBriefing(db, {
        kind: kind('domain'),
        provider: where.provider,
        claims: [aClaim({ section: 'route', text: 'The nameserver change took under an hour.' })],
        model: 'fake/test-model',
      })
      await writeProviderBriefing(db, {
        kind: where.kind,
        provider: 'elsewhere.example',
        claims: [aClaim()],
        model: 'fake/test-model',
      })

      const at = await providerBriefingsAt(db, where.provider)

      expect([...at.keys()].sort()).toEqual(
        [figureKey(kind('domain'), where.provider), figureKey(where.kind, where.provider)].sort(),
      )
    })

    /** A queued row is not a briefing, and a page must not render an empty one. */
    it('skips a provider queued but never written up', async () => {
      await markProviderBriefingStale(db, where)

      expect(await providerBriefingsAt(db, where.provider)).toEqual(new Map())
    })

    /**
     * **One row per provider survives a rename, and the old name still reaches
     * it** (`#772`). Every door here resolves the name before it matches, so a
     * briefing written under a name that has since moved lands on the canonical
     * row rather than beside it — which is what stops a renamed provider from
     * collecting two write-ups, one of which no reader can ever be served.
     *
     * The corpus behind it moves the same way: `moderatedWalkProse` canonicalises
     * too, so the synthesis that runs after a rename reads and writes the same
     * provider a reader asks about under either name.
     */
    it('writes and reads one briefing under either name after a rename', async () => {
      await renameProvider(db, where.provider, 'renamed.example')
      await writeProviderBriefing(db, { ...where, claims: [aClaim()], model: 'fake/test-model' })

      expect([...(await providerBriefingsAt(db, where.provider)).keys()]).toEqual([
        figureKey(where.kind, 'renamed.example'),
      ])
      expect([...(await providerBriefingsAt(db, 'renamed.example')).keys()]).toEqual([
        figureKey(where.kind, 'renamed.example'),
      ])
      expect((await readProviderBriefing(db, where))?.provider).toBe('renamed.example')
    })
  })

  /**
   * The corpus the synthesis is handed. Everything that decides *which* walks
   * belongs to `moderatedWalkProse` and is asserted there; what is asserted here
   * is the shape — that each walk arrives with the four facts a claim is built
   * from, and its scrubbed words rather than its raw ones.
   */
  describe('the corpus behind one', () => {
    it('hands over the moderated walks, newest first, with how each ended', async () => {
      await aWalk({ outcome: 'refused', said: 'The last page wanted a phone number.' })
      await aWalk({ outcome: 'proved', said: 'The confirmation mail arrived within a minute.' })

      const corpus = await providerBriefingCorpus(db, where)

      expect(corpus).toHaveLength(2)
      expect(corpus[0]?.outcome).toBe('proved')
      expect(corpus[1]?.outcome).toBe('refused')
      expect(corpus[0]?.platform).toBe('openclaw')
      expect(corpus[0]?.finishedAt).toEqual(expect.any(String))
      expect(corpus[1]?.content).toContain('The last page wanted a phone number.')
    })

    it('leaves out a walk whose words no moderator has passed', async () => {
      await aWalk({ moderated: false })

      expect(await providerBriefingCorpus(db, where)).toEqual([])
    })
  })

  /**
   * The one sentence saying what the provider *is* (`#1120`).
   *
   * It lives on the entry rather than on the briefing row, and every test here is
   * about that decision holding: the briefing is deleted when a synthesis produces
   * nothing (`#611`) and the description must not go with it, a curator editing the
   * entry must not wipe it, and a provider nobody has written an entry for has
   * nothing to describe.
   */
  describe('the sentence saying what a provider is', () => {
    const anEntry = async (
      overrides: {
        readonly provider?: string
        readonly status?: 'joinable' | 'refused'
        readonly about?: string
      } = {},
    ) =>
      writeProviderRecipe(db, {
        kind: where.kind,
        provider: overrides.provider ?? where.provider,
        title: 'Somewhere',
        status: overrides.status ?? 'joinable',
        category: 'mailbox',
        /** A refusal carries no route, and the constraint pair says so both ways. */
        ...(overrides.status === 'refused'
          ? { steps: [], refusal: 'The signup demands a natural person and says so.' }
          : {
              steps: [{ actor: 'agent' as const, instruction: 'open the signup page' }],
              proves: 'provider-mail' as const,
            }),
        ...(overrides.about === undefined ? {} : { about: overrides.about }),
      })

    const sentence = 'A disposable mailbox service with a web inbox and no signup.'

    it('reads back what was written onto the entry', async () => {
      await anEntry()

      expect(await writeProviderDescription(db, { ...where, description: sentence })).toBe(true)
      expect(await readProviderDescription(db, where)).toBe(sentence)
    })

    /** Nothing has been written yet, which is not the same as an empty sentence. */
    it('answers nothing for an entry the runner has not reached', async () => {
      await anEntry()

      expect(await readProviderDescription(db, where)).toBeNull()
    })

    /**
     * **The whole reason this is a second write** (`#1120`, 8). A synthesis that
     * produces no claims deletes the briefing row, and a description folded into
     * that write would be deleted with it — losing the sentence saying what the
     * provider is because its *walls* happened to be unquotable this week.
     */
    it('survives a synthesis that produces nothing and deletes the briefing', async () => {
      await anEntry()
      await writeProviderDescription(db, { ...where, description: sentence })
      await writeProviderBriefing(db, { ...where, claims: [aClaim()], model: 'fake/test-model' })

      await writeProviderBriefing(db, { ...where, claims: [], model: 'fake/test-model' })

      expect(await readProviderBriefing(db, where)).toBeUndefined()
      expect(await readProviderDescription(db, where)).toBe(sentence)
    })

    /**
     * **A curator's edit does not touch it**, the arrangement `walls` has had since
     * `#981`. The upsert omits the column on purpose, so a typo fixed in `about`
     * cannot delete a sentence the Colony paid a model to write.
     */
    it('is left alone by a curation edit of the same entry', async () => {
      await anEntry({ about: 'The first paragraph a curator wrote.' })
      await writeProviderDescription(db, { ...where, description: sentence })

      await anEntry({ about: 'The paragraph, with the typo fixed.' })

      expect((await providerRecipe(db, where.kind, where.provider))?.about).toBe(
        'The paragraph, with the typo fixed.',
      )
      expect(await readProviderDescription(db, where)).toBe(sentence)
    })

    /**
     * A refusal is a page a reader is *most* likely to arrive at cold, so it gets
     * the sentence like any other entry: the description says what the provider is,
     * and whether the Colony got in is the rest of the page's business.
     */
    it('is written onto a refused entry like any other', async () => {
      await anEntry({ status: 'refused' })

      expect(await writeProviderDescription(db, { ...where, description: sentence })).toBe(true)
      expect(await readProviderDescription(db, where)).toBe(sentence)
    })

    /**
     * **An update and never an insert.** A provider with walks behind it but no
     * Atlas entry has nothing to describe — writing a row here would create a
     * recipe with a description and no recipe in it. The `false` is what lets the
     * runner say so in its log rather than treat it as a failure.
     */
    it('writes nothing for a provider with no entry, and says so', async () => {
      expect(await writeProviderDescription(db, { ...where, description: sentence })).toBe(false)
      expect(await readProviderDescription(db, where)).toBeNull()
    })

    /** The same door every other call here goes through (`#772`). */
    it('resolves a rename before it matches, either way round', async () => {
      await anEntry()
      await renameProvider(db, where.provider, 'renamed.example')

      expect(await writeProviderDescription(db, { ...where, description: sentence })).toBe(true)
      expect(await readProviderDescription(db, { ...where, provider: 'renamed.example' })).toBe(
        sentence,
      )
      expect(await readProviderDescription(db, where)).toBe(sentence)
    })

    /** What an emptied corpus asks for: the page goes back to having no sentence. */
    it('clears the sentence when the runner writes null', async () => {
      await anEntry()
      await writeProviderDescription(db, { ...where, description: sentence })

      expect(await writeProviderDescription(db, { ...where, description: null })).toBe(true)
      expect(await readProviderDescription(db, where)).toBeNull()
    })
  })
})
