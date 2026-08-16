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

  /**
   * The route joined the six at `#1090`, and the two things that could go wrong
   * with it are both about what the moderator is shown: a route that never
   * arrives is a page nobody reads, and a route arriving with its own preamble
   * tells that reader the words have not been checked while it is checking them.
   */
  describe('the walked route', () => {
    const recipe = { steps: [{ title: 'Choose the OAuth button.' }] }

    it('renders the recipe into a field of its own', () => {
      const prose = walkProse({ recipe })

      expect(prose.route).toContain('Choose the OAuth button.')
      expect(walkHasProse(prose)).toBe(true)
    })

    /** A walk that wrote no recipe has no route, rather than an empty one. */
    it('is absent when no recipe was written', () => {
      expect(walkProse({ note: 'Nothing structural to add.' }).route).toBeUndefined()
    })

    /**
     * The banner `walkedRecipeAsText` normally carries says the Colony has not
     * checked these words. Inside the corpus that is what the check is reading,
     * so it is off — and a reader of the published route is told the opposite by
     * `walkRouteAsText` instead.
     */
    it('carries no attribution banner of its own', () => {
      expect(walkProse({ recipe }).route).not.toContain('The Colony has not checked them')
    })

    it('reaches the text the moderator is shown, under its question', () => {
      expect(walkProseText(walkProse({ recipe }))).toContain(WALK_PROSE_QUESTIONS.route)
    })
  })
})
