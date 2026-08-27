import { describe, expect, it } from 'vitest'
import { MESSAGE_IDLE_AFTER_DAYS } from './message.js'

describe('MESSAGE_IDLE_AFTER_DAYS (#1560)', () => {
  /**
   * **One number, every kind.** A per-kind table would fix three numbers on an
   * argument nobody has measured; this is the honest starting point, and it is
   * revisited with data rather than in advance.
   */
  it('is thirty days for every conversation kind', () => {
    expect(MESSAGE_IDLE_AFTER_DAYS).toBe(30)
  })
})
