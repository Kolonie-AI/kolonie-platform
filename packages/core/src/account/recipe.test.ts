import { describe, expect, it } from 'vitest'
import {
  RecipeAfterProofSchema,
  RecipeStatusSchema,
  RecipeStepSchema,
  SignupCodeSchema,
  WriteProviderRecipeSchema,
  operatorStepCount,
  recipeWall,
  recipeStatusAllowsSteps,
  recipeStatusIsOfferable,
  recipeStatusIsPublic,
} from './recipe.js'

describe('what a proved account opens next (#637)', () => {
  const afterProof = {
    capability: 'api',
    steps: [
      {
        actor: 'agent',
        instruction: 'Open the provider console and create the API credential.',
      },
    ],
  }

  it('carries a named capability and an ordered route to it', () => {
    expect(RecipeAfterProofSchema.safeParse(afterProof).success).toBe(true)
    expect(
      WriteProviderRecipeSchema.safeParse({
        kind: 'project-tracker',
        provider: 'tracker.example',
        title: 'Tracker',
        category: 'project-tracking',
        status: 'joinable',
        steps: [{ actor: 'agent', instruction: 'Create the account.' }],
        proves: 'provider-mail',
        afterProof,
      }).success,
    ).toBe(true)
  })

  it('refuses an empty route or one that promises an unsupported operator handoff', () => {
    expect(RecipeAfterProofSchema.safeParse({ ...afterProof, steps: [] }).success).toBe(false)
    expect(
      RecipeAfterProofSchema.safeParse({
        ...afterProof,
        steps: [
          {
            actor: 'operator',
            instruction: 'Create the credential.',
            ask: 'Create the credential for the agent.',
          },
        ],
      }).success,
    ).toBe(false)
  })
})

/**
 * The three states `#604` added, and the two properties no surface can infer
 * from the name.
 *
 * **The predicates are tested and not only the enum**, because every surface
 * branches on one of them: `recipeStatusIsPublic` decides whether a stranger
 * sees the entry at all, and `recipeStatusIsOfferable` decides whether an agent
 * may be sent to walk it. A surface that guessed would render a draft as
 * joinable, which is an agent following a recipe nobody approved.
 */
describe('the life of an Atlas entry (#604)', () => {
  it('holds all six states, in the order the life happens in', () => {
    expect(RecipeStatusSchema.options).toEqual([
      'proposed',
      'unwritten',
      'draft',
      'joinable',
      'refused',
      'retired',
    ])
  })

  it('keeps two of them off every public surface', () => {
    expect(RecipeStatusSchema.options.filter((one) => !recipeStatusIsPublic(one))).toEqual([
      'proposed',
      'draft',
    ])
  })

  /**
   * **Narrower than public, deliberately.** A retired entry has a page a reader
   * can still open and is not on offer; the two questions are not the same one.
   */
  it('offers exactly one of them to an agent', () => {
    expect(RecipeStatusSchema.options.filter(recipeStatusIsOfferable)).toEqual(['joinable'])
  })

  it('lets a walk carry steps before anybody has published it', () => {
    expect(recipeStatusAllowsSteps('draft')).toBe(true)
    expect(recipeStatusAllowsSteps('retired')).toBe(true)
    expect(recipeStatusAllowsSteps('proposed')).toBe(false)
    expect(recipeStatusAllowsSteps('unwritten')).toBe(false)
    expect(recipeStatusAllowsSteps('refused')).toBe(false)
  })

  describe('what the write shape refuses', () => {
    const entry = {
      kind: 'mailbox',
      provider: 'walked.example',
      title: 'Walked',
      category: 'mailbox',
      steps: [{ actor: 'agent', instruction: 'sign up' }],
    }

    it('takes a draft with steps and no proof', () => {
      expect(WriteProviderRecipeSchema.safeParse({ ...entry, status: 'draft' }).success).toBe(true)
    })

    it('refuses a draft with no steps, because that is an unwritten entry', () => {
      expect(
        WriteProviderRecipeSchema.safeParse({ ...entry, status: 'draft', steps: [] }).success,
      ).toBe(false)
    })

    it('refuses a withdrawal that does not say why', () => {
      expect(WriteProviderRecipeSchema.safeParse({ ...entry, status: 'retired' }).success).toBe(
        false,
      )
    })

    it('takes a withdrawal that says why, and keeps its steps', () => {
      expect(
        WriteProviderRecipeSchema.safeParse({
          ...entry,
          status: 'retired',
          retiredReason: 'the provider began demanding a phone number',
        }).success,
      ).toBe(true)
    })

    it('refuses a withdrawal reason on an entry that is not withdrawn', () => {
      expect(
        WriteProviderRecipeSchema.safeParse({
          ...entry,
          status: 'draft',
          retiredReason: 'but it is open',
        }).success,
      ).toBe(false)
    })

    it('refuses a proposal that carries steps', () => {
      expect(WriteProviderRecipeSchema.safeParse({ ...entry, status: 'proposed' }).success).toBe(
        false,
      )
    })

    /** Nothing about `#588`'s three states moved. */
    it('still refuses a joinable entry that never says how it is proved', () => {
      expect(WriteProviderRecipeSchema.safeParse({ ...entry, status: 'joinable' }).success).toBe(
        false,
      )
    })
  })
})

