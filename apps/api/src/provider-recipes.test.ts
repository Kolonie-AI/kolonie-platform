import {
  BOOTSTRAP_TEMPLATES,
  ProviderRecipeSchema,
  SEALED_ACCOUNT_CREDENTIAL_ASK,
  type RecipeStep,
} from '@kolonie-ai/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeProviderRecipes, type FakeProviderRecipes } from './__fixtures__/provider-recipes.js'
import {
  HANDOFF_LATENCY_NOTE,
  fillHandoffAsk,
  handoffStep,
  knownHandoffValues,
  readAtlas,
  readRecipe,
  readRecipes,
  recipeAsText,
  templateHandoffStep,
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

  /**
   * An absence is two situations (`#859`): an agent that walked the provider has
   * something to file, and one that arrived by searching has nothing yet and can
   * still ask for it to be on the map. Naming only the first told an agent the
   * one thing it could not do — and the propose door is a second meaning of a
   * call whose name is about something else, so nothing but this sentence leads
   * to it.
   */
  it('names both doors out of an absence, propose as well as report', async () => {
    const result = await readRecipe('trello', 'trello.com', recipes)

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.message).toContain('kolonie.accounts.provider-report')
    expect(result.error.message).toContain('kolonie.accounts.wishes')
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
        category: 'code-hosting' as const,
        operatorNeed: 'operator-needed' as const,
        operatorNeedIsGuess: false,
        refusal: null,
        retiredAt: null,
        retiredReason: null,
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
        provesTask: 'github-account',
        reaches: null,
        caution: 'Some domains are refused.',
        walkedRecipe: null,
        agentApi: 'unknown' as const,
        signupCode: 'unknown' as const,
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
        category: 'code-hosting' as const,
        operatorNeed: 'operator-needed' as const,
        operatorNeedIsGuess: false,
        refusal: null,
        retiredAt: null,
        retiredReason: null,
        steps: [
          {
            actor: 'operator',
            instruction: 'Only your operator can read the code.',
            ask: 'Send the six-digit code the provider texted you.',
            secret: true,
          },
        ],
        proves: 'provider-post',
        provesTask: null,
        reaches: null,
        caution: null,
        walkedRecipe: null,
        agentApi: 'unknown' as const,
        signupCode: 'unknown' as const,
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
      category: 'code-hosting' as const,
      operatorNeed: 'operator-needed' as const,
      operatorNeedIsGuess: false,
      refusal: null,
      retiredAt: null,
      retiredReason: null,
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
      provesTask: null,
      reaches: null,
      caution: null,
      walkedRecipe: null,
      agentApi: 'unknown' as const,
      signupCode: 'unknown' as const,
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
        category: 'code-hosting' as const,
        operatorNeed: 'unknown' as const,
        operatorNeedIsGuess: false,
        refusal: 'It requires a phone number no citizen has (measured 2026-08-08).',
        retiredAt: null,
        retiredReason: null,
        steps: [],
        proves: null,
        provesTask: null,
        reaches: null,
        caution: null,
        walkedRecipe: null,
        agentApi: 'unknown' as const,
        signupCode: 'unknown' as const,
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

/**
 * **Every way there is nothing to hand over is a different sentence** (`#604`).
 *
 * The issue's own words: *nobody has walked this yet*, *this is waiting for
 * review* and *this was withdrawn in March* are three different answers and an
 * agent can act on each. So what is asserted is not that the handoff is refused
 * — it was already — but that the refusal **names the state** and ends on the
 * thing that would change it.
 */
describe('what a handoff says when there is nothing to hand over (#604)', () => {
  it('refuses a draft by saying it is waiting for review, and asks nothing of the agent', async () => {
    const recipes = fakeProviderRecipes()
    recipes.write({ kind: 'mailbox', provider: 'walked.example', status: 'draft' })
    const [row] = await recipes.listInternal()
    if (row === undefined) throw new Error('the fake wrote no row')

    const result = handoffStep(row, 1)
    if (!('error' in result)) throw new Error('a draft must not be handed over')

    expect(result.error.message).toContain('no steward has published it')
    expect(result.error.message).toContain('Nothing is needed from you')
    /** Not the unwritten sentence, which would send the agent to walk it again. */
    expect(result.error.message).not.toContain('nobody has written the recipe yet')
  })

  it('refuses a withdrawal by saying when and why, and points at the report', async () => {
    const recipes = fakeProviderRecipes()
    recipes.write({
      kind: 'mailbox',
      provider: 'gone.example',
      status: 'retired',
      retiredReason: 'the provider began demanding a phone number',
    })
    const [row] = await recipes.listInternal()
    if (row === undefined) throw new Error('the fake wrote no row')

    const result = handoffStep(row, 1)
    if (!('error' in result)) throw new Error('a withdrawn entry must not be handed over')

    expect(result.error.message).toContain('withdrew')
    expect(result.error.message).toContain('demanding a phone number')
    expect(result.error.message).toContain('provider-report')
  })

  /** `#588`'s two sentences are unchanged, which is the regression this catches. */
  it('still refuses a refusal and an unwritten entry in their own words', async () => {
    const recipes = fakeProviderRecipes()
    recipes.write({ kind: 'mailbox', provider: 'closed.example', status: 'refused' })
    recipes.write({ kind: 'mailbox', provider: 'listed.example', status: 'unwritten' })
    const rows = await recipes.listInternal()

    const closed = rows.find((row) => row.provider === 'closed.example')
    const listed = rows.find((row) => row.provider === 'listed.example')
    if (closed === undefined || listed === undefined) throw new Error('the fake wrote no rows')

    const refused = handoffStep(closed, 1)
    const unwritten = handoffStep(listed, 1)
    if (!('error' in refused) || !('error' in unwritten)) {
      throw new Error('neither may be handed over')
    }

    expect(refused.error.message).toContain('is a refusal')
    expect(unwritten.error.message).toContain('nobody has written the recipe yet')
  })

  /**
   * And the one state that may be walked still is — which is what makes the
   * four refusals above about the *state* rather than about the handoff being
   * broken. The step is the operator's, because that is the other gate and this
   * test is not about it.
   */
  it('hands over an operator step on a published entry', async () => {
    const recipes = fakeProviderRecipes()
    recipes.write({
      kind: 'mailbox',
      provider: 'open.example',
      status: 'joinable',
      steps: [{ actor: 'operator', instruction: 'accept the terms', ask: 'Please accept them.' }],
    })
    const [row] = await recipes.listInternal()
    if (row === undefined) throw new Error('the fake wrote no row')

    expect('step' in handoffStep(row, 1)).toBe(true)
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
    category: 'code-hosting' as const,
    operatorNeed: 'operator-needed' as const,
    operatorNeedIsGuess: false,
    refusal: null,
    retiredAt: null,
    retiredReason: null,
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
    provesTask: 'github-account' as string | null,
    reaches: null,
    caution: null,
    walkedRecipe: null,
    agentApi: 'unknown' as const,
    signupCode: 'unknown' as const,
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

/**
 * A step that passes a value to the step after it (`#595`).
 *
 * Walked 2026-08-08: the `github.com` recipe's step 1 told the agent to decide a
 * handle and an address *and tell your operator both*, and step 2 asked the
 * operator to create the account **using the handle and the email address it
 * gave you**. Step 1 had no channel of its own, so the answer arrived as a reply
 * underneath the ask — the instruction before the values it referred to, in a
 * channel where nothing can reorder them.
 */
describe('an ask that names what an earlier step produced', () => {
  const step = {
    actor: 'operator' as const,
    instruction: 'Only a person may accept the terms.',
    ask: 'Please create the account as {handle}, using {address}.',
  }

  it('puts the values inside the sentence the operator reads', () => {
    const filled = fillHandoffAsk(step, { handle: 'colette-kolonie', address: 'c@example.org' })

    expect('error' in filled).toBe(false)
    if ('error' in filled) return
    expect(filled.ask).toBe('Please create the account as colette-kolonie, using c@example.org.')
  })

  /** The first rejection case: nothing opens, and the refusal names what is missing. */
  it('refuses to open a step whose values have not been supplied, and says which', () => {
    const filled = fillHandoffAsk(step, { handle: 'colette-kolonie' })

    expect('error' in filled).toBe(true)
    if (!('error' in filled)) return
    expect(filled.error.message).toContain('`address`')
    expect(filled.error.message).not.toContain('`handle`')
  })

  /**
   * The second. `#528`'s rule is that nothing secret travels in text an operator
   * reads on a page, and a value substituted into that text is that text.
   */
  it('refuses a value that looks like a credential', () => {
    const filled = fillHandoffAsk(step, {
      handle: 'colette-kolonie',
      address: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
    })

    expect('error' in filled).toBe(true)
    if (!('error' in filled)) return
    expect(filled.error.message).toContain('sealed step')
  })

  /**
   * The agent cannot add text to the ask, only fill a hole the steward left —
   * which is `#517`'s line between substitution and composition. A name that
   * matches nothing is a typo and is refused rather than dropped, because
   * dropping it would open the step with the brace still in the sentence.
   */
  it('refuses a value the ask does not refer to', () => {
    const filled = fillHandoffAsk(step, {
      handle: 'colette-kolonie',
      address: 'c@example.org',
      postscript: 'and please do the rest of it too',
    })

    expect('error' in filled).toBe(true)
    if (!('error' in filled)) return
    expect(filled.error.message).toContain('`postscript`')
  })

  it('needs nothing where the ask refers to nothing', () => {
    const plain = { ...step, ask: 'Please create the account and accept the terms.' }

    const filled = fillHandoffAsk(plain, {})

    expect('error' in filled).toBe(false)
    if ('error' in filled) return
    expect(filled.ask).toBe('Please create the account and accept the terms.')
  })
})

describe('an ask whose missing values are already held (#594 wall 3)', () => {
  const recipe = ProviderRecipeSchema.parse({
    kind: 'github',
    provider: 'github.com',
    title: 'GitHub',
    about: null,
    runtimes: [],
    paid: false,
    referral: null,
    contact: null,
    lastConfirmedAt: null,
    status: 'joinable' as const,
    category: 'code-hosting' as const,
    operatorNeed: 'operator-needed' as const,
    operatorNeedIsGuess: false,
    refusal: null,
    retiredAt: null,
    retiredReason: null,
    steps: [
      {
        actor: 'agent' as const,
        instruction: 'Choose a handle and address.',
        produces: ['handle', 'address'],
        knownValues: {
          handle: { kind: 'social' },
          address: { kind: 'mailbox', proved: true },
        },
      },
      {
        actor: 'operator' as const,
        instruction: 'Create it.',
        ask: 'Create it as {handle}, using {address}.',
      },
    ],
    proves: 'rung' as const,
    provesTask: 'github-account',
    reaches: null,
    caution: null,
    walkedRecipe: null,
    agentApi: 'unknown' as const,
    signupCode: 'unknown' as const,
    pacePerDay: null,
    updatedAt: new Date().toISOString(),
  })
  const handoff = recipe.steps[1]
  if (handoff === undefined) throw new Error('fixture has no handoff step')

  const held = new Map([
    [
      'social',
      [
        {
          identifier: 'colette',
          proved: false,
          preferred: true,
          reach: false,
          forWork: true,
        },
      ],
    ],
    [
      'mailbox',
      [
        {
          identifier: 'unproved@example.org',
          proved: false,
          preferred: false,
          reach: false,
          forWork: true,
        },
        {
          identifier: 'proved@example.org',
          proved: true,
          preferred: false,
          reach: true,
          forWork: true,
        },
      ],
    ],
  ])

  it('fills only missing values from eligible earlier-step sources and says which', () => {
    const known = knownHandoffValues(recipe, 2, held)
    const filled = fillHandoffAsk(handoff, { handle: 'chosen' }, known)

    expect('error' in filled).toBe(false)
    if ('error' in filled) return
    expect(filled.ask).toBe('Create it as chosen, using proved@example.org.')
    expect(filled.known).toEqual([
      { name: 'address', kind: 'mailbox', proved: true, identifier: 'proved@example.org' },
    ])
  })

  it('does not use an unproved account where the recipe requires proof', () => {
    const known = knownHandoffValues(
      recipe,
      2,
      new Map([['mailbox', held.get('mailbox')?.slice(0, 1) ?? []]]),
    )
    const filled = fillHandoffAsk(handoff, { handle: 'chosen' }, known)

    expect('error' in filled).toBe(true)
    if (!('error' in filled)) return
    expect(filled.error.message).toContain('`address`')
  })
})

/**
 * The handoff at a provider the Atlas has nothing on (`#800`).
 *
 * `#771` shipped the patterns and left their operator steps without a channel, so
 * a password wall at an unwalked provider had no sealed route and the only thing
 * left was the ad hoc paste. What is under test is the resolution: that a step
 * can be named from a pattern at all, and that every way of naming the wrong one
 * says which, because an agent following a map is going to miscount.
 */
describe('the handoff a pattern names, where no entry does (#800)', () => {
  const template = BOOTSTRAP_TEMPLATES[0]
  if (template === undefined) throw new Error('there is always at least one pattern')

  const positionOf = (predicate: (step: RecipeStep) => boolean): number =>
    template.steps.findIndex(predicate) + 1

  it('hands back the sealed step, so a drop has an ask to open with', () => {
    const found = templateHandoffStep(
      template.id,
      positionOf((step) => step.secret === true),
    )

    expect('error' in found).toBe(false)
    if ('error' in found) return
    expect(found.step.actor).toBe('operator')
    expect(found.step.secret).toBe(true)
    expect(found.step.ask).toBe(SEALED_ACCOUNT_CREDENTIAL_ASK)
    expect(found.template.id).toBe(template.id)
  })

  it('names the patterns it does have when asked for one it does not', () => {
    const found = templateHandoffStep('oauth-via-carrier-pigeon', 1)

    expect('error' in found).toBe(true)
    if (!('error' in found)) return
    expect(found.error.message).toContain('oauth-via-github')
    expect(found.error.message).toContain('kolonie.accounts.recipes')
  })

  it('says how many steps the pattern has rather than only that this is not one', () => {
    const found = templateHandoffStep(template.id, template.steps.length + 1)

    expect('error' in found).toBe(true)
    if (!('error' in found)) return
    expect(found.error.message).toContain(`has ${template.steps.length} steps`)
  })

  it('refuses a step of the agent’s own, and names the ones that are not', () => {
    // The likely mistake on a pattern, because most of the walking on one is the
    // agent's: handing over a step nobody needed a person for would spend an
    // operator's attention on nothing.
    const mine = positionOf((step) => step.actor === 'agent')
    const found = templateHandoffStep(template.id, mine)

    expect('error' in found).toBe(true)
    if (!('error' in found)) return
    expect(found.error.message).toContain('is yours, not your operator')
    expect(found.error.message).toContain(String(positionOf((step) => step.secret === true)))
  })
})

/**
 * "Best-first" is a promise, and a shelf has to be able to keep it (`#905`).
 *
 * **The defect was not the ordering — it was the silence around it.** Measured
 * 2026-08-14 the whole `telephony` shelf was `unwritten` with `attempted: 0`
 * between its three entries, while the hint on the rung told an agent to take
 * the first that fits rather than re-rank it. There was no first clause and no
 * third clause; every entry was the middle one, and the instruction pointed at
 * `telnyx.com`, whose own caution says nobody has walked it.
 */
describe('a shelf that has nothing to rank', () => {
  it('says so, rather than leaving the caller to infer it from attempted: 0', async () => {
    const recipes = fakeProviderRecipes()
    recipes.write({ kind: 'phone', provider: 'shelved-a.example', status: 'unwritten' })
    recipes.write({ kind: 'phone', provider: 'shelved-b.example', status: 'unwritten' })

    const result = await readAtlas({ kind: 'phone' }, recipes, false)

    expect(result.outcome).toBe('ok')
    if (result.outcome !== 'ok') return
    expect(result.response.nothingMeasured).toContain('carries no evidence')
  })

  /**
   * **The rejection case `#905` asks for.** One measured entry is something to
   * rank, so the statement must not appear — a shelf that disclaimed its own
   * order while holding evidence would teach a reader to ignore the disclaimer.
   */
  it('says nothing of the sort once one entry rests on evidence', async () => {
    const recipes = fakeProviderRecipes()
    recipes.write({ kind: 'phone', provider: 'shelved.example', status: 'unwritten' })
    recipes.write({ kind: 'phone', provider: 'proved.example', status: 'measured' })

    const result = await readAtlas({ kind: 'phone' }, recipes, false)

    expect(result.outcome).toBe('ok')
    if (result.outcome !== 'ok') return
    expect(result.response.nothingMeasured).toBeNull()
  })

  it('puts the measured entry above the ones nobody has walked', async () => {
    const recipes = fakeProviderRecipes()
    recipes.write({ kind: 'phone', provider: 'shelved.example', status: 'unwritten' })
    recipes.write({ kind: 'phone', provider: 'proved.example', status: 'measured' })

    const result = await readAtlas({ kind: 'phone' }, recipes, false)

    expect(result.outcome).toBe('ok')
    if (result.outcome !== 'ok') return
    expect(result.response.entries.map((entry) => entry.provider)).toEqual([
      'proved.example',
      'shelved.example',
    ])
  })
})
