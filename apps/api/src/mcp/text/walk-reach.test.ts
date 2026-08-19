import { describe, expect, it } from 'vitest'
import { AccountCapabilitySchema, type AccountWalk } from '@kolonie-ai/core'
import { walkReachAsText } from './walk-reach.js'

/** The capability the reach sequence in these tests arrives at. */
const API = AccountCapabilitySchema.parse('api')

const walk = (over: Partial<AccountWalk> = {}): AccountWalk => ({
  id: '00000000-0000-4000-8000-000000000001',
  agentId: '00000000-0000-4000-8000-000000000002',
  kind: 'mailbox' as never,
  provider: 'somewhere.example' as never,
  startedAt: '2026-08-09T00:00:00.000Z' as never,
  finishedAt: '2026-08-09T00:40:00.000Z' as never,
  outcome: 'proved',
  closedByTransferAt: null,
  direction: null,
  /** Nothing here is refused; the moderation axis has its own tests (`#1340`). */
  proseRefusalReason: null,
  wall: null,
  note: null,
  did: null,
  broke: null,
  changed: null,
  discarded: null,
  about: null,
  /** Null beside `about` (`#1296`): the field is `string | null`, not optional. */
  homepage: null,
  takenStepPositions: null,
  recipe: null,
  steps: [],
  ...over,
})

/** Two signup steps, then two more that get something past the account. */
const REACHING = {
  steps: [
    { actor: 'agent' as const, instruction: 'Sign up.' },
    { actor: 'agent' as const, instruction: 'Confirm the address.' },
  ],
  reaches: {
    capability: API,
    steps: [
      { actor: 'agent' as const, instruction: 'Open the form.' },
      { actor: 'agent' as const, instruction: 'Read the key.' },
    ],
  },
}

const PLAIN = { steps: REACHING.steps, reaches: null }

describe('what the tick-list said about the half past the account', () => {
  it('reads the capability off the positions, without asking for it again', () => {
    const text = walkReachAsText(walk({ takenStepPositions: [1, 2, 3, 4] }), REACHING)

    expect(text).toContain('positions 3–4')
    expect(text).toContain(`records ${API} past the account`)
    expect(text).toContain('no second form')
  })

  /**
   * The soft half of `#1170`: an invitation and never a reproach. Stopping at
   * the account is walking the entry as published, so the text says so in as
   * many words before it says what the rest of the list is for.
   */
  it('invites rather than warns when the walk stopped at the account', () => {
    const text = walkReachAsText(walk({ takenStepPositions: [1, 2] }), REACHING)

    expect(text).toContain('goes further than the account')
    expect(text).toContain('is not a failure')
    expect(text).toContain('walked the recipe as published')
    expect(text).not.toContain('past the account and not')
  })

  it('says nothing about an entry that reaches nowhere', () => {
    expect(walkReachAsText(walk({ takenStepPositions: [1, 2] }), PLAIN)).toBe('')
  })

  it('says nothing where no entry is published at all', () => {
    expect(walkReachAsText(walk({ takenStepPositions: [1, 2] }), undefined)).toBe('')
  })

  /**
   * A walk that did not end with the account has no capability half to speak
   * of, and a refusal is the wrong moment to be offered more steps.
   */
  it('says nothing on a walk that did not get the account', () => {
    expect(walkReachAsText(walk({ outcome: 'refused', takenStepPositions: [1] }), REACHING)).toBe(
      '',
    )
  })

  /** A single reach step is one position, and the sentence has to read as one. */
  it('names one position in the singular', () => {
    const text = walkReachAsText(walk({ takenStepPositions: [1, 2] }), {
      steps: REACHING.steps,
      reaches: { capability: API, steps: [REACHING.reaches.steps[0]!] },
    })

    expect(text).toContain('position 3 is how it gets')
  })
})
