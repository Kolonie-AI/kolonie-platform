import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema, noAtlasStagesRun } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  atlasEntryFor,
  atlasModerationsFor,
  atlasProposalDigest,
  recordAtlasModeration,
  unjudgedAtlasProposals,
} from './atlas-moderations.js'
import { proposeProvider } from './atlas-proposals.js'
import { providerRecipe, writeProviderRecipe } from './provider-recipes.js'

const target = databaseTestTarget()

/** `code-hosting` is a shelf; `code-host` is the account kind behind it. */
const CODE_HOST = AccountKindSchema.parse('code-host')

/**
 * The Colony judging its own Atlas proposals (`#812`).
 *
 * What is asserted here is that the verdict and the decision are one
 * transaction, and that the record survives the decision it caused — which is
 * the whole difference between this and a steward pressing a button.
 */
describe('a verdict about a proposed provider', () => {
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

  const proposed = async (provider: string, why?: string): Promise<string> => {
    const raised = await proposeProvider(db, {
      provider,
      source: 'citizen',
      ...(why === undefined ? {} : { why }),
    })
    if (raised.outcome !== 'raised') throw new Error('expected it to be raised')

    return raised.proposal.id
  }

  it('lists an accepted provider and leaves the verdict behind it', async () => {
    const id = await proposed('clawhub.com', 'nowhere to publish a package')

    const written = await recordAtlasModeration(db, {
      proposalId: id,
      decision: 'accepted',
      model: 'a/model',
      stages: noAtlasStagesRun(),
      category: 'code-hosting',
    })

    expect(written.outcome).toBe('written')

    const entry = await providerRecipe(db, CODE_HOST, 'clawhub.com')
    /** A listing and nothing more: no steps, and *nobody has looked* (`#590`). */
    expect(entry?.status).toBe('unwritten')
    expect(entry?.steps).toEqual([])

    const [verdict] = await atlasModerationsFor(db, id)
    expect(verdict?.decision).toBe('accepted')
    expect(verdict?.model).toBe('a/model')
  })

  it('refuses with a sentence the proposer can read, and writes no entry', async () => {
    const id = await proposed('nowhere.example')

    await recordAtlasModeration(db, {
      proposalId: id,
      decision: 'refused',
      model: 'a/model',
      stages: noAtlasStagesRun(),
      reason: 'There is no API an agent can use once it holds this account.',
    })

    const [queue] = await unjudgedAtlasProposals(db, 10)
    expect(queue).toBeUndefined()
    expect(await providerRecipe(db, CODE_HOST, 'nowhere.example')).toBeUndefined()
    expect((await atlasModerationsFor(db, id))[0]?.decision).toBe('refused')
  })

  /**
   * The race that matters: a steward deciding by hand while the pass is
   * thinking. The steward wins because they got there first, and the pass
   * records nothing rather than deciding a second time.
   */
  it('is stale once something else has decided it', async () => {
    const id = await proposed('clawhub.com')

    await recordAtlasModeration(db, {
      proposalId: id,
      decision: 'refused',
      model: 'a/model',
      stages: noAtlasStagesRun(),
      reason: 'no',
    })

    const second = await recordAtlasModeration(db, {
      proposalId: id,
      decision: 'accepted',
      model: 'a/model',
      stages: noAtlasStagesRun(),
      category: 'code-hosting',
    })

    expect(second.outcome).toBe('stale')
    expect(await atlasModerationsFor(db, id)).toHaveLength(1)
  })

  it('finds the entry the catalogue already holds, which is the dedup stage', async () => {
    await writeProviderRecipe(db, {
      kind: CODE_HOST,
      provider: 'clawhub.com',
      title: 'ClawHub',
      category: 'code-hosting',
      status: 'unwritten',
      steps: [],
    })

    expect(await atlasEntryFor(db, 'clawhub.com')).toBe('clawhub.com')
    expect(await atlasEntryFor(db, 'nowhere.example')).toBeUndefined()
  })

  /**
   * The digest is what tells two verdicts about one provider apart — the one
   * that refused a bare proposal, and the one that judged the same provider
   * again with a reason attached.
   */
  it('digests the claim, not just the provider', () => {
    expect(atlasProposalDigest({ provider: 'clawhub.com', why: null })).not.toBe(
      atlasProposalDigest({ provider: 'clawhub.com', why: 'it ships an API now' }),
    )
    expect(atlasProposalDigest({ provider: 'clawhub.com', why: 'a' })).toMatch(/^[0-9a-f]{64}$/)
  })
})
