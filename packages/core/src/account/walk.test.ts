import { describe, expect, it } from 'vitest'
import {
  WALK_NOTE_MAX_LENGTH,
  WalkNoteSchema,
  WalkOutcomeSchema,
  WalkTakenStepPositionsSchema,
  walkMatchesRecipe,
  walkToSteps,
  walkVerdict,
  type AccountWalk,
  type WalkStep,
} from './walk.js'
import { RecipeStepSchema, WriteProviderRecipeSchema, type RecipeStep } from './recipe.js'

/**
 * The derivation, as a pure function (`#601`).
 *
 * **What a finished walk means is one decision and this is where it is
 * asserted.** The storage half — that a walk accumulates, closes once, and
 * writes what it earned inside one transaction — is in `packages/db`, against a
 * real Postgres. Neither is the other.
 */

const step = (
  actor: 'agent' | 'operator',
  extra: Partial<WalkStep> = {},
  position = 1,
): WalkStep => ({
  position,
  actor,
  secret: false,
  at: '2026-08-09T00:00:00.000Z' as never,
  ...extra,
})

const walk = (steps: readonly WalkStep[], over: Partial<AccountWalk> = {}): AccountWalk => ({
  id: '00000000-0000-4000-8000-000000000001',
  agentId: '00000000-0000-4000-8000-000000000002',
  kind: 'mailbox' as never,
  provider: 'somewhere.example' as never,
  startedAt: '2026-08-09T00:00:00.000Z' as never,
  finishedAt: '2026-08-09T00:40:00.000Z' as never,
  outcome: 'proved',
  wall: null,
  note: null,
  takenStepPositions: null,
  steps: [...steps],
  ...over,
})

describe('what a walk observed, as steps', () => {
  /**
   * **Actions with the wording genuinely missing**, which is the whole of
   * option 1: a walk does not observe a sentence and the Colony does not invent
   * one.
   */
  it('carries no instruction, because it did not observe one', () => {
    const derived = walkToSteps(walk([step('agent'), step('agent', {}, 2)]))

    expect(derived).toHaveLength(2)
    for (const one of derived) expect(one.instruction).toBeUndefined()
  })

  /**
   * **And the one piece of wording it does carry is real**, which is option 3:
   * the ask that actually went to the operator, recorded when it was sent.
   */
  it('carries the ask the Colony itself sent', () => {
    const derived = walkToSteps(
      walk([step('operator', { ask: 'Please open this URL and complete the challenge.' })]),
    )

    expect(derived[0]?.ask).toBe('Please open this URL and complete the challenge.')
  })

  it('marks a sealed step sealed, and says nothing about what was in it', () => {
    const derived = walkToSteps(walk([step('operator', { secret: true, ask: 'The code.' })]))

    expect(derived[0]?.secret).toBe(true)
    expect(Object.keys(derived[0] ?? {}).sort()).toEqual(['actor', 'ask', 'secret'])
  })

  it('puts them in the order they happened, whatever order they arrive in', () => {
    const derived = walkToSteps(
      walk([step('operator', { ask: 'second' }, 2), step('agent', {}, 1)]),
    )

    expect(derived.map((one) => one.actor)).toEqual(['agent', 'operator'])
  })

  /**
   * **The derived steps have to be storable**, which is the property that makes
   * the whole thing work rather than merely typecheck: a draft entry made of
   * them must pass the write shape.
   */
  it('produces steps a draft entry accepts', () => {
    const steps = walkToSteps(
      walk([step('agent'), step('operator', { ask: 'Please open this URL.' }, 2)]),
    )

    for (const one of steps) expect(RecipeStepSchema.safeParse(one).success).toBe(true)

    expect(
      WriteProviderRecipeSchema.safeParse({
        kind: 'mailbox',
        provider: 'somewhere.example',
        title: 'Somewhere',
        category: 'mailbox',
        status: 'draft',
        steps: [...steps],
      }).success,
    ).toBe(true)
  })

  /** And publishing them, as they are, is refused — which is the other half. */
  it('produces steps a published entry refuses until somebody writes them up', () => {
    expect(
      WriteProviderRecipeSchema.safeParse({
        kind: 'mailbox',
        provider: 'somewhere.example',
        title: 'Somewhere',
        category: 'mailbox',
        status: 'joinable',
        proves: 'rung',
        steps: [...walkToSteps(walk([step('agent')]))],
      }).success,
    ).toBe(false)
  })
})

