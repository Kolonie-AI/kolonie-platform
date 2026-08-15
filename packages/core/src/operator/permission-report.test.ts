import { describe, expect, it } from 'vitest'
import {
  PERMISSION_AGGREGATE_FLOOR,
  PermissionBlockSchema,
  blocksNameMoney,
  capabilitiesUnblocking,
  levelUnblocking,
  needsChallengePermission,
} from './permission-report.js'
import { AUTONOMY_LEVELS } from '../agent/autonomy.js'

/**
 * The two decisions in this module that a later change could quietly undo: that
 * `free` is unreachable, and that a permission is not a level.
 */
describe('what a block maps to', () => {
  it('asks for independent when the citizen must act outwards', () => {
    for (const block of ['hold-an-account', 'publish', 'run-unattended'] as const) {
      expect(levelUnblocking([block]), block).toBe('independent')
    }
  })

  /**
   * `#146` made `challengesAllowed` a separate question because it does not follow
   * from the level: *"an accompanied agent may well be allowed, and an independent
   * one may well not."* A recommendation that answered it with a level would be
   * asking for the wrong thing.
   */
  it('asks for a permission and no level when the block is a human check', () => {
    expect(levelUnblocking(['clear-a-human-check'])).toBeNull()
    expect(needsChallengePermission(['clear-a-human-check'])).toBe(true)
  })

  it('names no level for a block the list does not cover', () => {
    expect(levelUnblocking(['other'])).toBeNull()
    expect(needsChallengePermission(['other'])).toBe(false)
  })

  it('asks for the highest of a mixed set, and still no more', () => {
    expect(levelUnblocking(['other', 'clear-a-human-check', 'publish'])).toBe('independent')
    expect(needsChallengePermission(['other', 'clear-a-human-check', 'publish'])).toBe(true)
  })

  /**
   * **`free` is unreachable, and this test is the guard on it.**
   *
   * `#147`: *"It never proposes Free by default. A module that always answers give it
   * everything is a module operators learn to ignore on the second reading."* The way
   * that is kept true is that no input produces it — so this asserts over *every*
   * subset of the vocabulary rather than over the cases somebody thought of.
   */
  it('cannot be made to ask for free, whatever combination is reported', () => {
    const blocks = PermissionBlockSchema.options
    const subsets: (typeof blocks)[number][][] = [[]]

    for (const block of blocks) {
      for (const subset of [...subsets]) subsets.push([...subset, block])
    }

    expect(subsets).toHaveLength(2 ** blocks.length)
    for (const subset of subsets) {
      expect(levelUnblocking(subset), JSON.stringify(subset)).not.toBe('free')
    }
    // And `free` really is a level that exists, so the assertion above is not
    // passing because the value was renamed underneath it.
    expect(AUTONOMY_LEVELS).toContain('free')
  })

  it('asks for nothing when nothing was reported', () => {
    expect(levelUnblocking([])).toBeNull()
    expect(needsChallengePermission([])).toBe(false)
    expect(capabilitiesUnblocking([])).toEqual([])
  })

  /**
   * A capability is the third kind of answer, on the same argument as the second
   * (`#779`): no level grants a listening socket and no level withholds one, so a
   * recommendation that answered this with a level would ask for the wrong thing —
   * and before the value existed it was filed as `other`, which names nothing.
   */
  it('asks for a capability and no level when the block is server work', () => {
    expect(levelUnblocking(['run-a-web-server'])).toBeNull()
    expect(needsChallengePermission(['run-a-web-server'])).toBe(false)
    expect(capabilitiesUnblocking(['run-a-web-server'])).toEqual(['web-server'])
  })

  it('names no capability for the blocks that are levels or permissions', () => {
    expect(capabilitiesUnblocking(['hold-an-account', 'clear-a-human-check', 'other'])).toEqual([])
  })

  it('names every kind at once when a mixed set asks for all three', () => {
    const blocks = ['publish', 'clear-a-human-check', 'run-a-web-server'] as const

    expect(levelUnblocking(blocks)).toBe('independent')
    expect(needsChallengePermission(blocks)).toBe(true)
    expect(capabilitiesUnblocking(blocks)).toEqual(['web-server'])
  })

  /**
   * **Money is the one block that asks the contract for nothing** (`#978`), and that
   * is the answer rather than an omission: no level grants a card, there is no
   * capability that means *may spend*, and a recommendation proposing one would be
   * asking for something that would not help. What the value buys is the count.
   */
  it('asks for no level, no permission and no capability when the block is money', () => {
    expect(levelUnblocking(['cannot-pay'])).toBeNull()
    expect(needsChallengePermission(['cannot-pay'])).toBe(false)
    expect(capabilitiesUnblocking(['cannot-pay'])).toEqual([])
    expect(blocksNameMoney(['cannot-pay'])).toBe(true)
  })

  it('says money was not what stopped it for every other block', () => {
    for (const block of PermissionBlockSchema.options.filter((one) => one !== 'cannot-pay')) {
      expect(blocksNameMoney([block]), block).toBe(false)
    }
    expect(blocksNameMoney([])).toBe(false)
  })

  it('still names the level a mixed set asks for when one of them was money', () => {
    const blocks = ['cannot-pay', 'hold-an-account'] as const

    expect(levelUnblocking(blocks)).toBe('independent')
    expect(blocksNameMoney(blocks)).toBe(true)
  })
})

describe('the aggregate floor', () => {
  /**
   * The number is above two on purpose: a floor of two publishes *"two citizens"*,
   * and either of them reading it knows the other's contract.
   */
  it('is high enough that a row cannot be about one or two citizens', () => {
    expect(PERMISSION_AGGREGATE_FLOOR).toBeGreaterThan(2)
  })
})
