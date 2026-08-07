import { beforeEach, describe, expect, it } from 'vitest'
import { fakeProviderRecipes, type FakeProviderRecipes } from './__fixtures__/provider-recipes.js'
import { readRecipe, readRecipes, recipeAsText } from './provider-recipes.js'

/**
 * The catalogue, as an agent reads it (`#521`).
 *
 * What is under test is the *text*, because that is what an agent acts on: whether
 * the one step that is not its own is unmistakable, and whether a refusal reads as
 * *stop* rather than as *try harder*.
 */

let recipes: FakeProviderRecipes

beforeEach(() => {
  recipes = fakeProviderRecipes()
})

describe('reading the catalogue', () => {
  it('says plainly when nothing is known, rather than answering an empty list', async () => {
    const result = await readRecipes(undefined, recipes)

    expect(result.outcome).toBe('ok')
    if (result.outcome !== 'ok') return
    expect(result.response.recipes).toEqual([])
  })

  it('distinguishes no entry from a refusal', async () => {
    const result = await readRecipe('trello', 'trello.com', recipes)

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.code).toBe('not_found')
    /**
     * **The distinction an agent must not lose.** *Nobody has written one* and *this
     * cannot be joined* want opposite next actions — walk it and report, or do not
     * try — and an absence answered as a warning would stop attempts nobody has any
     * reason to stop.
     */
    expect(result.error.message).toContain('absence')
    expect(result.error.message).toContain('provider-report')
  })

  it('puts what can be acted on above what cannot', async () => {
    recipes.write({ kind: 'social', provider: 'closed.example', joinable: false })
    recipes.write({ kind: 'trello', provider: 'trello.com', joinable: true })

    const result = await readRecipes(undefined, recipes)
    if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

    expect(result.response.recipes[0]?.provider).toBe('trello.com')
  })

  it('refuses a kind that is not a slug', async () => {
    const result = await readRecipes('Not A Kind', recipes)

    expect(result.outcome).toBe('rejected')
  })
})

describe('what the recipe says to the agent walking it', () => {
  it('marks the operator step unmistakably and carries the Colony’s own ask', () => {
    const text = recipeAsText({
      kind: 'github' as never,
      provider: 'github.com' as never,
      title: 'A GitHub account',
      joinable: true,
      refusal: null,
      steps: [
        { actor: 'agent', instruction: 'Vault a password.' },
        {
          actor: 'operator',
          instruction: 'A puzzle no agent may honestly pass.',
          ask: 'Open the page and complete the puzzle. Nothing else on the form is yours.',
        },
        { actor: 'agent', instruction: 'Read the code from your own mailbox.' },
      ],
      proves: 'rung',
      caution: 'Some domains are refused.',
      updatedAt: new Date().toISOString() as never,
    })

    // Numbered, so the wall is at a position rather than somewhere in a paragraph.
    expect(text).toContain('1. Vault a password.')
    expect(text).toContain('3. Read the code')
    // And the one step that is not the agent's says so before it says anything else.
    expect(text).toContain('2. **Your operator, not you.**')
    expect(text).toContain('Nothing else on the form is yours')
    expect(text).toContain('Known to go wrong')
  })

  it('sends a secret handoff to a drop and says why', () => {
    const text = recipeAsText({
      kind: 'social' as never,
      provider: 'phone.example' as never,
      title: 'Somewhere needing a number',
      joinable: true,
      refusal: null,
      steps: [
        {
          actor: 'operator',
          instruction: 'Only your operator can read the code.',
          ask: 'Send the six-digit code the provider texted you.',
          secret: true,
        },
      ],
      proves: 'provider-post',
      caution: null,
      updatedAt: new Date().toISOString() as never,
    })

    /**
     * `#529`'s rule, made operative rather than stated: words go through a request,
     * a secret goes through a drop, nothing goes through a chat. A recipe that said
     * only *ask your operator* would leave the channel to whoever implements it.
     */
    expect(text).toContain('operator drop')
    expect(text).not.toContain('operator request')
    expect(text).toContain('never through a conversation')
  })

  it('tells an agent not to attempt a provider that has no honest route', () => {
    const text = recipeAsText({
      kind: 'social' as never,
      provider: 'bsky.app' as never,
      title: 'Bluesky',
      joinable: false,
      refusal: 'It requires a phone number no citizen has (measured 2026-08-08).',
      steps: [],
      proves: null,
      caution: null,
      updatedAt: new Date().toISOString() as never,
    })

    // It has to read as *stop*, not as *this one is hard* — the whole cost of a
    // missing refusal entry is agents being persistent at a door that is not there.
    expect(text).toContain('**Do not attempt this.**')
    expect(text).toContain('phone number')
    expect(text).toContain('provider-report')
  })
})
