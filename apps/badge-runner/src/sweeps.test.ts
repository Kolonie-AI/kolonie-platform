import { describe, expect, it } from 'vitest'
import { badgeSweep, refundSweep } from './sweeps.js'
import type { TaskId } from '@kolonie-ai/core'

const aTask = (name: string): TaskId => name as TaskId

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

  describe('quest refunds', () => {
    const spec = refundSweep(async () => ({ refunded: [], failed: [] }))

    it('says nothing on a pass that found no finished quest', () => {
      expect(spec.report({ refunded: [], failed: [] })).toBeUndefined()
    })

    /**
     * The amount is in the line, not only in the ledger. `#315`'s whole argument
     * is that this leg had never run against a real balance — so the first time
     * it does, the log says how much came back and for which quest, without
     * anyone having to reconstruct it from `ledger_entries`.
     */
    it('reports every refund and the total that came back', () => {
      const line = spec.report({
        refunded: [
          { taskId: aTask('quest-a'), credits: 40 },
          { taskId: aTask('quest-b'), credits: 2 },
        ],
        failed: [],
      })

      expect(line?.fields['event']).toBe('quest.refunds.swept')
      expect(line?.fields['credits']).toBe(42)
      expect(line?.message).toContain('2 refunded')
    })

    /**
     * A quest that could not be refunded is reported even when nothing else
     * happened — this is the one outcome here worth waking somebody for, and a
     * pass of nought refunds and one failure would otherwise be silence.
     */
    it('reports a failure on an otherwise empty pass, with its reason', () => {
      const line = spec.report({
        refunded: [],
        failed: [{ taskId: aTask('quest-c'), error: new Error('escrow overdrawn') }],
      })

      expect(line).toBeDefined()
      expect(JSON.stringify(line?.fields['failed'])).toContain('escrow overdrawn')
    })

    /** A failure that is not an `Error` still has to render as something readable. */
    it('renders a thrown non-error', () => {
      const line = spec.report({ refunded: [], failed: [{ taskId: aTask('q'), error: 'nope' }] })

      expect(JSON.stringify(line?.fields['failed'])).toContain('nope')
    })

    /** What a failed pass hands back, so no caller deals in `undefined`. */
    it('has an empty value that is a pass which did nothing', () => {
      expect(spec.empty).toEqual({ refunded: [], failed: [] })
    })
  })
})
