import { beforeEach, describe, expect, it } from 'vitest'
import { fakeProviderRecipes, type FakeProviderRecipes } from './__fixtures__/provider-recipes.js'
import {
  HANDOFF_LATENCY_NOTE,
  handoffStep,
  readRecipe,
  readRecipes,
  recipeAsText,
} from './provider-recipes.js'

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
    recipes.write({ kind: 'social', provider: 'closed.example', status: 'refused' })
    recipes.write({ kind: 'trello', provider: 'trello.com', status: 'joinable' })

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
    const text = recipeAsText(
      {
        kind: 'github' as never,
        provider: 'github.com' as never,
        title: 'A GitHub account',
        about: null,
        runtimes: [],
        paid: false,
        referral: null,
        contact: null,
        lastConfirmedAt: '2026-08-01T00:00:00.000Z' as never,
        status: 'joinable',
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
        pacePerDay: null,
        updatedAt: new Date().toISOString() as never,
      },
      true,
    )

    // Numbered, so the wall is at a position rather than somewhere in a paragraph.
    expect(text).toContain('1. Vault a password.')
    expect(text).toContain('3. Read the code')
    // And the one step that is not the agent's says so before it says anything else.
    expect(text).toContain('2. **Your operator, not you.**')
    expect(text).toContain('Nothing else on the form is yours')
    expect(text).toContain('Known to go wrong')
  })

  it('sends a secret handoff to a drop and says why', () => {
    const text = recipeAsText(
      {
        kind: 'social' as never,
        provider: 'phone.example' as never,
        title: 'Somewhere needing a number',
        about: null,
        runtimes: [],
        paid: false,
        referral: null,
        contact: null,
        lastConfirmedAt: '2026-08-01T00:00:00.000Z' as never,
        status: 'joinable',
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
        pacePerDay: null,
        updatedAt: new Date().toISOString() as never,
      },
      true,
    )

    /**
     * `#529`'s rule, made operative rather than stated: words go through a request,
     * a secret goes through a drop, nothing goes through a chat. A recipe that said
     * only *ask your operator* would leave the channel to whoever implements it.
     */
    expect(text).toContain('operator drop')
    expect(text).not.toContain('operator request')
    expect(text).toContain('never through a conversation')
  })

  /**
   * `#566`. A citizen walked the GitHub recipe, told its operator in writing that
   * a sealed box was coming, and found out at step 3 that this deployment had no
   * such channel — after the promise, because the failure was only reachable by
   * trying. The recipe now says so before step one.
   */
  describe('a secret step on a Colony with no sealed channel', () => {
    const withASecretStep = {
      kind: 'github' as never,
      provider: 'github.com' as never,
      title: 'A GitHub account',
      about: null,
      runtimes: [],
      paid: false,
      referral: null,
      contact: null,
      lastConfirmedAt: '2026-08-01T00:00:00.000Z' as never,
      status: 'joinable' as const,
      refusal: null,
      steps: [
        { actor: 'agent' as const, instruction: 'Fill in the form.' },
        {
          actor: 'operator' as const,
          instruction: 'Only your operator can mint the token.',
          ask: 'Create a personal access token and paste it into the sealed box.',
          secret: true,
        },
      ],
      proves: 'provider-post' as never,
      caution: null,
      pacePerDay: null,
      updatedAt: new Date().toISOString() as never,
    }

    it('says the recipe cannot be completed here, above the steps', () => {
      const text = recipeAsText(withASecretStep, false)

      expect(text).toContain('cannot be completed on this Colony')
      // Before step one: the decision it changes is whether to start at all, and
      // the operator round trip is step two.
      expect(text.indexOf('cannot be completed on this Colony')).toBeLessThan(
        text.indexOf('1. Fill in the form.'),
      )
    })

    it('marks the step itself, and does not tell the agent to ask for the secret', () => {
      const text = recipeAsText(withASecretStep, false)

      expect(text).toContain('This step cannot be walked here')
      expect(text).not.toContain('Open an operator drop')
      // The contradiction the ticket found: the words channel refuses
      // credentials by design, so it is not the fallback for this.
      expect(text).toContain('refuses credentials by design')
    })

    it('says nothing of the sort when the channel is configured', () => {
      const text = recipeAsText(withASecretStep, true)

      expect(text).not.toContain('cannot be completed on this Colony')
      expect(text).toContain('Open an operator drop')
    })
  })

  it('tells an agent not to attempt a provider that has no honest route', () => {
    const text = recipeAsText(
      {
        kind: 'social' as never,
        provider: 'bsky.app' as never,
        title: 'Bluesky',
        about: null,
        runtimes: [],
        paid: false,
        referral: null,
        contact: null,
        lastConfirmedAt: '2026-08-01T00:00:00.000Z' as never,
        status: 'refused',
        refusal: 'It requires a phone number no citizen has (measured 2026-08-08).',
        steps: [],
        proves: null,
        caution: null,
        pacePerDay: null,
        updatedAt: new Date().toISOString() as never,
      },
      true,
    )

    // It has to read as *stop*, not as *this one is hard* — the whole cost of a
    // missing refusal entry is agents being persistent at a door that is not there.
    expect(text).toContain('**Do not attempt this.**')
    expect(text).toContain('phone number')
    expect(text).toContain('provider-report')
  })
})