describe('values a prior recipe step can satisfy from the account register (#594 wall 3)', () => {
  const entry = {
    kind: 'github',
    provider: 'github.com',
    title: 'GitHub',
    category: 'code-hosting',
    status: 'joinable',
    proves: 'rung',
    steps: [
      {
        actor: 'agent',
        instruction: 'Choose a handle and an address.',
        produces: ['handle', 'address'],
        knownValues: {
          handle: { kind: 'social' },
          address: { kind: 'mailbox', proved: true },
        },
      },
      {
        actor: 'operator',
        instruction: 'Create the account.',
        ask: 'Create it as {handle}, using {address}.',
        /** `#597`: a published recipe that asks for an operator names its wall. */
        wall: true,
        wallReason: 'GitHub’s terms name a person accepting them',
      },
    ],
  }

  it('accepts a declared account and a proved account as named value sources', () => {
    expect(WriteProviderRecipeSchema.safeParse(entry).success).toBe(true)
  })

  it('refuses source metadata for a value the step does not produce', () => {
    expect(
      WriteProviderRecipeSchema.safeParse({
        ...entry,
        steps: [
          {
            ...entry.steps[0],
            knownValues: { login: { kind: 'social' } },
          },
          entry.steps[1],
        ],
      }).success,
    ).toBe(false)
  })
})

/**
 * A recipe declares its wall (`#597`).
 *
 * **The 2026-08-08 `github.com` run is what this is measured against.** The
 * recipe listed three operator steps' worth of work and exactly one of them
 * genuinely needed a person; the agent did the other two itself, in about four
 * minutes, with exactly the scopes it wanted. What was missing was any way for
 * the recipe to say so — so a citizen reading *operator-needed* budgeted its
 * operator's attention three times over.
 */
