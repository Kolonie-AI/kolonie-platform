import { describe, expect, it } from 'vitest'
import { ACADEMY_TASKS } from '@kolonie-ai/db'
import type { AgentId } from '@kolonie-ai/core'
import { isWithdrawnRung, withdrawnRung } from './withdrawn-rungs.js'
import { openSmsSendChallenge, type SmsChallengeStore, type SmsDependencies } from './sms.js'
import { argumentLessMint, mintVocabulary } from './mcp/tools/academy/mints.js'

const agent = 'a0000000-0000-4000-8000-0000000000ff' as AgentId

/**
 * What a retirement is worth is measured at the mint (`#954`).
 *
 * `sms-send` is the case, and the reason it is worth a file of its own is that
 * three of the four things a retirement should do already worked before this
 * existed — the rung leaves the list, leaves the graph and refuses a submission.
 * The fourth is the door in front of them, and it was open.
 */
describe('a rung that has been withdrawn', () => {
  it('refuses the rung the seed says is retired, in the seed’s own words', () => {
    const seeded = ACADEMY_TASKS.find((task) => task.type === 'sms-send')
    if (seeded === undefined) throw new Error('sms-send is no longer seeded')

    const refusal = withdrawnRung('sms-send')

    expect(seeded.status).toBe('retired')
    expect(refusal?.code).toBe('not_found')
    // The reason is quoted rather than restated, so there is one copy of it.
    expect(refusal?.message).toBe(seeded.retirementReason)
  })

  /**
   * **The rejection case, and the one that matters most.** A guard that answered
   * for every rung would close the Academy, so it is asserted against the rung
   * next door — the granting half of the same pair, which is not retired and
   * must go on minting.
   */
  it('says nothing about a rung that is still live', () => {
    expect(withdrawnRung('sms-receive')).toBeUndefined()
    expect(isWithdrawnRung('sms-receive')).toBe(false)
  })

  /**
   * A type the seed has never heard of is not a withdrawal either. It reaches
   * this from `outOfReach`'s neighbourhood, where an unknown rung is already
   * allowed through on the argument that the submission is gated anyway.
   */
  it('says nothing about a rung it cannot find', () => {
    expect(withdrawnRung('no-such-rung')).toBeUndefined()
  })
})

/** A store that fails loudly if anything reaches it, since nothing should. */
const untouchedStore = new Proxy({} as SmsChallengeStore, {
  get: (_target, property) => () => {
    throw new Error(`the withdrawn rung reached storage: ${String(property)}`)
  },
})

const smsDeps = (overrides: Partial<SmsDependencies> = {}): SmsDependencies => ({
  challenges: untouchedStore,
  colonyNumber: '+10000000000',
  sender: { send: async () => ({ outcome: 'sent' }) },
  obstruction: async () => true,
  ...overrides,
})

describe('the badge’s mint, after the withdrawal', () => {
  it('refuses instead of minting a nonce nobody could ever spend', async () => {
    const result = await openSmsSendChallenge(agent, smsDeps())

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.code).toBe('not_found')
    expect(result.error.message).toContain('Withdrawn on 2026-08-15')
  })

  /**
   * **The ordering, asserted rather than assumed.** On a deployment with no
   * sender configured the old guard answered `rung_unavailable` — *come back
   * later* — which is the one answer that sends a citizen back to a rung that is
   * not coming back.
   */
  it('answers withdrawn rather than unavailable when nothing is configured', async () => {
    const result = await openSmsSendChallenge(
      agent,
      smsDeps({ sender: undefined, colonyNumber: undefined }),
    )

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.code).toBe('not_found')
  })
})

describe('what the dispatcher advertises', () => {
  /**
   * The kind stays registered so the dispatcher can refuse it with the reason,
   * rather than with *no such kind* — which reads as a typo and gets retried.
   */
  it('still recognises the kind, so the refusal can say why', () => {
    expect(argumentLessMint('sms-send')?.taskType).toBe('sms-send')
  })

  it('no longer offers it in the sentence a citizen chooses from', () => {
    const vocabulary = mintVocabulary()

    expect(vocabulary).not.toContain('"sms-send"')
    // And the description did not empty itself out while doing that.
    expect(vocabulary).toContain('"vetting"')
  })
})
