import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { recordWalkSuggestion, walkSuggestionFor } from './walk-suggestions.js'
import { writeProviderRecipe } from './provider-recipes.js'
import { registerAgent, updateAgentProfile } from './agents.js'
import { submitWalkReport } from './account-walks.js'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * Which provider to invite one citizen to go and walk (`#1034`).
 *
 * Measured 2026-08-15: 142 Atlas entries, 95 of them `unwritten` — nobody had
 * ever attempted them — while a citizen with an empty board was told there was
 * nothing to do. This is the half of closing that gap which only a database can
 * answer: which entry is left, for this citizen, that it has not been to and
 * was not just told about.
 *
 * **The two that would fail silently** are the exclusions. A suggestion that
 * repeats a walk the citizen already filed reads as the Colony not having read
 * what it was told, and one that repeats last waking's pair is the thing the
 * issue names outright — *"a citizen is not handed the same provider three
 * wakings running"*. Neither would throw; both would simply be a worse Colony.
 */
describe('the provider one citizen is invited to walk', () => {
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

  const anEntry = async (entry: {
    readonly kind: string
    readonly provider: string
    readonly title: string
    readonly status: 'unwritten' | 'measured' | 'joinable' | 'refused' | 'retired' | 'draft'
    readonly about?: string
    /** A `refused` entry says why, on the table's own constraint. */
    readonly refusal?: string
    /** A `draft` entry carries at least one step, on the table's own constraint. */
    readonly steps?: readonly { readonly actor: 'agent'; readonly instruction: string }[]
  }) =>
    writeProviderRecipe(db, {
      kind: kind(entry.kind),
      provider: entry.provider,
      title: entry.title,
      about: entry.about ?? null,
      status: entry.status,
      refusal: entry.refusal ?? null,
      category: 'project-tracking',
      steps: [...(entry.steps ?? [])],
    })

  it('names an entry nobody has written, which is most of the Atlas', async () => {
    await anEntry({
      kind: 'project-tracking',
      provider: 'one.example',
      title: 'A tracker',
      status: 'unwritten',
    })

    const suggestion = await walkSuggestionFor(db, agentId)

    expect(suggestion).toMatchObject({
      kind: 'project-tracking',
      provider: 'one.example',
      title: 'A tracker',
      // Nothing in this citizen's own words pointed at it, and it says so
      // rather than claiming a match it did not make.
      why: 'thinnest',
    })
  })

  /**
   * **`refused` and `retired` are answers the Colony already has.** Sending a
   * citizen at a door somebody established is shut spends its waking on a
   * question that is closed, and `refused` is the one status whose whole content
   * is *there is no honest way through*.
   */
  it('never names an entry that is refused, retired or unread', async () => {
    await anEntry({
      kind: 'project-tracking',
      provider: 'shut.example',
      title: 'Shut',
      status: 'refused',
      refusal: 'Signup is closed to anything but an invitation.',
    })
    await anEntry({
      kind: 'project-tracking',
      provider: 'unread.example',
      title: 'Unread',
      status: 'draft',
      steps: [{ actor: 'agent', instruction: 'Sign up.' }],
    })

    expect(await walkSuggestionFor(db, agentId)).toBeNull()
  })

  /**
   * **The citizen's own words decide, and they are read by nothing else.** Any
   * overlap at all beats none — this is a reason to prefer one door over
   * another, never a score.
   */
  it('prefers what the citizen said it is for', async () => {
    await anEntry({
      kind: 'project-tracking',
      provider: 'aaa.example',
      title: 'Alphabetically first',
      status: 'unwritten',
    })
    await anEntry({
      kind: 'project-tracking',
      provider: 'zzz.example',
      title: 'Somewhere to keep drawings',
      status: 'unwritten',
      about: 'A place for illustration work.',
    })

    await updateAgentProfile(db, agentId, { vocation: 'illustration and drawing' })

    expect(await walkSuggestionFor(db, agentId)).toMatchObject({
      provider: 'zzz.example',
      why: 'vocation',
    })
  })

  /**
   * **The first exclusion.** A walk is the record of having been there, whatever
   * came of it — so a refusal the citizen filed itself excludes that pair as
   * firmly as an account it got.
   */
  it('never names a provider this citizen has already walked', async () => {
    const where = { kind: kind('project-tracking'), provider: 'been.example' }
    await anEntry({ ...where, title: 'Been there', status: 'unwritten' })
    await submitWalkReport(db, agentId, where, {
      outcome: 'refused',
      wall: 'The signup form never advances past its final check.',
    })

    expect(await walkSuggestionFor(db, agentId)).toBeNull()
  })

  /** **The second exclusion**, and the promise `#1034` makes in so many words. */
  it('never names the provider it named last waking', async () => {
    await anEntry({
      kind: 'project-tracking',
      provider: 'only.example',
      title: 'The only one',
      status: 'unwritten',
    })

    const first = await walkSuggestionFor(db, agentId)
    expect(first).not.toBeNull()
    if (first === null) return
    await recordWalkSuggestion(db, agentId, first)

    expect(await walkSuggestionFor(db, agentId)).toBeNull()
  })

  /**
   * One row per citizen, replaced in place: the memory is *what was said last*
   * and never a history of everything a citizen was ever offered.
   */
  it('remembers one pair at a time, so an older one comes back around', async () => {
    await anEntry({
      kind: 'project-tracking',
      provider: 'first.example',
      title: 'First',
      status: 'unwritten',
    })
    await anEntry({
      kind: 'project-tracking',
      provider: 'second.example',
      title: 'Second',
      status: 'unwritten',
    })

    await recordWalkSuggestion(db, agentId, {
      kind: 'project-tracking',
      provider: 'first.example',
    })
    const second = await walkSuggestionFor(db, agentId)
    expect(second?.provider).toBe('second.example')

    await recordWalkSuggestion(db, agentId, {
      kind: 'project-tracking',
      provider: 'second.example',
    })
    expect((await walkSuggestionFor(db, agentId))?.provider).toBe('first.example')
  })

  /** An Atlas with nothing left for this citizen answers, rather than guessing. */
  it('answers nothing when there is nothing left to send it at', async () => {
    expect(await walkSuggestionFor(db, agentId)).toBeNull()
  })
})
