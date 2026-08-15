import { describe, expect, it } from 'vitest'
import {
  DIRECTIONAL_KINDS,
  directionAnswers,
  directionScoped,
  kindHasDirection,
} from './atlas-direction.js'

/**
 * The two rules the axis is made of (`#976`), tested where they live rather than
 * only through the shelf that uses them: whether a verdict answers a reader, and
 * what the reader is told when it does not.
 */

/** The shape both rules operate on, and nothing more of the recipe than that. */
function verdict(over: Partial<Parameters<typeof directionScoped>[0]> = {}) {
  return { status: 'refused', refusal: 'A2P registration.', caution: null, ...over }
}

describe('directionAnswers', () => {
  it('answers a reader who asked for nothing in particular', () => {
    expect(directionAnswers('outbound', undefined)).toBe(true)
  })

  /**
   * The conservative default. A verdict recorded before anybody wrote down which
   * way it was measured answers everybody, because the alternative is hiding a
   * real refusal from half the citizens it applies to.
   */
  it('answers everybody when nobody said which way it was measured', () => {
    expect(directionAnswers(null, 'inbound')).toBe(true)
    expect(directionAnswers(null, 'outbound')).toBe(true)
  })

  it('answers the direction it was measured against', () => {
    expect(directionAnswers('inbound', 'inbound')).toBe(true)
    expect(directionAnswers('outbound', 'inbound')).toBe(false)
  })

  it('lets both satisfy either side of the question', () => {
    expect(directionAnswers('both', 'inbound')).toBe(true)
    expect(directionAnswers('outbound', 'both')).toBe(true)
  })
})

describe('directionScoped', () => {
  it('hands back an answering verdict untouched', () => {
    const entry = verdict({ caution: 'watch the console' })

    expect(directionScoped(entry, 'inbound', 'inbound')).toEqual(entry)
  })

  /**
   * The defect, in one assertion. `unwritten` and not the refusal, because the
   * Atlas already has a word for *nobody has been here* and that is the true
   * answer: a provider refused for sending has not been refused for receiving.
   */
  it('reads a refusal measured elsewhere as unwritten', () => {
    const scoped = directionScoped(verdict(), 'outbound', 'inbound')

    expect(scoped.status).toBe('unwritten')
    expect(scoped.refusal).toBeNull()
  })

  /**
   * Only a refusal is rewritten. `measured` costs a reader nothing — its figures
   * count attempts, and those are true whichever way the agents were going — so
   * rewriting it would throw evidence away to fix a verdict that was never in
   * anybody's way.
   */
  it('leaves a measured verdict standing whichever way it was measured', () => {
    const scoped = directionScoped(
      verdict({ status: 'measured', refusal: null, caution: 'console-only' }),
      'outbound',
      'inbound',
    )

    expect(scoped.status).toBe('measured')
  })

  /** The half of the title that is not the status: prose the reader did not come for. */
  it('withholds a caution measured against the other direction', () => {
    expect(
      directionScoped(verdict({ caution: 'console-only' }), 'outbound', 'inbound').caution,
    ).toBeNull()
    expect(
      directionScoped(
        verdict({ status: 'measured', refusal: null, caution: 'console-only' }),
        'outbound',
        'inbound',
      ).caution,
    ).toBeNull()
  })
})

describe('kindHasDirection', () => {
  it('knows the one kind the axis is about so far', () => {
    expect(kindHasDirection('phone')).toBe(true)
    expect(DIRECTIONAL_KINDS).toContain('phone')
  })

  /**
   * A mailbox has the same shape of question and no evidence behind it yet. The
   * list stays short until somebody has walked one, because a field offered on a
   * kind nobody measured is a field that collects guesses.
   */
  it('leaves every other kind off the axis', () => {
    expect(kindHasDirection('mailbox')).toBe(false)
    expect(kindHasDirection('github')).toBe(false)
  })
})
