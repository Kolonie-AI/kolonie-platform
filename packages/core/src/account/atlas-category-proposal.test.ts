import { describe, expect, it } from 'vitest'
import {
  ATLAS_CATEGORY_SECTION_ADD,
  ATLAS_CATEGORY_SECTION_NEW,
  AtlasCategoryProposalDraftSchema,
  AtlasCategoryProposalShapeSchema,
  atlasCategoryProposalSections,
  atlasCategoryProposalTarget,
  atlasCategorySlugFromTitle,
} from './atlas-category-proposal.js'
import type { AtlasCategoryRow } from './atlas-categories.js'

const CATEGORIES: readonly AtlasCategoryRow[] = [
  {
    slug: 'building-running',
    title: 'Building and running',
    standfirst: 'Where it runs.',
    parent: null,
  },
  { slug: 'money-trade', title: 'Money and trade', standfirst: 'Where value moves.', parent: null },
  {
    slug: 'compute-hosting',
    title: 'Compute and hosting',
    standfirst: 'Machines.',
    parent: 'building-running',
  },
  { slug: 'storage', title: 'Storage', standfirst: 'Files.', parent: 'building-running' },
]

/**
 * What a model may say about where a provider belongs (`#1106`).
 *
 * The assertions worth having here are the refusals, because the two decisions
 * this file exists to hold are both negative: a model never creates a top
 * category, and a shelf suggested from nothing is not a suggestion. Both are
 * asserted against the schema rather than against a prompt — a prompt is advice
 * and a schema is the answer being refused.
 */
describe('what a model may propose about a shelf', () => {
  /**
   * **Decision 3, and the rejection case the issue names.** *Rejected by the
   * schema, not merely unhandled by the prompt*: there is no value of this type
   * that asks for a top category, so the refusal survives a prompt somebody
   * rewrites and a model that ignored it.
   */
  it('has no shape that opens a top category', () => {
    expect(
      AtlasCategoryProposalShapeSchema.safeParse({
        shape: 'new-top',
        category: 'bounty-boards',
        title: 'Bounty boards',
        standfirst: 'Where work is posted.',
      }).success,
    ).toBe(false)

    expect(
      AtlasCategoryProposalShapeSchema.safeParse({
        shape: 'new-sub',
        category: 'bounty-boards',
        title: 'Bounty boards',
        standfirst: 'Where work is posted.',
      }).success,
    ).toBe(false)

    expect(
      AtlasCategoryProposalShapeSchema.safeParse({
        shape: 'new-sub',
        parent: 'working-together',
        category: 'bounty-boards',
        title: 'Bounty boards',
        standfirst: 'Where work is posted.',
      }).success,
    ).toBe(true)
  })

  it('refuses a slug that is not one, on either side of the shape', () => {
    expect(
      AtlasCategoryProposalShapeSchema.safeParse({ shape: 'existing', category: 'Data APIs' })
        .success,
    ).toBe(false)
    expect(
      AtlasCategoryProposalShapeSchema.safeParse({ shape: 'existing', category: 'data-apis' })
        .success,
    ).toBe(true)
  })

  /** **Decision 4.** A proposal citing no walk is not a weak proposal, it is not one. */
  it('cannot be built without a walk to cite', () => {
    const draft = { shape: 'existing', category: 'storage', why: 'The walks say it stores files.' }

    expect(AtlasCategoryProposalDraftSchema.safeParse({ ...draft, walks: [] }).success).toBe(false)
    expect(
      AtlasCategoryProposalDraftSchema.safeParse({
        ...draft,
        walks: ['0192e4b4-0000-7000-8000-000000000001'],
      }).success,
    ).toBe(true)
  })
})

describe('the targets a proposal may name', () => {
  /**
   * **The closed set is where decision 3 is enforced a second time**, at the
   * transport rather than in the shape: a section naming a new top category is
   * not a string this function produces, so it is not a section the model is
   * given to choose from.
   */
  it('offers a new shelf only under a top category', () => {
    const sections = atlasCategoryProposalSections({ categories: CATEGORIES })

    expect(sections).toContain(`${ATLAS_CATEGORY_SECTION_NEW}building-running`)
    expect(sections).toContain(`${ATLAS_CATEGORY_SECTION_NEW}money-trade`)
    expect(sections).not.toContain(`${ATLAS_CATEGORY_SECTION_NEW}storage`)
    expect(sections.filter((one) => one.startsWith(ATLAS_CATEGORY_SECTION_NEW))).toHaveLength(2)
  })

  /**
   * **The other half of decision 3, and the half that is easy to miss.** A top
   * category is a heading over shelves rather than a shelf, so an entry is never
   * filed on one — and the place to hold that is the section list, where the
   * string simply does not exist, rather than a check on the way to the table.
   */
  it('offers a sub-shelf to add to, and never a top category', () => {
    const sections = atlasCategoryProposalSections({ categories: CATEGORIES })

    for (const one of CATEGORIES) {
      const section = `${ATLAS_CATEGORY_SECTION_ADD}${one.slug}`
      if (one.parent === null) expect(sections).not.toContain(section)
      else expect(sections).toContain(section)
    }
  })

  /**
   * **Decisions 7 and 10, in the one place both are cheap.** A pairing a
   * maintainer has already settled is not put a second time, and the shelf the
   * provider is already on — its primary among them — is not something a proposal
   * can reach at all.
   */
  it('leaves out what was settled before and what the provider already sits on', () => {
    const sections = atlasCategoryProposalSections({
      categories: CATEGORIES,
      settled: ['storage'],
      held: ['compute-hosting'],
    })

    expect(sections).not.toContain(`${ATLAS_CATEGORY_SECTION_ADD}storage`)
    expect(sections).not.toContain(`${ATLAS_CATEGORY_SECTION_ADD}compute-hosting`)
    expect(sections).toContain(`${ATLAS_CATEGORY_SECTION_NEW}money-trade`)
  })

  it('reads back exactly what it wrote, and nothing it did not', () => {
    expect(atlasCategoryProposalTarget(`${ATLAS_CATEGORY_SECTION_ADD}storage`)).toEqual({
      add: 'storage',
    })
    expect(atlasCategoryProposalTarget(`${ATLAS_CATEGORY_SECTION_NEW}money-trade`)).toEqual({
      under: 'money-trade',
    })
    expect(atlasCategoryProposalTarget('storage')).toBeNull()
    expect(atlasCategoryProposalTarget(`${ATLAS_CATEGORY_SECTION_ADD}Not A Slug`)).toBeNull()
  })
})

describe('the address a proposed shelf would live at', () => {
  it('derives a slug from the title a reader sees', () => {
    expect(atlasCategorySlugFromTitle('Bounty boards')).toBe('bounty-boards')
    expect(atlasCategorySlugFromTitle('  Design & media  ')).toBe('design-media')
    expect(atlasCategorySlugFromTitle('Übersetzung')).toBe('ubersetzung')
  })

  /** A title that yields no address is a proposal dropped rather than repaired. */
  it('answers null rather than inventing one', () => {
    expect(atlasCategorySlugFromTitle('—')).toBeNull()
    expect(atlasCategorySlugFromTitle('   ')).toBeNull()
  })
})
