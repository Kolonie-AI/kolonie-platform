import { describe, expect, it } from 'vitest'
import {
  WALK_PROSE_FIELDS,
  WALK_PROSE_QUESTIONS,
  walkHasProse,
  walkProse,
  walkProseText,
} from './walk-prose.js'

describe('the words a walk leaves behind', () => {
  it('keeps every field a citizen answered and nothing it did not', () => {
    const prose = walkProse({
      did: 'I opened the signup page.',
      broke: null,
      changed: '   ',
      note: 'The recipe said no phone number and it asked for one.',
      wall: null,
    })

    expect(prose).toEqual({
      did: 'I opened the signup page.',
      note: 'The recipe said no phone number and it asked for one.',
    })
  })

  /**
   * A column that did not exist when a row was written reads as `undefined`, and
   * a reader that threw on one would take the moderation pass down over a walk
   * from last week.
   */
  it('reads an absent field as an unanswered one', () => {
    expect(walkProse({})).toEqual({})
    expect(walkHasProse(walkProse({}))).toBe(false)
    expect(walkHasProse(walkProse({ wall: 'It wanted a card.' }))).toBe(true)
  })

  it('shows each answer under the question it answers, in a stable order', () => {
    const text = walkProseText(
      walkProse({ broke: 'It asked for a card.', did: 'I filled the form in.' }),
    )

    expect(text).toBe(
      `${WALK_PROSE_QUESTIONS.did}\nI filled the form in.\n\n` +
        `${WALK_PROSE_QUESTIONS.broke}\nIt asked for a card.`,
    )
  })

  /** Every field has a question, so no surface has to invent one for a scrub. */
  it('has a question for every field it collects', () => {
    for (const field of WALK_PROSE_FIELDS) {
      expect(WALK_PROSE_QUESTIONS[field]).toBeTruthy()
    }
  })

  it('is empty text when nothing was written', () => {
    expect(walkProseText({})).toBe('')
  })
})