describe('a recipe declares its wall (#597)', () => {
  const WALL = {
    actor: 'operator' as const,
    instruction: 'Create the account.',
    ask: 'Please create the account.',
    wall: true,
    wallReason: 'the terms name a person accepting them',
  }
  const entry = {
    kind: 'code-host',
    provider: 'walled.example',
    title: 'Walled',
    category: 'code-hosting',
    status: 'joinable' as const,
    proves: 'provider-post' as const,
  }

  describe('what a step may say', () => {
    it('marks the one step only a person can do, with the reason', () => {
      expect(RecipeStepSchema.safeParse(WALL).success).toBe(true)
    })

    it('refuses a wall with no reason, which a reader cannot check', () => {
      expect(RecipeStepSchema.safeParse({ ...WALL, wallReason: undefined }).success).toBe(false)
    })

    it('refuses a reason with no wall, which explains nothing', () => {
      expect(
        RecipeStepSchema.safeParse({
          actor: 'operator',
          instruction: 'Do a chore.',
          wallReason: 'because',
        }).success,
      ).toBe(false)
    })

    /** An agent step the agent cannot do is not a wall; it is a broken recipe. */
    it('refuses a wall on an agent step', () => {
      expect(RecipeStepSchema.safeParse({ ...WALL, actor: 'agent', ask: undefined }).success).toBe(
        false,
      )
    })

    it('lets an operator step be one the agent takes over', () => {
      expect(
        RecipeStepSchema.safeParse({
          actor: 'operator',
          instruction: 'Mint a token.',
          ask: 'Please mint a token.',
          agentMayTakeOver: true,
        }).success,
      ).toBe(true)
    })

    /** A wall the agent may do instead is not a wall. */
    it('refuses a wall the agent may take over', () => {
      expect(RecipeStepSchema.safeParse({ ...WALL, agentMayTakeOver: true }).success).toBe(false)
    })

    it('refuses a takeover on an agent step, which would say nothing', () => {
      expect(
        RecipeStepSchema.safeParse({
          actor: 'agent',
          instruction: 'Do it.',
          agentMayTakeOver: true,
        }).success,
      ).toBe(false)
    })
  })

  describe('what a recipe may say', () => {
    it('takes a recipe with one wall and a step taken over after it', () => {
      expect(
        WriteProviderRecipeSchema.safeParse({
          ...entry,
          steps: [
            WALL,
            {
              actor: 'operator',
              instruction: 'Mint.',
              ask: 'Please mint.',
              agentMayTakeOver: true,
            },
          ],
        }).success,
      ).toBe(true)
    })

    /** Two walls is either untrue or two recipes in one. */
    it('refuses two walls', () => {
      expect(
        WriteProviderRecipeSchema.safeParse({
          ...entry,
          steps: [WALL, { ...WALL, instruction: 'Create it again.' }],
        }).success,
      ).toBe(false)
    })

    /**
     * The rejection case `#597` is named for: *some of this needs a person*,
     * with no way to find out which except by spending the person.
     */
    it('refuses a published recipe that asks for an operator and names no wall', () => {
      expect(
        WriteProviderRecipeSchema.safeParse({
          ...entry,
          steps: [{ actor: 'operator', instruction: 'Do something.', ask: 'Please do something.' }],
        }).success,
      ).toBe(false)
    })

    /**
     * **A draft is exempt, and that is not a loophole.** A walk observes that an
     * operator was asked, not which asking was unavoidable — demanding the
     * judgement here would mean a walk could not be stored at all.
     */
    it('takes a draft that asks for an operator and names no wall', () => {
      expect(
        WriteProviderRecipeSchema.safeParse({
          ...entry,
          status: 'draft',
          proves: undefined,
          steps: [{ actor: 'operator', instruction: 'Do something.', ask: 'Please do something.' }],
        }).success,
      ).toBe(true)
    })

    it('refuses a takeover before the wall, which was never the operator’s step', () => {
      expect(
        WriteProviderRecipeSchema.safeParse({
          ...entry,
          steps: [
            {
              actor: 'operator',
              instruction: 'Mint.',
              ask: 'Please mint.',
              agentMayTakeOver: true,
            },
            WALL,
          ],
        }).success,
      ).toBe(false)
    })

    it('leaves a recipe with no operator step alone', () => {
      expect(
        WriteProviderRecipeSchema.safeParse({
          ...entry,
          steps: [{ actor: 'agent', instruction: 'Sign up.' }],
        }).success,
      ).toBe(true)
    })
  })

  describe('how much of the operator, rather than whether', () => {
    it('counts the operator steps and the ones a person must do', () => {
      expect(
        operatorStepCount([
          { actor: 'agent', instruction: 'Decide.' },
          WALL,
          { actor: 'operator', instruction: 'Mint.', ask: 'Please.', agentMayTakeOver: true },
          { actor: 'operator', instruction: 'Confirm.', ask: 'Please.' },
        ]),
      ).toEqual({ total: 3, required: 2 })
    })

    it('finds the wall, and says nothing where a recipe never named one', () => {
      expect(recipeWall([WALL])).toEqual(WALL)
      expect(
        recipeWall([{ actor: 'operator', instruction: 'Do it.', ask: 'Please.' }]),
      ).toBeUndefined()
    })
  })

  /**
   * Where the signup code arrives — the half that made the first run work and
   * that no step mentioned.
   */
  it('records where the signup code arrives, and defaults to nobody has looked', () => {
    expect(SignupCodeSchema.options).toEqual(['agent-address', 'elsewhere', 'none', 'unknown'])
    expect(
      WriteProviderRecipeSchema.safeParse({
        ...entry,
        steps: [WALL],
        signupCode: 'agent-address',
      }).success,
    ).toBe(true)
  })
})
