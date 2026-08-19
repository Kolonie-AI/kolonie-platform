import { describe, expect, it } from 'vitest'
import type { AgentId } from '@kolonie-ai/core'
import { badgeSweep, operateNoteRewardSweep, walkRewardSweep } from './sweeps.js'

describe('what a pass is worth saying', () => {
  describe('badges', () => {
    it('says nothing when nothing was given out', () => {
      expect(badgeSweep(async () => ({})).report({})).toBeUndefined()
    })

    it('names what was awarded', () => {
      const line = badgeSweep(async () => ({})).report({ 'first-light': 3 })

      expect(line?.fields['event']).toBe('badges.awarded')
    })
  })

  describe('walk rewards', () => {
    const paid = {
      walkId: 'a-walk',
      agentId: 'an-agent' as AgentId,
      kind: 'mailbox',
      provider: 'somewhere.example',
      outcome: 'refused',
    }

    /** The ordinary pass: most hours nothing new has cleared moderation. */
    it('says nothing when no walk was published', () => {
      expect(walkRewardSweep(async () => []).report([])).toBeUndefined()
    })

    /**
     * **The outcome is in the line** (`#1033`). Every outcome pays the same, so
     * a count alone would leave *is the Colony actually paying failed walks*
     * readable nowhere but the database — and that is the whole claim.
     */
    it('names the providers the Atlas learned about, and how each walk ended', () => {
      const line = walkRewardSweep(async () => []).report([paid])

      expect(line?.fields['event']).toBe('walks.rewarded')
      expect(line?.fields['providers']).toEqual(['mailbox:somewhere.example:refused'])
    })

    /**
     * **Who was paid is on the reputation record and not in a log** — the rule
     * the whole runner is written to, asserted rather than left to a reviewer.
     */
    it('names no citizen', () => {
      const line = walkRewardSweep(async () => []).report([paid])

      expect(JSON.stringify(line)).not.toContain(paid.agentId)
      expect(JSON.stringify(line)).not.toContain(paid.walkId)
    })
  })
})

/**
 * The Atlas's second contribution class (`#1300`).
 *
 * **A sweep of its own rather than a branch in the walk sweep.** The two pay for
 * different deeds under different scarcity clauses, and a pass that paid four
 * walks and no tips should say so rather than report a total that hides which.
 */
describe('the operate tip reward sweep', () => {
  const paid = {
    noteId: 'a-note',
    agentId: 'an-agent' as never,
    kind: 'mailbox',
    provider: 'gmx.com',
    tag: 'access-method',
  }

  it('says nothing about a pass that paid nothing', () => {
    expect(operateNoteRewardSweep(async () => []).report([])).toBeUndefined()
  })

  it('names the pair and the tag, and never the citizen', () => {
    const line = operateNoteRewardSweep(async () => []).report([paid])

    expect(line?.fields).toMatchObject({ event: 'operate-notes.rewarded', paid: 1 })
    expect(JSON.stringify(line)).toContain('mailbox:gmx.com:access-method')
    expect(JSON.stringify(line)).not.toContain('an-agent')
  })
})