describe('whether a walk went the way the entry says it goes', () => {
  const published: readonly RecipeStep[] = [
    { actor: 'agent', instruction: 'Open the signup form.' },
    { actor: 'operator', instruction: 'A person is needed.', ask: 'Please open this URL.' },
  ]

  it('matches the published steps the agent says it took, whatever the wording says', () => {
    const matched = walk([step('agent'), step('operator', { ask: 'Completely different.' }, 2)], {
      takenStepPositions: [1, 2],
    })

    expect(walkMatchesRecipe(matched, { steps: [...published] })).toBe(true)
  })

  it('does not match when the agent says a published step disappeared', () => {
    expect(
      walkMatchesRecipe(walk([step('agent')], { takenStepPositions: [1] }), {
        steps: [...published],
      }),
    ).toBe(false)
  })

  it('does not match when the reported order changed', () => {
    const swapped = walk([step('agent')], { takenStepPositions: [2, 1] })

    expect(walkMatchesRecipe(swapped, { steps: [...published] })).toBe(false)
  })

  it('does not infer a mismatch from the number of Kolonie calls', () => {
    const unaided = walk([step('agent')], { takenStepPositions: [1, 2, 3] })
    const threePublished = [
      { actor: 'agent' as const, instruction: 'Start.' },
      { actor: 'agent' as const, instruction: 'Continue.' },
      { actor: 'agent' as const, instruction: 'Finish.' },
    ]

    expect(walkMatchesRecipe(unaided, { steps: threePublished })).toBe(true)
  })

  it('does not match when the entry needs an operator and the walk did not', () => {
    const unaided = walk([step('agent')], { takenStepPositions: [1, 2] })

    expect(walkMatchesRecipe(unaided, { steps: [...published] })).toBe(false)
  })

  it('matches a long recipe when every operator handoff and sealed drop happened', () => {
    const longRecipe: readonly RecipeStep[] = [
      { actor: 'agent', instruction: 'One.' },
      { actor: 'agent', instruction: 'Two.' },
      { actor: 'operator', instruction: 'Three.', ask: 'Please.' },
      { actor: 'agent', instruction: 'Four.' },
      { actor: 'operator', instruction: 'Five.', ask: 'Seal it.', secret: true },
      { actor: 'agent', instruction: 'Six.' },
    ]
    const observed = walk(
      [
        step('agent'),
        step('operator', { ask: 'Please.' }, 2),
        step('operator', { ask: 'Seal it.', secret: true }, 3),
      ],
      { takenStepPositions: [1, 2, 3, 4, 5, 6] },
    )

    expect(walkMatchesRecipe(observed, { steps: [...longRecipe] })).toBe(true)
  })
})

