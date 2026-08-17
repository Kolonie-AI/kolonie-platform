import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  AtlasCategoryProposalDraftSchema,
  RegisterAgentRequestSchema,
  type AgentId,
  type AtlasCategoryProposalDraft,
} from '@kolonie-ai/core'
import type { Database } from './client.js'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'
import { registerAgent } from './storage/agents.js'
import {
  atlasCategoriesHeld,
  atlasCategoriesSettled,
  atlasCategoryProposalQueue,
  decideAtlasCategoryProposal,
  openAtlasCategoryProposal,
  openAtlasCategoryProposals,
} from './storage/atlas-category-proposals.js'

const target = databaseTestTarget()

/**
 * The queue between a model reading walks and a maintainer agreeing (`#1106`).
 *
 * **Against a real Postgres, because half of what this issue decided is written
 * in the schema rather than in the code above it.** *A new top category may never
 * be proposed*, *at most one open proposal per pair*, *a pairing is settled once*
 * and *a decline says why* are all constraints and indexes; a suite with a faked
 * handle would assert the code path that never reaches them, which is the half
 * that was never in doubt.
 */
describe('proposing where a provider belongs', () => {
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
      RegisterAgentRequestSchema.parse({ name: `walker-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)

    return result.agent.id
  }

  /** One moderated walk, which is the only thing that puts a pair in the queue. */
  const walk = async (input: {
    readonly kind: string
    readonly provider: string
    readonly moderated?: boolean
  }): Promise<string> => {
    const agentId = await citizen()
    const prose =
      input.moderated === false ? null : JSON.stringify({ did: 'Signed up and it worked.' })
    const [row] = await db.execute<{ id: string }>(sql`
      insert into account_walks (agent_id, kind, provider, finished_at, outcome, scrubbed_prose)
      values (${agentId}, ${input.kind}, ${input.provider}, now(), 'proved', ${prose}::jsonb)
      returning id
    `)

    if (row === undefined) throw new Error('no walk')

    return row.id
  }

  /** A catalogue entry, written the way `#807`'s walk path writes one. */
  const entry = async (input: {
    readonly kind: string
    readonly provider: string
    readonly category: string
  }): Promise<void> => {
    await db.execute(sql`
      insert into provider_recipes (kind, provider, title, category, status, steps)
      values (${input.kind}, ${input.provider}, ${input.provider}, ${input.category},
              'measured', '[]'::jsonb)
    `)
  }

  const draft = (input: Record<string, unknown>): AtlasCategoryProposalDraft =>
    AtlasCategoryProposalDraftSchema.parse({
      shape: 'existing',
      category: 'knowledge-docs',
      why: 'Three walkers described it as the place they keep their notes.',
      ...input,
    })

  const raise = async (input: {
    readonly kind: string
    readonly provider: string
    readonly draft: AtlasCategoryProposalDraft
  }) =>
    await openAtlasCategoryProposal(db, {
      kind: input.kind,
      provider: input.provider,
      draft: input.draft,
      model: 'the-model-configuration-named',
    })

  const shelvesOf = async (provider: string): Promise<readonly string[]> => {
    const rows = await db.execute<{ category_slug: string; primary: boolean }>(sql`
      select c.category_slug, c."primary"
        from provider_recipe_categories c
        join provider_recipes r on r.id = c.recipe_id
       where r.provider = ${provider}
       order by c."primary" desc, c.category_slug asc
    `)

    return rows.map((row) => `${row.category_slug}${row.primary ? ' (primary)' : ''}`)
  }

  /**
   * `#1096`'s population, which is the queue: a kind the taxonomy has no shelf
   * for, so the entry a reader sees was defaulted rather than classified.
   */
  it('offers a pair whose kind reaches no shelf', async () => {
    await walk({ kind: 'ticketing', provider: 'tickets.example' })

    expect(await atlasCategoryProposalQueue(db)).toEqual([
      { kind: 'ticketing', provider: 'tickets.example' },
    ])
  })

  /** Criterion 10: a shelf `atlasCategoryForKind` chose is not a fallback. */
  it('offers nothing for a pair whose kind names a shelf', async () => {
    await walk({ kind: 'mailbox', provider: 'mail.example' })

    expect(await atlasCategoryProposalQueue(db)).toEqual([])
  })

  /** Decision 4 again, one layer down: a pair nobody wrote about cites nothing. */
  it('offers nothing for a pair whose walks were never moderated', async () => {
    await walk({ kind: 'ticketing', provider: 'tickets.example', moderated: false })

    expect(await atlasCategoryProposalQueue(db)).toEqual([])
  })

  /** Decision 6, held before a model call rather than after one. */
  it('offers nothing for a pair that already has an open proposal', async () => {
    const walkId = await walk({ kind: 'ticketing', provider: 'tickets.example' })
    await raise({
      kind: 'ticketing',
      provider: 'tickets.example',
      draft: draft({ walks: [walkId] }),
    })

    expect(await atlasCategoryProposalQueue(db)).toEqual([])
  })

  it('records the walks a proposal was read from', async () => {
    const walkId = await walk({ kind: 'ticketing', provider: 'tickets.example' })

    const result = await raise({
      kind: 'ticketing',
      provider: 'tickets.example',
      draft: draft({ walks: [walkId] }),
    })

    expect(result.outcome).toBe('raised')
    const [waiting] = await openAtlasCategoryProposals(db)
    expect(waiting?.walks).toEqual([walkId])
    expect(waiting?.category).toBe('knowledge-docs')
  })

  /** Decision 4 at the schema: there is no draft with an empty citation. */
  it('refuses a draft citing no walk', () => {
    expect(() => draft({ walks: [] })).toThrow()
  })

  /**
   * Decision 3, and the criterion says *rejected by the schema, not merely
   * unhandled by the prompt*: there is no shape here that omits a parent.
   */
  it('refuses a proposal for a new top category', () => {
    expect(() =>
      AtlasCategoryProposalDraftSchema.parse({
        shape: 'new-sub',
        category: 'ticketing',
        title: 'Ticketing',
        standfirst: 'Where a citizen raises a ticket.',
        why: 'Nothing here is a ticket tracker.',
        walks: ['00000000-0000-4000-8000-000000000000'],
      }),
    ).toThrow()
  })

  /** Decision 6 at the index, for the two ticks a second apart the loop can produce. */
  it('refuses a second open proposal for one pair', async () => {
    const walkId = await walk({ kind: 'ticketing', provider: 'tickets.example' })
    await raise({
      kind: 'ticketing',
      provider: 'tickets.example',
      draft: draft({ walks: [walkId] }),
    })

    const second = await raise({
      kind: 'ticketing',
      provider: 'tickets.example',
      draft: draft({ walks: [walkId], category: 'project-tracking' }),
    })

    expect(second.outcome).toBe('already-open')
    expect(await openAtlasCategoryProposals(db)).toHaveLength(1)
  })

  /** Decision 8: an entry gains the shelf as an additional one, and nothing else moves. */
  it('accepting an existing shelf writes the join row and leaves the primary alone', async () => {
    const walkId = await walk({ kind: 'ticketing', provider: 'tickets.example' })
    await entry({ kind: 'ticketing', provider: 'tickets.example', category: 'data-apis' })
    const raised = await raise({
      kind: 'ticketing',
      provider: 'tickets.example',
      draft: draft({ walks: [walkId] }),
    })
    if (raised.outcome !== 'raised') throw new Error(raised.outcome)

    const decided = await decideAtlasCategoryProposal(db, {
      id: raised.proposal.id,
      decision: { decision: 'accept' },
    })

    expect(decided.outcome).toBe('decided')
    expect(await shelvesOf('tickets.example')).toEqual(['data-apis (primary)', 'knowledge-docs'])
  })

  /**
   * The `#1096` half: the pair has no catalogue row at all, so the shelf it was
   * accepted onto is the row, and the trigger writes the join row from it.
   */
  it('accepting for a pair with no entry writes the entry on that shelf', async () => {
    const walkId = await walk({ kind: 'ticketing', provider: 'tickets.example' })
    const raised = await raise({
      kind: 'ticketing',
      provider: 'tickets.example',
      draft: draft({ walks: [walkId] }),
    })
    if (raised.outcome !== 'raised') throw new Error(raised.outcome)

    expect(
      (
        await decideAtlasCategoryProposal(db, {
          id: raised.proposal.id,
          decision: { decision: 'accept' },
        })
      ).outcome,
    ).toBe('decided')

    expect(await shelvesOf('tickets.example')).toEqual(['knowledge-docs (primary)'])
    const [row] = await db.execute<{ status: string; title: string }>(sql`
      select status, title from provider_recipes where provider = 'tickets.example'
    `)
    expect(row).toEqual({ status: 'measured', title: 'tickets.example' })
  })

  /** Decision 10: the shelf an entry is filed under is a maintainer's edit, not a suggestion's. */
  it('refuses a proposal naming the shelf the entry is already filed under', async () => {
    const walkId = await walk({ kind: 'ticketing', provider: 'tickets.example' })
    await entry({ kind: 'ticketing', provider: 'tickets.example', category: 'knowledge-docs' })
    const raised = await raise({
      kind: 'ticketing',
      provider: 'tickets.example',
      draft: draft({ walks: [walkId] }),
    })
    if (raised.outcome !== 'raised') throw new Error(raised.outcome)

    const decided = await decideAtlasCategoryProposal(db, {
      id: raised.proposal.id,
      decision: { decision: 'accept' },
    })

    expect(decided.outcome).toBe('would-move-the-primary')
    expect(await openAtlasCategoryProposals(db)).toHaveLength(1)
  })

  /** Decision 8's other half: the category row, and the entry onto it. */
  it('accepting a new sub category writes the shelf under its parent', async () => {
    const walkId = await walk({ kind: 'ticketing', provider: 'tickets.example' })
    const raised = await raise({
      kind: 'ticketing',
      provider: 'tickets.example',
      draft: draft({
        walks: [walkId],
        shape: 'new-sub',
        parent: 'working-together',
        category: 'ticketing',
        title: 'Ticketing',
        standfirst: 'Where a citizen raises a ticket somebody else works through.',
      }),
    })
    if (raised.outcome !== 'raised') throw new Error(raised.outcome)

    expect(
      (
        await decideAtlasCategoryProposal(db, {
          id: raised.proposal.id,
          decision: { decision: 'accept' },
        })
      ).outcome,
    ).toBe('decided')

    const [shelf] = await db.execute<{ parent_slug: string; title: string }>(sql`
      select parent_slug, title from atlas_categories where slug = 'ticketing'
    `)
    expect(shelf).toEqual({ parent_slug: 'working-together', title: 'Ticketing' })
    expect(await shelvesOf('tickets.example')).toEqual(['ticketing (primary)'])
  })

  /** The composite key in `0280`, reached through this path rather than by hand. */
  it('refuses a new sub category hanging from another sub category', async () => {
    const walkId = await walk({ kind: 'ticketing', provider: 'tickets.example' })
    const raised = await raise({
      kind: 'ticketing',
      provider: 'tickets.example',
      draft: draft({
        walks: [walkId],
        shape: 'new-sub',
        parent: 'mailbox',
        category: 'ticketing',
        title: 'Ticketing',
        standfirst: 'Where a citizen raises a ticket somebody else works through.',
      }),
    })
    if (raised.outcome !== 'raised') throw new Error(raised.outcome)

    await expect(
      decideAtlasCategoryProposal(db, {
        id: raised.proposal.id,
        decision: { decision: 'accept' },
      }),
    ).rejects.toThrow()
  })

  /** Decision 7: the decline is what stops the question being asked again. */
  it('declining records the reason and refuses the same pairing again', async () => {
    const walkId = await walk({ kind: 'ticketing', provider: 'tickets.example' })
    const raised = await raise({
      kind: 'ticketing',
      provider: 'tickets.example',
      draft: draft({ walks: [walkId] }),
    })
    if (raised.outcome !== 'raised') throw new Error(raised.outcome)

    const decided = await decideAtlasCategoryProposal(db, {
      id: raised.proposal.id,
      decision: { decision: 'decline', reason: 'It keeps tickets, not notes.' },
    })

    expect(decided.outcome).toBe('decided')
    if (decided.outcome !== 'decided') throw new Error(decided.outcome)
    expect(decided.proposal.status).toBe('declined')
    expect(decided.proposal.decidedReason).toBe('It keeps tickets, not notes.')

    const again = await raise({
      kind: 'ticketing',
      provider: 'tickets.example',
      draft: draft({ walks: [walkId] }),
    })

    expect(again.outcome).toBe('already-proposed')
    expect(
      await atlasCategoriesSettled(db, { kind: 'ticketing', provider: 'tickets.example' }),
    ).toEqual(['knowledge-docs'])
  })

  /** Two consoles on one queue: the second decision changes nothing. */
  it('refuses to decide a proposal that is no longer open', async () => {
    const walkId = await walk({ kind: 'ticketing', provider: 'tickets.example' })
    const raised = await raise({
      kind: 'ticketing',
      provider: 'tickets.example',
      draft: draft({ walks: [walkId] }),
    })
    if (raised.outcome !== 'raised') throw new Error(raised.outcome)

    await decideAtlasCategoryProposal(db, {
      id: raised.proposal.id,
      decision: { decision: 'decline', reason: 'It keeps tickets, not notes.' },
    })

    expect(
      (
        await decideAtlasCategoryProposal(db, {
          id: raised.proposal.id,
          decision: { decision: 'accept' },
        })
      ).outcome,
    ).toBe('not-open')
  })

  it('reads back the shelves an entry already sits on', async () => {
    await entry({ kind: 'ticketing', provider: 'tickets.example', category: 'data-apis' })

    expect(
      await atlasCategoriesHeld(db, { kind: 'ticketing', provider: 'tickets.example' }),
    ).toEqual(['data-apis'])
  })
})
