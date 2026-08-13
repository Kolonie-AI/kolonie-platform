import { describe, expect, it } from 'vitest'
import type { AgentId } from '@kolonie-ai/core'
import { badgeSweep, walkRewardSweep } from './sweeps.js'

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
    }

    /** The ordinary pass: most hours no steward published anything. */
    it('says nothing when no entry was published', () => {
      expect(walkRewardSweep(async () => []).report([])).toBeUndefined()
    })

    it('names the providers the Atlas gained', () => {
      const line = walkRewardSweep(async () => []).report([paid])

      expect(line?.fields['event']).toBe('walks.rewarded')
      expect(line?.fields['providers']).toEqual(['mailbox:somewhere.example'])
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
