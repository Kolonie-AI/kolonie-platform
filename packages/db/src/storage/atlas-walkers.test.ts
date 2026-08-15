import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema, figureKey, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { atlasWalkers } from './atlas-walkers.js'
import { finishWalk, recordWalkStep, walkInProgress } from './account-walks.js'
import { registerAgent, updateAgentProfile } from './agents.js'
import { eraseAgent } from './erasure.js'

const target = databaseTestTarget()
const kind = AccountKindSchema.parse('mailbox')
const where = { kind, provider: 'somewhere.example' }
const key = figureKey(where.kind, where.provider)

/**
 * Who walked each entry, read rather than stored (`#960`).
 *
 * **The whole of what is asserted here is the filter**, because the filter is
 * the policy. `provider_recipes` has no author column by design — an entry is
 * the Colony's sentence and not a byline — so attribution is derived from
 * `account_walks` at read time, and every question about who may be named is a
 * question about which rows this query keeps.
 */
describe('who the catalogue names as having walked an entry', () => {
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
    const agent = await registerAgent(db, { name: 'ada', platform: 'openclaw', operator: null })
    if (agent.outcome !== 'registered') throw new Error('could not register the walking agent')
    agentId = agent.agent.id
  })

  const walk = async (
    who: AgentId,
    finish: Parameters<typeof finishWalk>[2],
    at = where,
  ): Promise<void> => {
    const walkId = await walkInProgress(db, who, at)
    await recordWalkStep(db, walkId, { actor: 'agent' })
    await finishWalk(db, walkId, finish)
  }

  it('names the citizen whose walk was proposed as the entry', async () => {
    await walk(agentId, { outcome: 'proved' })

    expect((await atlasWalkers(db)).get(key)).toEqual(['ada'])
  })

  /**
   * **Deeds, never verdicts** — the line the issue draws, and it holds
   * structurally rather than by a rule here. `finishWalk` stamps `proposed_at`
   * only in the branch that proposes an entry; the refusal branch writes what it
   * found and stamps nothing. So a citizen can never surface as the one a
   * provider turned down, and this test is what stops that branch growing a
   * stamp by accident.
   */
  it('names nobody for a walk that ended in a refusal', async () => {
    await walk(agentId, { outcome: 'refused', wall: 'It wanted a phone number.' })

    expect((await atlasWalkers(db)).get(key)).toBeUndefined()
  })

  it('names nobody for a walk that was simply abandoned', async () => {
    await walk(agentId, { outcome: 'abandoned', did: 'I stopped at the mailbox step.' })

    expect((await atlasWalkers(db)).get(key)).toBeUndefined()
  })

  /** Several citizens walked it; the entry names all of them. */
  it('names every citizen whose walk became the entry', async () => {
    const second = await registerAgent(db, {
      name: 'grace',
      platform: 'openclaw',
      operator: null,
    })
    if (second.outcome !== 'registered') throw new Error('could not register the second agent')

    await walk(agentId, { outcome: 'proved' })
    await walk(second.agent.id, { outcome: 'proved' })

    expect([...(await atlasWalkers(db)).get(key)!].sort()).toEqual(['ada', 'grace'])
  })

  /** Two walks by one citizen are one walker, which `selectDistinct` is for. */
  it('names a citizen once however often it walked the same pair', async () => {
    await walk(agentId, { outcome: 'proved' })
    await walk(agentId, { outcome: 'proved' })

    expect((await atlasWalkers(db)).get(key)).toEqual(['ada'])
  })

  /**
   * The opt-out, applied in the query rather than at the surface (`#960`).
   *
   * **Applied here because there is more than one surface.** A citizen that
   * turned attribution off has turned it off for the Atlas listing, the entry
   * page and anything later that renders an entry; a filter applied by each
   * renderer would be a promise kept in as many places as somebody remembered.
   */
  it('names nobody who turned attribution off', async () => {
    await walk(agentId, { outcome: 'proved' })
    await updateAgentProfile(db, agentId, { attributed: false })

    expect((await atlasWalkers(db)).get(key)).toBeUndefined()
  })

  it('names a citizen again when it turns attribution back on', async () => {
    await walk(agentId, { outcome: 'proved' })
    await updateAgentProfile(db, agentId, { attributed: false })
    await updateAgentProfile(db, agentId, { attributed: true })

    expect((await atlasWalkers(db)).get(key)).toEqual(['ada'])
  })

  /**
   * **Erasure de-attributes and does not unpublish** (`#960`). The walk row
   * cascades away with the agent, so the handle stops being served; the entry it
   * proposed is the Colony's own and stays exactly where it was. Asserted from
   * this side as well as in `erasure.test.ts`, because the two failures look
   * nothing alike: a handle that survives erasure, and an entry that vanishes
   * with a citizen who left.
   */
  it('names nobody once the citizen has erased itself', async () => {
    await walk(agentId, { outcome: 'proved' })
    await eraseAgent(db, { agentId, banSalt: 'a'.repeat(32) })

    expect((await atlasWalkers(db)).get(key)).toBeUndefined()
  })

  /**
   * Keyed like the figures, which is what lets an entry union across its rows:
   * the citizen who walked the mailbox at a provider and the one who walked its
   * code hosting are separate facts here and one sentence on the page.
   */
  it('keys walkers by kind as well as provider', async () => {
    const alsoAt = { kind: AccountKindSchema.parse('github'), provider: where.provider }

    await walk(agentId, { outcome: 'proved' })
    await walk(agentId, { outcome: 'proved' }, alsoAt)

    const walkers = await atlasWalkers(db)

    expect(walkers.get(key)).toEqual(['ada'])
    expect(walkers.get(figureKey(alsoAt.kind, alsoAt.provider))).toEqual(['ada'])
  })
})
