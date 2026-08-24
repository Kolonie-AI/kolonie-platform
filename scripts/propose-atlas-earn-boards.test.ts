import { describe, expect, it } from 'vitest'
import { facetsFrom, type AtlasDocument } from '@kolonie-ai/core'
// @ts-expect-error — an operational script, deliberately outside the TypeScript project.
import {
  EARN_BOARDS_CATEGORY,
  earnBoardCandidates,
  earnBoardProposalDraft,
  prepareEarnBoardProposal,
  selectEarnBoardEvidence,
} from './propose-atlas-earn-boards.mjs'

const entry = (input: {
  provider: string
  kind: string
  category?: string
  earn?: Parameters<typeof facetsFrom>[1]
  source?: 'curated' | 'measured' | 'walk-published'
}) => {
  const category = input.category ?? 'data-apis'
  const facets = facetsFrom([category], input.earn ?? [])
  return {
    provider: input.provider,
    category,
    facets,
    source: input.source ?? 'measured',
    recipes: [{ kind: input.kind, facets }],
  } as unknown as AtlasDocument['entries'][number]
}

describe('the earn-board proposal corpus', () => {
  it('puts an earn entry known only from a walk into the proposal', async () => {
    const walked = entry({
      provider: 'walked-board.example',
      kind: 'bounty-board',
      earn: ['bounty-board'],
      source: 'measured',
    })
    const walkId = '00000000-0000-4000-8000-000000000001'

    await expect(
      prepareEarnBoardProposal({ entries: [walked] }, async () => [walkId]),
    ).resolves.toEqual({
      kind: 'bounty-board',
      provider: 'walked-board.example',
      draft: earnBoardProposalDraft({ walks: [walkId], memberCount: 1 }),
    })
  })

  it('derives membership only from structured earn facets', () => {
    const proseOnly = {
      ...entry({ provider: 'api.example', kind: 'api' }),
      description: 'A board that pays bounties for finished work.',
    }
    const wrongShelf = entry({
      provider: 'elsewhere.example',
      kind: 'bounty-board',
      category: 'commerce-marketplace',
      earn: ['bounty-board'],
    })

    expect(earnBoardCandidates({ entries: [proseOnly, wrongShelf] })).toEqual([])
  })

  it('selects the first candidate with published walk evidence deterministically', async () => {
    const candidates = earnBoardCandidates({
      entries: [
        entry({ provider: 'z.example', kind: 'bounty-board', earn: ['bounty-board'] }),
        entry({ provider: 'a.example', kind: 'gig-marketplace', earn: ['gig-marketplace'] }),
      ],
    })

    const selected = await selectEarnBoardEvidence(candidates, async ({ provider }) =>
      provider === 'a.example' ? ['00000000-0000-4000-8000-000000000001'] : [],
    )

    expect(selected).toEqual({
      candidate: { kind: 'gig-marketplace', provider: 'a.example', source: 'measured' },
      walks: ['00000000-0000-4000-8000-000000000001'],
    })
  })

  it('refuses to produce a proposal without a published walk', async () => {
    const candidates = earnBoardCandidates({
      entries: [entry({ provider: 'board.example', kind: 'bounty-board', earn: ['bounty-board'] })],
    })

    await expect(selectEarnBoardEvidence(candidates, async () => [])).resolves.toBeNull()
  })

  it('builds one new sub-shelf under Building and running', () => {
    expect(
      earnBoardProposalDraft({
        walks: ['00000000-0000-4000-8000-000000000001'],
        memberCount: 42,
      }),
    ).toEqual({
      shape: 'new-sub',
      parent: 'building-running',
      category: EARN_BOARDS_CATEGORY,
      title: 'Earn boards',
      standfirst: 'Boards and marketplaces where a citizen can earn by completing offered work.',
      why: '42 entries on the data-apis fallback carry a structured earn facet; this shelf groups those earn boards without deriving membership from prose.',
      walks: ['00000000-0000-4000-8000-000000000001'],
    })
  })
})
