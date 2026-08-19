import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  RegisterAgentRequestSchema,
  earnFacetsOf,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from './client.js'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'
import { backfillAtlasIdentity } from './atlas-identity-backfill.js'
import { registerAgent } from './storage/agents.js'
import { finishWalk, recordWalkStep, walkInProgress } from './storage/account-walks.js'
import {
  providerRecipe,
  writeProviderRecipe,
  writeRecipeEarnFacets,
} from './storage/provider-recipes.js'

const target = databaseTestTarget()
const BOUNTY = AccountKindSchema.parse('bounty-board')
const MAILBOX = AccountKindSchema.parse('mailbox')

/**
 * The rows that predate the writers, filled from what the database holds
 * (`#1335`).
 *
 * **Against a real Postgres**, on `atlas-backfill.test.ts`' reason: the whole of
 * it is a query over two tables the Colony already fills, and what is under test
 * is that it can read its own records without asking a citizen for anything.
 */
describe('backfilling homepage and earn facets onto the rows that predate them', () => {
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

  /**
   * A walk that filed a homepage, closed. The entry is written afterwards with
   * `homepage: null` on purpose — that is the shape the rows this pass exists
   * for are actually in, and building it any other way would be testing the
   * forward writer instead.
   */
  const walkFiling = async (input: {
    readonly kind: typeof BOUNTY
    readonly provider: string
    readonly homepage: string
    readonly who: string
  }) => {
    const agentId = await citizen(input.who)
    const walkId = await walkInProgress(db, agentId, {
      kind: input.kind,
      provider: input.provider,
    })
    await recordWalkStep(db, walkId, { actor: 'agent' })
    await finishWalk(db, walkId, {
      outcome: 'sighted',
      about: 'A board that posts paid tasks.',
      homepage: input.homepage,
    })
  }

  const thinRow = async (kind: typeof BOUNTY, provider: string) =>
    writeProviderRecipe(db, {
      kind,
      provider,
      title: provider,
      status: 'measured',
      category: 'data-apis',
      steps: [],
    })

  it('copies the homepage from the walk that filed it', async () => {
    await walkFiling({
      kind: BOUNTY,
      provider: 'boards.example',
      homepage: 'https://boards.example',
      who: 'scout',
    })
    await thinRow(BOUNTY, 'boards.example')

    const result = await backfillAtlasIdentity(db)

    expect(result.homepages).toBe(1)
    expect((await providerRecipe(db, BOUNTY, 'boards.example'))?.homepage).toBe(
      'https://boards.example',
    )
    expect(result.providers).toContain('boards.example')
  })

  it('reads the earn facet off the kind', async () => {
    await thinRow(BOUNTY, 'facets.example')

    const result = await backfillAtlasIdentity(db)

    expect(result.facets).toBe(1)
    expect(
      earnFacetsOf((await providerRecipe(db, BOUNTY, 'facets.example'))?.facets ?? []),
    ).toEqual(['bounty-board'])
  })

  /**
   * **The earliest walk that filed one wins** (`#1330` decision 2), so a
   * backfilled row and a walked row end up with the same value — and the tenth
   * walker mistyping a domain cannot redirect a public page through this pass
   * either.
   */
  it('takes the earliest homepage where two walks filed different ones', async () => {
    await walkFiling({
      kind: BOUNTY,
      provider: 'contested.example',
      homepage: 'https://contested.example',
      who: 'first',
    })
    await walkFiling({
      kind: BOUNTY,
      provider: 'contested.example',
      homepage: 'https://contested.example/typo',
      who: 'second',
    })
    await thinRow(BOUNTY, 'contested.example')

    await backfillAtlasIdentity(db)

    expect((await providerRecipe(db, BOUNTY, 'contested.example'))?.homepage).toBe(
      'https://contested.example',
    )
  })

  /**
   * **It copies and never invents.** A row nobody filed a homepage for is left
   * null and counted, which is the honest answer and the one the page already
   * renders correctly by omitting the block.
   */
  it('leaves a row null where no walk filed a homepage, and says how many', async () => {
    await thinRow(BOUNTY, 'silent.example')

    const result = await backfillAtlasIdentity(db)

    expect(result.homepages).toBe(0)
    expect(result.withoutSource).toBe(1)
    expect((await providerRecipe(db, BOUNTY, 'silent.example'))?.homepage).toBeNull()
  })

  /**
   * **It never overwrites a homepage already held**, which is the same
   * precedence the forward writer takes: an identity that moves under a reader
   * is not an identity.
   */
  it('leaves a homepage that is already there alone', async () => {
    await walkFiling({
      kind: BOUNTY,
      provider: 'held.example',
      homepage: 'https://held.example/from-the-walk',
      who: 'scout',
    })
    await writeProviderRecipe(db, {
      kind: BOUNTY,
      provider: 'held.example',
      title: 'held.example',
      status: 'measured',
      category: 'data-apis',
      steps: [],
      homepage: 'https://held.example',
    })

    const result = await backfillAtlasIdentity(db)

    expect(result.homepages).toBe(0)
    expect((await providerRecipe(db, BOUNTY, 'held.example'))?.homepage).toBe(
      'https://held.example',
    )
  })

  /**
   * **It cannot withdraw a facet a moderator set**, because the write is the
   * union rather than the replacement.
   *
   * The kind's own facet is still added — a bounty board is a bounty board
   * whatever else somebody said about it — so what this asserts is that the two
   * claims stand together. A pass that replaced would have dropped the referral
   * on every provider it touched, silently, which is the shape
   * `addRecipeEarnFacets` exists to refuse.
   */
  it('keeps a facet a moderator set, and adds the one the kind carries', async () => {
    await thinRow(BOUNTY, 'classified.example')
    await writeRecipeEarnFacets(db, BOUNTY, 'classified.example', ['affiliate-referral'])

    const result = await backfillAtlasIdentity(db)

    expect(result.facets).toBe(1)
    expect(
      earnFacetsOf((await providerRecipe(db, BOUNTY, 'classified.example'))?.facets ?? []),
    ).toEqual(['affiliate-referral', 'bounty-board'])
  })

  /** And a row already carrying the kind's own facet is not counted again. */
  it('adds nothing to a row that already carries the facet its kind maps to', async () => {
    await thinRow(BOUNTY, 'already.example')
    await writeRecipeEarnFacets(db, BOUNTY, 'already.example', ['bounty-board'])

    expect((await backfillAtlasIdentity(db)).facets).toBe(0)
  })

  /** A kind that is not an earn rail gets nothing, which is `#1301`'s rule. */
  it('reads no facet off a kind that is not an earn rail', async () => {
    await writeProviderRecipe(db, {
      kind: MAILBOX,
      provider: 'plain.example',
      title: 'plain.example',
      status: 'measured',
      category: 'mailbox',
      steps: [],
    })

    const result = await backfillAtlasIdentity(db)

    expect(result.facets).toBe(0)
  })

  /**
   * **A dry run reports exactly what a wet run would and writes nothing** — that
   * is what makes it worth having on a pass that touches the public catalogue.
   */
  it('reports the same counts in a dry run, and changes nothing', async () => {
    await walkFiling({
      kind: BOUNTY,
      provider: 'dry.example',
      homepage: 'https://dry.example',
      who: 'scout',
    })
    await thinRow(BOUNTY, 'dry.example')

    const dry = await backfillAtlasIdentity(db, { dryRun: true })

    expect(dry.homepages).toBe(1)
    expect(dry.facets).toBe(1)
    expect((await providerRecipe(db, BOUNTY, 'dry.example'))?.homepage).toBeNull()
    expect(earnFacetsOf((await providerRecipe(db, BOUNTY, 'dry.example'))?.facets ?? [])).toEqual(
      [],
    )

    const wet = await backfillAtlasIdentity(db)

    expect(wet.homepages).toBe(dry.homepages)
    expect(wet.facets).toBe(dry.facets)
  })

  /**
   * **Idempotent**, which is what lets it live in the seed and run on every
   * deploy. Zero is the difference between *this did nothing* and *this had
   * nothing to do*.
   */
  it('writes nothing on a second pass', async () => {
    await walkFiling({
      kind: BOUNTY,
      provider: 'twice.example',
      homepage: 'https://twice.example',
      who: 'scout',
    })
    await thinRow(BOUNTY, 'twice.example')

    await backfillAtlasIdentity(db)
    const again = await backfillAtlasIdentity(db)

    expect(again.homepages).toBe(0)
    expect(again.facets).toBe(0)
    expect(again.providers).toEqual([])
  })
})
