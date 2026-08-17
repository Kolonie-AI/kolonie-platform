import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { ATLAS_SEEDED_CATEGORIES, type AtlasCategoryProposalDraft } from '@kolonie-ai/core'
import type { ProviderBriefingSource } from '@kolonie-ai/db'
import {
  atlasCategoryProposalTick,
  proposeCategory,
  type AtlasCategoryPair,
  type AtlasCategoryProposalStore,
} from './atlas-category-proposals.js'
import { fakeModel, type FakeModel } from './__fixtures__/model.js'

let model: FakeModel

beforeEach(() => {
  model = fakeModel()
})

/**
 * One walk as the pass receives it.
 *
 * Every value invented, on `provider-synthesis.test.ts`' terms: nothing here
 * resolves and nothing identifies anybody.
 */
const aWalk = (overrides: Partial<ProviderBriefingSource> = {}): ProviderBriefingSource => ({
  id: randomUUID(),
  outcome: 'proved',
  content: 'Signed up and used the board to file the issues the team works through.',
  platform: 'openclaw',
  finishedAt: new Date().toISOString(),
  ...overrides,
})

const pair: AtlasCategoryPair = { kind: 'ticketing', provider: 'tickets.example' }

/** The store, answering what a test told it to and recording what it was asked to write. */
interface Store extends AtlasCategoryProposalStore {
  readonly raised: () => readonly AtlasCategoryProposalDraft[]
}

const fakeStore = (overrides: Partial<AtlasCategoryProposalStore> = {}): Store => {
  const raised: AtlasCategoryProposalDraft[] = []

  return {
    queue: async () => [pair],
    categories: async () => ATLAS_SEEDED_CATEGORIES,
    corpus: async () => [],
    settled: async () => [],
    held: async () => [],
    raise: async (input) => {
      raised.push(input.draft)
      return { outcome: 'raised' }
    },
    ...overrides,
    raised: () => [...raised],
  }
}

describe('proposing which shelf a provider belongs on', () => {
  it('asks nothing of the model when nobody has walked the provider', async () => {
    const store = fakeStore()

    const outcome = await proposeCategory(pair, { store, model })

    expect(outcome.draft).toBeNull()
    expect(model.calls()).toHaveLength(0)
  })

  /** Decision 7, held before the call rather than after it. */
  it('asks nothing when every shelf has already been settled or is already held', async () => {
    const store = fakeStore({
      corpus: async () => [aWalk()],
      categories: async () => [
        {
          slug: 'project-tracking',
          title: 'Project tracking',
          standfirst: 'Issues.',
          parent: 'working-together',
        },
      ],
      settled: async () => ['project-tracking'],
    })

    const outcome = await proposeCategory(pair, { store, model })

    expect(outcome.draft).toBeNull()
    expect(model.calls()).toHaveLength(0)
  })

  /**
   * The rule the issue names outright: a claim citing no walk is dropped, and it
   * is dropped even though the transport was asked to close the citation set.
   */
  it('drops a proposal citing no walk in the corpus', async () => {
    const store = fakeStore({ corpus: async () => [aWalk()] })
    model.composes({
      section: 'add:project-tracking',
      text: 'It is where a team keeps its issues.',
      sources: [randomUUID()],
    })

    const outcome = await proposeCategory(pair, { store, model })

    expect(outcome).toMatchObject({ draft: null, proposed: 1, unsourced: 1 })
    expect(store.raised()).toEqual([])
  })

  it('drops a proposal whose reason is empty', async () => {
    const walk = aWalk()
    const store = fakeStore({ corpus: async () => [walk] })
    model.composes({ section: 'add:project-tracking', text: '   ', sources: [walk.id] })

    const outcome = await proposeCategory(pair, { store, model })

    expect(outcome).toMatchObject({ draft: null, proposed: 1, blank: 1 })
  })

  it('drops a proposal naming a section the vocabulary has no target for', async () => {
    const walk = aWalk()
    const store = fakeStore({ corpus: async () => [walk] })
    model.composes({ section: 'project-tracking', text: 'It keeps issues.', sources: [walk.id] })

    const outcome = await proposeCategory(pair, { store, model })

    expect(outcome).toMatchObject({ draft: null, proposed: 1, unnamed: 1 })
  })

  it('proposes an existing shelf, citing the walks it read', async () => {
    const walk = aWalk()
    const store = fakeStore({ corpus: async () => [walk] })
    model.composes({
      section: 'add:project-tracking',
      text: 'Walkers describe filing and working through issues there.',
      sources: [walk.id, walk.id],
    })

    const outcome = await proposeCategory(pair, { store, model })

    expect(outcome.draft).toEqual({
      shape: 'existing',
      category: 'project-tracking',
      why: 'Walkers describe filing and working through issues there.',
      walks: [walk.id],
    })
  })

  /**
   * The shelves are offered with their standfirsts, and the settled ones are not
   * offered at all — both are what the section list is for.
   */
  it('offers the shelves that are left, and never a top category to add to', async () => {
    const store = fakeStore({ corpus: async () => [aWalk()], settled: async () => ['storage'] })
    model.composes()

    await proposeCategory(pair, { store, model })

    const sections = model.lastCall()?.sections ?? []
    expect(sections).toContain('add:project-tracking')
    expect(sections).not.toContain('add:storage')
    expect(sections).not.toContain('add:working-together')
    expect(sections).toContain('new-under:working-together')
    expect(model.lastCall()?.user).toContain('Issues, boards and the record of who is doing what.')
  })

  it('asks for a title and a standfirst when the shelf does not exist yet', async () => {
    const walk = aWalk()
    const store = fakeStore({ corpus: async () => [walk] })
    model.composesInTurn(
      [
        {
          section: 'new-under:working-together',
          text: 'Nothing here is a tracker.',
          sources: [walk.id],
        },
      ],
      [
        { section: 'title', text: 'Ticketing', sources: [walk.id] },
        {
          section: 'standfirst',
          text: 'Where a citizen raises a ticket somebody else works through.',
          sources: [walk.id],
        },
      ],
    )

    const outcome = await proposeCategory(pair, { store, model })

    expect(outcome.draft).toEqual({
      shape: 'new-sub',
      parent: 'working-together',
      category: 'ticketing',
      title: 'Ticketing',
      standfirst: 'Where a citizen raises a ticket somebody else works through.',
      why: 'Nothing here is a tracker.',
      walks: [walk.id],
    })
  })

  /** A title that yields no address is a proposal dropped, not one repaired. */
  it('drops a new shelf whose title yields no slug', async () => {
    const walk = aWalk()
    const store = fakeStore({ corpus: async () => [walk] })
    model.composesInTurn(
      [
        {
          section: 'new-under:working-together',
          text: 'Nothing here is a tracker.',
          sources: [walk.id],
        },
      ],
      [
        { section: 'title', text: '???', sources: [walk.id] },
        { section: 'standfirst', text: 'Where a citizen raises a ticket.', sources: [walk.id] },
      ],
    )

    const outcome = await proposeCategory(pair, { store, model })

    expect(outcome).toMatchObject({ draft: null, unnamed: 1 })
  })

  it('drops a new shelf that arrived without a standfirst', async () => {
    const walk = aWalk()
    const store = fakeStore({ corpus: async () => [walk] })
    model.composesInTurn(
      [
        {
          section: 'new-under:working-together',
          text: 'Nothing here is a tracker.',
          sources: [walk.id],
        },
      ],
      [{ section: 'title', text: 'Ticketing', sources: [walk.id] }],
    )

    const outcome = await proposeCategory(pair, { store, model })

    expect(outcome).toMatchObject({ draft: null, unnamed: 1 })
  })

  /**
   * One answer, and the rest are counted rather than raised: three shelves is one
   * finding hedged twice, and a maintainer asked to decide all three has been
   * handed the model's uncertainty instead of its answer.
   */
  it('raises at most one proposal however many the model wrote', async () => {
    const walk = aWalk()
    const store = fakeStore({ corpus: async () => [walk] })
    model.composes(
      { section: 'add:project-tracking', text: 'It keeps issues.', sources: [walk.id] },
      { section: 'add:communication', text: 'It also has rooms.', sources: [walk.id] },
    )

    const outcome = await proposeCategory(pair, { store, model })

    expect(outcome.proposed).toBe(2)
    expect(outcome.draft).toMatchObject({ category: 'project-tracking' })
  })
})