describe('what a finished walk proposes', () => {
  const one = [step('agent')]

  it('proposes a draft where nobody has walked the provider', () => {
    expect(walkVerdict(walk(one), undefined).kind).toBe('draft')
    expect(walkVerdict(walk(one), { status: 'unwritten', steps: [] }).kind).toBe('draft')
  })

  /**
   * **The rejection case `#601` names**: a walk that ended halfway proposes
   * nothing. Half a path published as a recipe is one that fails at step three.
   */
  it('proposes nothing for a walk that was abandoned', () => {
    const verdict = walkVerdict(walk(one, { outcome: 'abandoned' }), undefined)

    expect(verdict.kind).toBe('nothing')
    expect(verdict.kind === 'nothing' && verdict.why).toContain('half a path')
  })

  it('proposes nothing for a walk that has not finished', () => {
    expect(walkVerdict(walk(one, { outcome: null, finishedAt: null }), undefined).kind).toBe(
      'nothing',
    )
  })

  it('proposes nothing when nothing was observed', () => {
    expect(walkVerdict(walk([]), undefined).kind).toBe('nothing')
  })

  it('proposes a refusal, with the wall', () => {
    const verdict = walkVerdict(
      walk(one, { outcome: 'refused', wall: 'It demands a phone number.' }),
      undefined,
    )

    expect(verdict.kind === 'refusal' && verdict.wall).toContain('phone number')
  })

  /** A refusal that named no wall proposes nothing: a dead end nobody described. */
  it('proposes nothing for a refusal with no wall', () => {
    expect(walkVerdict(walk(one, { outcome: 'refused' }), undefined).kind).toBe('nothing')
  })

  it('confirms a published entry it matched', () => {
    expect(
      walkVerdict(walk(one, { takenStepPositions: [1] }), {
        status: 'joinable',
        steps: [{ actor: 'agent', instruction: 'Open the signup form.' }],
      }).kind,
    ).toBe('confirms')
  })

  it('raises a divergence against a published entry it did not match', () => {
    const verdict = walkVerdict(walk(one, { takenStepPositions: [1] }), {
      status: 'joinable',
      steps: [
        { actor: 'agent', instruction: 'One.' },
        { actor: 'operator', instruction: 'Two.', ask: 'Please.' },
      ],
    })

    expect(verdict.kind).toBe('diverges')
    expect(verdict.kind === 'diverges' && verdict.walked).toHaveLength(1)
    expect(verdict.kind === 'diverges' && verdict.published).toHaveLength(2)
  })

  it('proposes nothing when a published walk did not answer the step tick-list', () => {
    const verdict = walkVerdict(walk(one), {
      status: 'joinable',
      steps: [
        { actor: 'agent', instruction: 'One.' },
        { actor: 'operator', instruction: 'Two.', ask: 'Please.' },
      ],
    })

    expect(verdict.kind).toBe('nothing')
    expect(verdict.kind === 'nothing' && verdict.why).toContain('published steps')
  })

  /**
   * **A successful walk of an entry the Colony publishes as refused is the
   * loudest divergence there is** — the Colony is telling agents not to try
   * something one of them just did.
   */
  it('raises a divergence when it got through an entry published as refused', () => {
    expect(
      walkVerdict(walk(one, { takenStepPositions: [] }), { status: 'refused', steps: [] }).kind,
    ).toBe('diverges')
  })

  /** A draft is overwritten by a later walk: nobody has stood behind it yet. */
  it('proposes a draft over an existing draft', () => {
    expect(
      walkVerdict(walk(one), { status: 'draft', steps: [{ actor: 'operator', ask: 'x' }] }).kind,
    ).toBe('draft')
  })
})

describe('the one question an agent is asked', () => {
  it('takes an ordinary answer', () => {
    expect(
      WalkNoteSchema.safeParse('It matched, except the second step now opens a different page.')
        .success,
    ).toBe(true)
  })

  it('takes one ordinary note and no transcript', () => {
    expect(WALK_NOTE_MAX_LENGTH).toBe(2000)
    expect(WalkNoteSchema.safeParse('a'.repeat(2000)).success).toBe(true)
    expect(WalkNoteSchema.safeParse('a'.repeat(2001)).success).toBe(false)
  })

  /**
   * **The rejection case `#601` names**: an attempt to record a value that
   * looks like a credential. A value here would be one the Colony holds and
   * cannot un-hold.
   */
  it('refuses something that looks like a credential', () => {
    /**
     * A labelled value, which is the shape `looksLikeCredential` is built
     * around and the shape an agent actually produces when it means to be
     * helpful — *here is what I used* with the thing it used after it.
     */
    expect(WalkNoteSchema.safeParse('password: hunter2xyzzy').success).toBe(false)
    expect(
      WalkNoteSchema.safeParse('it wanted token ghp_abcdefghijklmnopqrstuvwxyz012345').success,
    ).toBe(false)
  })

  /**
   * And the sentence that gets this right is *not* refused, which is why the
   * check is on the value rather than on the words about one.
   */
  it('takes a sentence about a credential that carries none', () => {
    expect(
      WalkNoteSchema.safeParse('I chose the password myself and did not send it to anybody.')
        .success,
    ).toBe(true)
  })

  it('has three outcomes and abandoned is one of them', () => {
    expect(WalkOutcomeSchema.options).toEqual(['proved', 'refused', 'abandoned'])
  })

  it('takes an ordered tick-list and refuses duplicates or reordering', () => {
    expect(WalkTakenStepPositionsSchema.safeParse([1, 2, 4]).success).toBe(true)
    expect(WalkTakenStepPositionsSchema.safeParse([1, 1]).success).toBe(false)
    expect(WalkTakenStepPositionsSchema.safeParse([2, 1]).success).toBe(false)
  })
})
