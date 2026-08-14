import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AgentIdSchema, wakeupIsQuiet } from '@kolonie-ai/core'
import { fakeWakeup, type FakeWakeup } from './__fixtures__/wakeup.js'
import { wakeupAsText } from './mcp/text/wakeup.js'
import { wakeup } from './wakeup.js'
import type { ContributionDependencies } from './contributions.js'

const agentId = AgentIdSchema.parse(randomUUID())

const noContributions: ContributionDependencies = {
  grants: { accountOf: async () => undefined },
  reader: undefined,
}

let source: FakeWakeup

beforeEach(() => {
  source = fakeWakeup()
})

const waking = async () =>
  (await wakeup(agentId, {}, source, noContributions, undefined, undefined)).response

/**
 * Asking for the walk while the agent can still answer it (`#907`).
 *
 * The catalogue depends on `kolonie.accounts.walk-report`, and measured
 * 2026-08-13 that channel had produced **nothing** for the telephony shelf while
 * 17 providers had been proved through other calls. The reason is structural: an
 * agent holds everything the walk asks for in the minute after it joins, and
 * none of it one session later.
 *
 * The proof's own response asks first. This is the second and last time.
 */
describe('the invitation to write up a provider just joined', () => {
  it('offers the walk for a provider proved in this run', async () => {
    source.answersWalksToAskAbout([{ kind: 'phone', provider: 'agentmessage.example' }])

    const response = await waking()

    expect(response.walkInvitations).toHaveLength(1)
    expect(response.walkInvitations[0]).toMatchObject({
      call: 'kolonie.accounts.walk-report',
      kind: 'phone',
      provider: 'agentmessage.example',
      outcome: 'proved',
    })
  })

  /**
   * **Prefilled with the three facts the Colony holds.** A form that asks an
   * agent to restate what the Colony already knows reads as bureaucracy, and the
   * four questions it exists for get shorter answers for it.
   */
  it('carries the four questions and asks for nothing the Colony already has', async () => {
    source.answersWalksToAskAbout([{ kind: 'phone', provider: 'agentmessage.example' }])

    const [invitation] = (await waking()).walkInvitations

    expect(invitation?.questions.map((one) => one.field)).toEqual([
      'did',
      'broke',
      'changed',
      'discarded',
    ])
    for (const question of invitation?.questions ?? []) {
      expect(question.question.length).toBeGreaterThan(10)
    }
  })

  /** An offer and never a gate, said in the same breath as the ask. */
  it('says that not answering costs nothing', async () => {
    source.answersWalksToAskAbout([{ kind: 'phone', provider: 'agentmessage.example' }])

    const [invitation] = (await waking()).walkInvitations

    expect(invitation?.costsNothing).toContain('costs you nothing')
    expect(invitation?.costsNothing).toContain('recorded nowhere')
  })

  /**
   * **The rejection case `#907` asks for.** Nothing is offered where the citizen
   * has written its walk up, or where it has joined nothing this run — the
   * ordinary state, and the one every other waking is in.
   */
  it('offers nothing when there is nothing waiting', async () => {
    expect((await waking()).walkInvitations).toEqual([])
  })

  /**
   * **The window is the session, and that is the whole of `#907`'s last
   * criterion.** `walksToAskAbout` is bounded by `currentSessionStartSql` rather
   * than by the digest's own `since`, so a proof from a previous run is not in
   * the answer — an ask that outlived the context it was about would produce
   * exactly the invented recipe the walk channel exists to avoid.
   *
   * Asserted here as the contract the source is held to: this file owns the
   * rendering, and `packages/db` owns the boundary.
   */
  it('does not reach into the digest window for its own answer', async () => {
    source.answersPreviousSession('2026-08-01T09:00:00.000Z')
    source.answersWalksToAskAbout([])

    const response = await waking()

    expect(response.since).toBe('2026-08-01T09:00:00.000Z')
    expect(response.walkInvitations).toEqual([])
  })

  /**
   * **It never throws.** A wake-up that failed because the walk store was
   * unhappy would be a worse answer than one without the invitation — the
   * judgement every optional section on this port makes.
   */
  it('answers the rest of the digest when the walk store fails', async () => {
    source.walkStoreIsUnhappy()

    const response = await waking()

    expect(response.walkInvitations).toEqual([])
    expect(response.since).toBeDefined()
  })

  /**
   * **Not counted as news.** A citizen with nothing else waiting has had a
   * productive session rather than a loud one, and letting an invitation flip
   * `wakeupIsQuiet` would make the repetition counter read a proof the citizen
   * already knows about as something that changed.
   */
  it('does not make an otherwise quiet waking loud', async () => {
    source.answersWalksToAskAbout([{ kind: 'phone', provider: 'agentmessage.example' }])

    expect(wakeupIsQuiet(await waking())).toBe(true)
  })

  /** It reaches the reader who answers in prose, not only the structured half. */
  it('is rendered, with the provider and the call in it', async () => {
    source.answersWalksToAskAbout([{ kind: 'phone', provider: 'agentmessage.example' }])

    const text = wakeupAsText(await waking())

    expect(text).toContain('agentmessage.example')
    expect(text).toContain('kolonie.accounts.walk-report')
    expect(text).toContain('costs you nothing')
  })

  /**
   * **The rendering survives a quiet waking, and that is why it is its own
   * block.** `happenedBlocks` is replaced wholesale when nothing changed, and a
   * citizen that proved an account and had nothing else happen is exactly in
   * that state — so an invitation rendered inside it would be invisible in the
   * common case while still being present in `structuredContent`.
   */
  it('is rendered even on a waking the Colony had no news for', async () => {
    source.answersWalksToAskAbout([{ kind: 'phone', provider: 'agentmessage.example' }])

    const response = await waking()
    expect(wakeupIsQuiet(response)).toBe(true)
    expect(wakeupAsText(response)).toContain('agentmessage.example')
  })
})
