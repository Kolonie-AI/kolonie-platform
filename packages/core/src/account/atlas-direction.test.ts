import { describe, expect, it } from 'vitest'
import {
  DIRECTIONAL_KINDS,
  directionAnswers,
  directionScoped,
  kindHasDirection,
  type RecipeDirection,
} from './atlas-direction.js'

/**
 * The two rules the axis is made of (`#976`), tested where they live rather than
 * only through the shelf that uses them: whether a verdict answers a reader, and
 * what the reader is told when it does not.
 */

/** The shape both rules operate on, and nothing more of the recipe than that. */
function verdict(over: Partial<Parameters<typeof directionScoped>[0]> = {}) {
  return { status: 'refused', refusal: 'A2P registration.', cautions: [], ...over }
}

/** A caution as the row carries it since `#1041`: a sentence and what it was measured against. */
function caution(text: string, direction: RecipeDirection | null = null) {
  return { text, direction }
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
    const entry = verdict({ cautions: [caution('watch the console', 'inbound')] })

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
      verdict({
        status: 'measured',
        refusal: null,
        cautions: [caution('console-only', 'inbound')],
      }),
      'outbound',
      'inbound',
    )

    expect(scoped.status).toBe('measured')
  })

  /** The half of the title that is not the status: prose the reader did not come for. */
  it('withholds a caution measured against the other direction', () => {
    expect(
      directionScoped(
        verdict({ cautions: [caution('A2P brand registration', 'outbound')] }),
        'outbound',
        'inbound',
      ).cautions,
    ).toEqual([])
    expect(
      directionScoped(
        verdict({
          status: 'measured',
          refusal: null,
          cautions: [caution('A2P brand registration', 'outbound')],
        }),
        'outbound',
        'inbound',
      ).cautions,
    ).toEqual([])
  })

  /**
   * `#1041`, in one assertion. Before it there was one caution on the row scoped
   * by the row's verdict, so an entry could warn about receiving or about sending
   * and never both — the second warning overwrote the first. `twilio.com` is the
   * worked example, and each reader is now handed the wall that is theirs.
   */
  it('gives each reader the caution measured against what they came for', () => {
    const entry = verdict({
      status: 'joinable',
      refusal: null,
      cautions: [
        caution('A2P 10DLC brand registration before you may send.', 'outbound'),
        caution('Only console-verified numbers can receive.', 'inbound'),
      ],
    })

    expect(directionScoped(entry, null, 'outbound').cautions).toEqual([
      caution('A2P 10DLC brand registration before you may send.', 'outbound'),
    ])
    expect(directionScoped(entry, null, 'inbound').cautions).toEqual([
      caution('Only console-verified numbers can receive.', 'inbound'),
    ])
  })

  /** A reader who asked for nothing is asking for whatever there is. */
  it('gives a reader who asked for nothing all of them', () => {
    const cautions = [caution('sending', 'outbound'), caution('receiving', 'inbound')]

    expect(directionScoped(verdict({ cautions }), null, undefined).cautions).toEqual(cautions)
  })

  /**
   * The unscoped caution is the one every kind without an axis writes, and it
   * answers everybody — the same conservative reading `directionAnswers` gives a
   * verdict nobody scoped.
   */
  it('keeps an unscoped caution for a reader who asked for one direction', () => {
    const entry = verdict({
      cautions: [caution('the signup mails from a domain many filters drop')],
    })

    expect(directionScoped(entry, null, 'inbound').cautions).toEqual(entry.cautions)
  })

  /**
   * The filter runs whatever the row's own scope is, which is why there is no
   * early return: an entry measured `both` has a verdict that answers everybody
   * and cautions that may not, and returning early on the verdict would hand a
   * reader asking about receiving a warning about sending on exactly the entries
   * most likely to carry one.
   */
  it('filters the cautions of an entry whose verdict answers everybody', () => {
    const entry = verdict({
      status: 'joinable',
      refusal: null,
      cautions: [caution('A2P brand registration', 'outbound')],
    })

    expect(directionScoped(entry, 'both', 'inbound').cautions).toEqual([])
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