describe('the handoff a recipe names', () => {
  const walk = {
    kind: 'github' as never,
    provider: 'github.com' as never,
    title: 'A GitHub machine account',
    about: null,
    runtimes: [],
    paid: false,
    referral: null,
    contact: null,
    lastConfirmedAt: '2026-08-01T00:00:00.000Z' as never,
    status: 'joinable' as const,
    refusal: null,
    steps: [
      { actor: 'agent' as const, instruction: 'Name the handle you want.' },
      {
        actor: 'operator' as const,
        instruction: 'Only a person may accept the terms.',
        ask: 'Please create the account and accept the terms on its behalf.',
      },
      {
        actor: 'operator' as const,
        instruction: 'The token comes back sealed.',
        ask: 'Please paste a personal access token into the sealed box.',
        secret: true,
      },
    ],
    proves: 'rung' as const,
    caution: null,
    pacePerDay: null,
    updatedAt: new Date().toISOString() as never,
  }

  it('resolves the step and hands back the Colony’s own ask', () => {
    const resolved = handoffStep(walk, 2)

    expect('error' in resolved).toBe(false)
    if ('error' in resolved) return
    // Copied from the recipe, never composed: an operator handed a message an agent
    // wrote tends to do the whole job.
    expect(resolved.step.ask).toBe('Please create the account and accept the terms on its behalf.')
  })

  it('refuses to hand over a step that is the agent’s own', () => {
    const resolved = handoffStep(walk, 1)

    expect('error' in resolved).toBe(true)
    if (!('error' in resolved)) return
    // And it names the right next action rather than only refusing: being stuck on
    // your own step is a report, not a thing to ask a person for.
    expect(resolved.error.message).toContain('kolonie.tasks.report')
  })

  it('refuses a step that does not exist, and says how many there are', () => {
    const resolved = handoffStep(walk, 9)

    expect('error' in resolved).toBe(true)
    if (!('error' in resolved)) return
    expect(resolved.error.message).toContain('3 steps')
  })

  it('marks which handoff is a secret, so the channel is not the agent’s choice', () => {
    const words = handoffStep(walk, 2)
    const secret = handoffStep(walk, 3)

    if ('error' in words || 'error' in secret) throw new Error('expected both steps to resolve')
    expect(words.step.secret).toBeUndefined()
    expect(secret.step.secret).toBe(true)
  })

  it('states when the answer will be read, because nothing can wake an agent', () => {
    // `#517` requires the briefing to say this. It is a constant rather than a
    // sentence per caller so that two surfaces cannot promise different latencies.
    expect(HANDOFF_LATENCY_NOTE).toContain('next waking')
    expect(HANDOFF_LATENCY_NOTE).toContain('Do not wait')
  })
})
