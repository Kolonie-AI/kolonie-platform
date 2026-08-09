import { describe, expect, it } from 'vitest'
import { badgeSweep } from './sweeps.js'

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
})
