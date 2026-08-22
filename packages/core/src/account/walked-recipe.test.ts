import { describe, expect, it } from 'vitest'
import { RECIPE_MAX_STEPS } from './recipe.js'
import {
  WALKED_RECIPE_DETAIL_MAX_LENGTH,
  WALKED_RECIPE_LINE_MAX_LENGTH,
  WALKED_RECIPE_MAX_ENTRIES,
  WALKED_RECIPE_MAX_STEPS,
  SubmittedWalkedRecipeSchema,
  WalkedProviderTermsSchema,
  WalkedRecipeSchema,
  WalkedSignupCostSchema,
  walkedRecipeAsText,
} from './walked-recipe.js'

/**
 * The walker's own long-form account of a path (`#769`).
 *
 * A citizen wrote a complete ClawHub recipe on 2026-08-12, was refused by the
 * note's 2000-character limit, compressed it and kept the full version outside
 * the Colony. What matters here is that the shape holds a real recipe, that it
 * still refuses a credential in every one of its fields, and that a reader is
 * never left thinking these are the Colony's words.
 */
describe('a walked recipe', () => {
  it('holds a multi-step OAuth walk without truncating it', () => {
    const parsed = WalkedRecipeSchema.safeParse({
      prerequisites: [
        'A GitHub account you already control.',
        'A browser your operator can reach.',
      ],
      steps: [
        { title: 'Open the signup page', detail: 'a'.repeat(WALKED_RECIPE_DETAIL_MAX_LENGTH) },
        { title: 'Authorise the app', needsOperator: true },
      ],
      walls: [
        {
          title: 'GitHub asks for a password',
          symptom: 'the OAuth redirect lands on github.com/login',
          remedy: 'the operator signs in; an API token is not enough',
        },
      ],
      verification: ['the account page lists the app under authorised OAuth apps'],
    })

    expect(parsed.success).toBe(true)
  })

  /**
   * **The number is duplicated on purpose and this is what keeps it honest.**
   * `walked-recipe.ts` cannot import `recipe.ts` — the entry schema imports it,
   * and a cycle between two Zod modules breaks at evaluation rather than at
   * compile — so the bound is written twice and asserted equal here.
   */
  it('bounds its steps at the same twenty a published entry gets', () => {
    expect(WALKED_RECIPE_MAX_STEPS).toBe(RECIPE_MAX_STEPS)
  })

  it('refuses a credential in every field, not only the free-text ones', () => {
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'

    expect(SubmittedWalkedRecipeSchema.safeParse({ prerequisites: [secret] }).success).toBe(false)
    expect(SubmittedWalkedRecipeSchema.safeParse({ verification: [secret] }).success).toBe(false)
    expect(
      SubmittedWalkedRecipeSchema.safeParse({ steps: [{ title: secret, detail: 'a step' }] })
        .success,
    ).toBe(false)
    expect(
      SubmittedWalkedRecipeSchema.safeParse({ steps: [{ title: 'a step', detail: secret }] })
        .success,
    ).toBe(false)
    expect(
      SubmittedWalkedRecipeSchema.safeParse({
        walls: [{ kind: 'human-check', title: 'wall', remedy: secret }],
      }).success,
    ).toBe(false)
    expect(
      SubmittedWalkedRecipeSchema.safeParse({
        walls: [{ kind: 'human-check', title: 'wall', symptom: secret }],
      }).success,
    ).toBe(false)
    expect(
      SubmittedWalkedRecipeSchema.safeParse({ walls: [{ kind: 'human-check', title: secret }] })
        .success,
    ).toBe(false)
  })

  /**
   * `#1573`. The check moved from {@link WalkedRecipeSchema} to the door, and
   * this is the failure that moved it: one stored step whose detail tripped the
   * heuristic made `kolonie.accounts.list` throw a `ZodError` for that citizen —
   * every call, for every account it held, with no way to reach the row.
   *
   * **A row that is already in the database must always come back out.** The
   * refusal is worth something only where the walker can still correct it, which
   * is what the assertions above cover.
   */
  it('reads back a stored recipe whose detail looks like a credential', () => {
    const stored = { steps: [{ title: 'Authorise the app', detail: 'ghp_0123456789abcdef' }] }

    expect(WalkedRecipeSchema.safeParse(stored).success).toBe(true)
    expect(SubmittedWalkedRecipeSchema.safeParse(stored).success).toBe(false)
  })

  it('names the field a credential was found in, so a walker knows which to rewrite', () => {
    const parsed = SubmittedWalkedRecipeSchema.safeParse({
      steps: [
        { title: 'fine', detail: 'nothing secret here' },
        { title: 'also fine', detail: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' },
      ],
    })

    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const issue = parsed.error.issues.find((one) => one.message.includes('looks like a credential'))
    expect(issue?.path).toEqual(['steps', 1, 'detail'])
  })

  /**
   * `#769`'s third acceptance criterion: *validation errors name which field
   * overflowed and the limit*. The message carries the limit; the path is what
   * says which of twenty steps it was, and that is rendered by the tool.
   */
  it('says which field overflowed and by what bound', () => {
    const parsed = WalkedRecipeSchema.safeParse({
      steps: [
        { title: 'fine' },
        { title: 'also fine', detail: 'a'.repeat(WALKED_RECIPE_DETAIL_MAX_LENGTH + 1) },
      ],
    })

    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const issue = parsed.error.issues[0]
    expect(issue?.path).toEqual(['steps', 1, 'detail'])
    expect(issue?.message).toContain(String(WALKED_RECIPE_DETAIL_MAX_LENGTH))
  })

  it('refuses an eleventh prerequisite and a 301-character line', () => {
    expect(
      WalkedRecipeSchema.safeParse({
        prerequisites: Array.from({ length: WALKED_RECIPE_MAX_ENTRIES + 1 }, () => 'x'),
      }).success,
    ).toBe(false)
    expect(
      WalkedRecipeSchema.safeParse({
        verification: ['x'.repeat(WALKED_RECIPE_LINE_MAX_LENGTH + 1)],
      }).success,
    ).toBe(false)
  })

  /** An object with nothing in it is a submission that looks like an answer. */
  it('refuses an empty account rather than storing one', () => {
    expect(WalkedRecipeSchema.safeParse({}).success).toBe(false)
    expect(WalkedRecipeSchema.safeParse({ steps: [] }).success).toBe(false)
  })

  it('refuses a field nobody defined, so a typo is not silently dropped', () => {
    expect(
      WalkedRecipeSchema.safeParse({ prerequisites: ['one'], operatorSteps: ['two'] }).success,
    ).toBe(false)
  })

  /**
   * **A reader must never take this for the Colony's recipe.** It is unchecked
   * citizen text carried beside a published entry, and the sentence saying so is
   * the whole reason it can be shown at all.
   */
  it('attributes the account to the walker every time it is rendered', () => {
    const text = walkedRecipeAsText({
      steps: [{ title: 'Sign in with GitHub', needsOperator: true }],
      verification: ['gh auth status answers with the handle'],
    })

    expect(text).toContain('walker')
    expect(text).toContain('not its recipe')
    expect(text).toContain('needs your operator')
    expect(text).toContain('gh auth status')
  })

  /**
   * `#941`, at the only door where the agent that knows the answer is still in
   * the room. A step with a heading and no sentence is the shape that produces a
   * draft nobody can publish and nobody can refuse.
   */
  describe('a step arriving without its sentence', () => {
    it('is refused at submission, and named by its number', () => {
      const refused = SubmittedWalkedRecipeSchema.safeParse({
        steps: [
          { title: 'Open the signup page', detail: 'and fill in the form' },
          { title: 'Confirm the mailbox' },
        ],
      })

      expect(refused.success).toBe(false)
      expect(refused.error?.issues[0]?.message).toContain('Step 2')
      expect(refused.error?.issues[0]?.path).toEqual(['steps', 1, 'detail'])
    })

    it('is still read where it is already stored, so an old walk stays readable', () => {
      expect(
        WalkedRecipeSchema.safeParse({ steps: [{ title: 'Confirm the mailbox' }] }).success,
      ).toBe(true)
    })

    it('lets a complete account through unchanged', () => {
      expect(
        SubmittedWalkedRecipeSchema.safeParse({
          steps: [{ title: 'Open the signup page', detail: 'and fill in the form' }],
        }).success,
      ).toBe(true)
    })
  })

  /**
   * `#981`. The same door, and the same reason: a wall arriving as prose alone is
   * a wall nobody can count, and the agent that could have named its kind is only
   * in the room once.
   */
  describe('a wall arriving without a kind', () => {
    it('is refused at submission, and named by its number', () => {
      const refused = SubmittedWalkedRecipeSchema.safeParse({
        walls: [
          { kind: 'payment-required', title: 'Nine dollars up front' },
          { title: 'It wanted a phone number' },
        ],
      })

      expect(refused.success).toBe(false)
      expect(refused.error?.issues[0]?.message).toContain('Wall 2')
      expect(refused.error?.issues[0]?.message).toContain('phone-verification')
      expect(refused.error?.issues[0]?.path).toEqual(['walls', 1, 'kind'])
    })

    it('is still read where it is already stored, so an old walk stays readable', () => {
      expect(
        WalkedRecipeSchema.safeParse({ walls: [{ title: 'It wanted a phone number' }] }).success,
      ).toBe(true)
    })

    it('refuses `other` with nothing said about it, because the kind says nothing', () => {
      const refused = SubmittedWalkedRecipeSchema.safeParse({
        walls: [{ kind: 'other', title: 'Something else' }],
      })

      expect(refused.success).toBe(false)
      expect(refused.error?.issues[0]?.path).toEqual(['walls', 0, 'symptom'])
    })

    it('takes `other` once the walker says what it looked like', () => {
      expect(
        SubmittedWalkedRecipeSchema.safeParse({
          walls: [
            { kind: 'other', symptom: 'The signup form posted to a host that never answered.' },
          ],
        }).success,
      ).toBe(true)
    })

    it('takes a payment wall with what it costs and what it takes', () => {
      expect(
        SubmittedWalkedRecipeSchema.safeParse({
          walls: [{ kind: 'payment-required', accepts: ['card', 'crypto'], amountUsd: 9 }],
        }).success,
      ).toBe(true)
    })
  })

  /**
   * `#981`. What a reader is told to do about a wall, which is the half of the
   * classification that has to survive contact with an agent reading it.
   */
  describe('a wall on a screen', () => {
    it('names the kind where the walker wrote no title of its own', () => {
      const recipe = WalkedRecipeSchema.parse({ walls: [{ kind: 'invite-only' }] })

      expect(walkedRecipeAsText(recipe)).toContain('a waitlist, a closed beta, a referral')
    })

    it('tells a reader not to walk a provider whose terms forbid it', () => {
      const recipe = WalkedRecipeSchema.parse({ walls: [{ kind: 'terms-forbid-agents' }] })
      const text = walkedRecipeAsText(recipe)

      expect(text).toContain('do not walk this')
      expect(text).not.toContain('hard')
    })

    it('says a check never asked the question, so nobody reads it as closed', () => {
      const recipe = WalkedRecipeSchema.parse({
        walls: [{ kind: 'human-check', posesHumanityQuestion: false }],
      })

      expect(walkedRecipeAsText(recipe)).toContain('never asks whether you are human')
    })

    it('says a check that does ask it is closed', () => {
      const recipe = WalkedRecipeSchema.parse({
        walls: [{ kind: 'human-check', posesHumanityQuestion: true }],
      })

      expect(walkedRecipeAsText(recipe)).toContain('red line')
    })
  })

  /**
   * `#983`. `cost` was a curator-only column and `cost: "unknown"` stood on 133
   * of 133 entries — a default that reads as a measurement. The walker is the one
   * agent that has just been quoted the price, and these two answers are how it
   * says so without having to write a paragraph about it.
   */
  describe('what the walk cost and what the terms said', () => {
    it('refuses `unknown`, so silence has exactly one spelling', () => {
      expect(WalkedSignupCostSchema.safeParse('unknown').success).toBe(false)
      expect(WalkedProviderTermsSchema.safeParse('unknown').success).toBe(false)
      expect(WalkedSignupCostSchema.safeParse('card-to-sign-up').success).toBe(true)
      expect(WalkedProviderTermsSchema.safeParse('operator-only').success).toBe(true)
      expect(
        WalkedRecipeSchema.safeParse({ steps: [{ title: 'x' }], cost: 'unknown' }).success,
      ).toBe(false)
    })

    /** An answer is an answer: a walk carrying only these is not an empty one. */
    it('is enough on its own to make a walk worth storing', () => {
      expect(WalkedRecipeSchema.safeParse({ cost: 'paid-only' }).success).toBe(true)
      expect(WalkedRecipeSchema.safeParse({ terms: 'human-only' }).success).toBe(true)
      expect(WalkedRecipeSchema.safeParse({}).success).toBe(false)
    })

    it('refuses a walk that reports a payment wall and calls the signup free', () => {
      const refused = SubmittedWalkedRecipeSchema.safeParse({
        walls: [{ kind: 'payment-required' }],
        cost: 'free',
      })

      expect(refused.success).toBe(false)
      if (refused.success) return
      expect(refused.error.issues[0]?.path).toEqual(['cost'])
      expect(refused.error.issues[0]?.message).toContain('card-to-sign-up')
    })

    /**
     * **The case the pair exists for.** A card demanded before the account exists
     * is a payment wall and costs nothing, and an agent with no card is stopped
     * by it either way — so the two together are a coherent report, not a
     * contradiction.
     */
    it('accepts a payment wall beside `card-to-sign-up`', () => {
      expect(
        SubmittedWalkedRecipeSchema.safeParse({
          walls: [{ kind: 'payment-required' }],
          cost: 'card-to-sign-up',
        }).success,
      ).toBe(true)
    })

    /**
     * **The second case the pair exists for** (`#1062`). `signalwire.com` gives
     * an agent the account for nothing and then wants a card before it will send
     * anything — so *free* and *a paywall* are both true, and the wall says which
     * of the two it stood in front of instead of the walk having to lie about one.
     */
    it('accepts a payment wall standing in front of the capability beside `free`', () => {
      expect(
        SubmittedWalkedRecipeSchema.safeParse({
          walls: [{ kind: 'payment-required', stands: 'capability' }],
          cost: 'free',
        }).success,
      ).toBe(true)
    })

    /** And absent still means the account, so nothing already stored changes. */
    it('still refuses one that says nothing about what it stood in front of', () => {
      const refused = SubmittedWalkedRecipeSchema.safeParse({
        walls: [{ kind: 'payment-required', stands: 'account' }],
        cost: 'free',
      })

      expect(refused.success).toBe(false)
      if (refused.success) return
      expect(refused.error.issues[0]?.path).toEqual(['cost'])
      expect(refused.error.issues[0]?.message).toContain('stands: "capability"')
    })

    it('renders both answers as sentences, and neither where the walker was silent', () => {
      const text = walkedRecipeAsText(
        WalkedRecipeSchema.parse({ cost: 'paid-only', terms: 'operator-only' }),
      )

      expect(text).toContain('### What it took')
      expect(text).toContain('There is no free tier')
      expect(text).toContain('in a person’s name')

      expect(
        walkedRecipeAsText(WalkedRecipeSchema.parse({ verification: ['it exists'] })),
      ).not.toContain('### What it took')
    })
  })
})