describe('one pass over the queue', () => {
  it('records the model that wrote the proposal', async () => {
    const walk = aWalk()
    const store = fakeStore({ corpus: async () => [walk] })
    let recorded = ''
    const watching: AtlasCategoryProposalStore = {
      ...store,
      raise: async (input) => {
        recorded = input.model
        return { outcome: 'raised' }
      },
    }
    model.composes({
      section: 'add:project-tracking',
      text: 'It keeps issues.',
      sources: [walk.id],
    })

    const outcome = await atlasCategoryProposalTick({ store: watching, model }, 10)

    expect(outcome).toMatchObject({ considered: 1, raised: 1 })
    expect(recorded).toBe('fake/test-model')
  })

  it('counts a pair that produced nothing as skipped rather than failed', async () => {
    const store = fakeStore({ corpus: async () => [aWalk()] })
    model.composes()

    expect(await atlasCategoryProposalTick({ store, model }, 10)).toMatchObject({
      considered: 1,
      raised: 0,
      skipped: 1,
      failed: 0,
    })
  })

  it('counts a pair another pass had already proposed', async () => {
    const walk = aWalk()
    const store = fakeStore({
      corpus: async () => [walk],
      raise: async () => ({ outcome: 'already-open' }),
    })
    model.composes({
      section: 'add:project-tracking',
      text: 'It keeps issues.',
      sources: [walk.id],
    })

    expect(await atlasCategoryProposalTick({ store, model }, 10)).toMatchObject({
      raised: 0,
      duplicate: 1,
    })
  })

  /** An unreachable model costs the pair a tick and leaves it in the queue. */
  it('leaves the pair alone when the model cannot be reached', async () => {
    const store = fakeStore({ corpus: async () => [aWalk()] })
    model.failsNext(new Error('nothing answered'))

    expect(await atlasCategoryProposalTick({ store, model }, 10)).toMatchObject({
      considered: 1,
      failed: 1,
      raised: 0,
    })
    expect(store.raised()).toEqual([])
  })
})
