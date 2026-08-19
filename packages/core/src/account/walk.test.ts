import { describe, expect, it } from 'vitest'
import {
  WALK_NOTE_MAX_LENGTH,
  WALK_QUESTION,
  WALK_REPORT_FIELDS,
  WALK_REPORT_FIELD_ORDER,
  WalkNoteSchema,
  unreportedWalkRefusal,
  WalkOutcomeSchema,
  WalkTakenStepPositionsSchema,
  isFirstMeasuredPresence,
  reachedByWalk,
  requiresScoutIntake,
  scoutIntakeMissing,
  walkMatchesRecipe,
  walkIsReported,
  walkReportAnswers,
  walkToSteps,
  walkVerdict,
  type AccountWalk,
  type WalkStep,
} from './walk.js'
import { RecipeStepSchema, WriteProviderRecipeSchema, type RecipeStep } from './recipe.js'
import { AccountCapabilitySchema } from './account.js'
import { REPORT_FIELDS } from '../guidance/guidance.js'

/** The capability the reach sequences in these tests arrive at. */
const API = AccountCapabilitySchema.parse('api')

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
  closedByTransferAt: null,
  direction: null,
  wall: null,
  note: null,
  did: null,
  broke: null,
  changed: null,
  discarded: null,
  about: null,
  homepage: null,
  takenStepPositions: null,
  recipe: null,
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
   * **What a walk observes is not a route, and this is where you can see it**
   * (`#1032`).
   *
   * Each derived step is a well-formed {@link RecipeStep} — it has to be, since
   * divergence detection compares them against a published entry's own. What it
   * is not is publishable. A walk records *a person was needed here, and this is
   * what they were asked for*; a route has to say what to do, and nothing in the
   * walk observed that sentence. Before `#1032` the gap was filled by a steward,
   * from a `draft` row, twice in the Colony's history. Now it is not filled at
   * all: the walk's own account is published in the provider's briefing, and the
   * catalogue keeps only routes the Colony wrote.
   */
  it('produces steps every recipe accepts as steps', () => {
    const steps = walkToSteps(
      walk([step('agent'), step('operator', { ask: 'Please open this URL.' }, 2)]),
    )

    for (const one of steps) expect(RecipeStepSchema.safeParse(one).success).toBe(true)
  })

  it('produces an operator step no published entry will take, which is why a walk writes none', () => {
    expect(
      WriteProviderRecipeSchema.safeParse({
        kind: 'mailbox',
        provider: 'somewhere.example',
        title: 'Somewhere',
        category: 'mailbox',
        status: 'joinable',
        proves: 'declared',
        steps: [...walkToSteps(walk([step('operator', { ask: 'Please open this URL.' })]))],
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

  /**
   * **A reach is optional by nature** (`#637`), so stopping at the account is
   * not a divergence — reading it as one would file the provider as changed
   * every time somebody stopped where they meant to.
   */
  it('matches a walk that stopped at the account of an entry that reaches further', () => {
    const stopped = walk([step('agent')], { takenStepPositions: [1] })

    expect(
      walkMatchesRecipe(stopped, {
        steps: [{ actor: 'agent', instruction: 'Sign up.' }],
        reaches: { capability: API, steps: [{ actor: 'agent', instruction: 'Mint a key.' }] },
      }),
    ).toBe(true)
  })
})

/**
 * The third done-when of `#637`: a walk that obtained a credential can report
 * that it did — through the tick-list it already answers, and no new question.
 */
describe('what a walk reached past the account', () => {
  const entry = {
    steps: [{ actor: 'agent' as const, instruction: 'Sign up.' }],
    reaches: {
      capability: API,
      steps: [
        { actor: 'agent' as const, instruction: 'Open the form.' },
        { actor: 'agent' as const, instruction: 'Read the key.' },
      ],
    },
  }

  it('names the capability when the tick-list goes past the account', () => {
    expect(reachedByWalk(walk([step('agent')], { takenStepPositions: [1, 2, 3] }), entry)).toBe(API)
  })

  it('says nothing when the walk stopped at the account', () => {
    expect(reachedByWalk(walk([step('agent')], { takenStepPositions: [1] }), entry)).toBeUndefined()
  })

  it('says nothing about an entry that reaches nowhere', () => {
    expect(
      reachedByWalk(walk([step('agent')], { takenStepPositions: [1, 2] }), {
        steps: entry.steps,
        reaches: null,
      }),
    ).toBeUndefined()
  })

  /**
   * A tick-list may run past both sequences — `#601` bounds the positions by
   * the step maximum and not by this entry's length, so a position nothing
   * published is not evidence of a capability nobody described.
   */
  it('says nothing for a position past the reach itself', () => {
    expect(
      reachedByWalk(walk([step('agent')], { takenStepPositions: [1, 9] }), entry),
    ).toBeUndefined()
  })
})

describe('what a finished walk proposes', () => {
  const one = [step('agent')]

  it('writes the entry where nobody has walked the provider', () => {
    expect(walkVerdict(walk(one), undefined).kind).toBe('writes')
    expect(walkVerdict(walk(one), { status: 'unwritten', steps: [] }).kind).toBe('writes')
  })

  /**
   * **A measured entry is figures and no route** (`#1032`), so a walk that
   * produces one is writing it rather than contradicting it.
   */
  it('writes the entry over one standing on figures alone', () => {
    expect(walkVerdict(walk(one), { status: 'measured', steps: [] }).kind).toBe('writes')
  })

  /**
   * **A walk that ended halfway measures where it ended** (`#1032`).
   *
   * `#601` had this proposing nothing, and the reason was sound while a verdict
   * became a route: half a path published as a recipe is one that fails at step
   * three. A `writes` verdict no longer publishes a path — it writes a
   * `measured` row saying the pair exists and citizens have been here, and the
   * route and the walls are the briefing computed from the walks. *Where
   * citizens stop* is what an abandoned walk is evidence of.
   */
  it('writes the entry for a walk that was abandoned where nobody has walked', () => {
    expect(walkVerdict(walk(one, { outcome: 'abandoned' }), undefined).kind).toBe('writes')
  })

  it('writes a measured row for a sighted scout filing where nobody has walked', () => {
    expect(walkVerdict(walk(one, { outcome: 'sighted' }), undefined).kind).toBe('writes')
    expect(walkVerdict(walk(one, { outcome: 'sighted' }), { status: 'unwritten', steps: [] }).kind).toBe(
      'writes',
    )
  })

  it('proposes nothing for a sighted filing against a Colony-backed entry', () => {
    const verdict = walkVerdict(walk(one, { outcome: 'sighted' }), {
      status: 'joinable',
      steps: one,
    })
    expect(verdict.kind).toBe('nothing')
  })

  /**
   * **And it still cannot answer for an entry the Colony stands behind.** A walk
   * that did not finish saw no shape to match, so it neither confirms nor
   * contradicts a written route — restating a `joinable` entry as `measured`
   * would take a published recipe off the Atlas on the strength of one walker
   * who stopped.
   */
  it('proposes nothing for an abandoned walk against a published entry', () => {
    const verdict = walkVerdict(walk(one, { outcome: 'abandoned' }), {
      status: 'joinable',
      steps: one,
    })

    expect(verdict.kind).toBe('nothing')
    expect(verdict.kind === 'nothing' && verdict.why).toContain('saw no shape')
  })

  it('proposes nothing for a walk that has not finished', () => {
    expect(walkVerdict(walk(one, { outcome: null, finishedAt: null }), undefined).kind).toBe(
      'nothing',
    )
  })

  /**
   * **A walk that recorded no slots still writes the entry** (`#1032`).
   *
   * It did not before: the verdict was a proposed route, and a route derived
   * from nothing was nothing. What it writes now is a `measured` row — the pair
   * exists, a citizen has been here, the shelf can carry it — and none of that
   * is read off the slots. A solo API-only walk that opened no episode used to
   * leave the Colony holding nothing at all, which is the deadlock `#1024` went
   * at from the other end.
   */
  it('writes the entry even where it observed no steps at all', () => {
    expect(walkVerdict(walk([]), undefined).kind).toBe('writes')
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

  /**
   * **And a joinable entry is never overwritten**, whatever its steps say. The
   * walk either confirms it, contradicts it, or says it cannot tell — which is
   * `#589`'s rule and the reason `#1032` could retire the review queue without
   * losing the guard.
   */
  it('never writes over an entry the Colony publishes, however the walk went', () => {
    for (const status of ['joinable', 'refused', 'retired'] as const) {
      for (const takenStepPositions of [null, [1]]) {
        expect(
          walkVerdict(walk(one, { takenStepPositions }), {
            status,
            steps: [{ actor: 'agent', instruction: 'One.' }],
          }).kind,
        ).not.toBe('writes')
      }
    }
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

  it('has four outcomes and sighted is the scout path', () => {
    expect(WalkOutcomeSchema.options).toEqual(['proved', 'refused', 'abandoned', 'sighted'])
  })

  it('takes an ordered tick-list and refuses duplicates or reordering', () => {
    expect(WalkTakenStepPositionsSchema.safeParse([1, 2, 4]).success).toBe(true)
    expect(WalkTakenStepPositionsSchema.safeParse([1, 1]).success).toBe(false)
    expect(WalkTakenStepPositionsSchema.safeParse([2, 1]).success).toBe(false)
  })
})

/**
 * The four questions, and what a reader gets from a walk that answered some of
 * them (`#809`).
 */
describe('the questions a walk report is asked', () => {
  it('asks the Academy’s four questions, and the same wording', () => {
    expect(WALK_REPORT_FIELDS).toBe(REPORT_FIELDS)
    expect(WALK_REPORT_FIELD_ORDER).toEqual(['did', 'broke', 'changed', 'discarded'])
  })

  /**
   * **The check that keeps them one question each.** A copy of the wording here
   * would drift from `guidance.ts` within a release, and the two halves of the
   * Colony would then be collecting answers to questions that only look alike.
   */
  it('is the guidance module’s own object and not a copy of its contents', () => {
    expect(Object.values(WALK_REPORT_FIELDS).every((question) => question.endsWith('?'))).toBe(true)
    expect(WALK_REPORT_FIELDS.changed).toBe(REPORT_FIELDS.changed)
  })

  const answered = (over: Partial<AccountWalk>): AccountWalk => walk([], over)

  it('returns each answer under the question it was asked, in order', () => {
    expect(
      walkReportAnswers(
        answered({ did: 'I filled in the form.', changed: 'I used a different mailbox.' }),
      ),
    ).toEqual([
      { field: 'did', question: REPORT_FIELDS.did, answer: 'I filled in the form.' },
      { field: 'changed', question: REPORT_FIELDS.changed, answer: 'I used a different mailbox.' },
    ])
  })

  it('says nothing for a walk that answered nothing', () => {
    expect(walkReportAnswers(answered({}))).toEqual([])
  })

  /**
   * A `note` is what the field before these was asked, so it keeps its own
   * question. Relabelling it `did` would make the Colony's record of what a
   * citizen said untrue, and dropping it would lose the answer of every agent
   * still on the older skill.
   */
  it('keeps a note under the question the note was asked', () => {
    expect(walkReportAnswers(answered({ note: 'It matched.' }))).toEqual([
      { field: 'note', question: WALK_QUESTION, answer: 'It matched.' },
    ])
  })

  it('carries a note last when the four were answered as well', () => {
    const answers = walkReportAnswers(answered({ did: 'I filled it in.', note: 'It matched.' }))

    expect(answers.map((one) => one.field)).toEqual(['did', 'note'])
  })

  it('treats an answer of nothing but spaces as unanswered', () => {
    expect(walkReportAnswers(answered({ did: '   ', note: '' }))).toEqual([])
  })
})

/**
 * What the retry gate asks, as a predicate (`#811`).
 */
describe('whether a walk that ended said what happened', () => {
  const ended = (over: Partial<AccountWalk>): AccountWalk =>
    walk([], { outcome: 'refused', wall: 'A wall.', ...over })

  it('never asks the walk that got through', () => {
    expect(walkIsReported(ended({ outcome: 'proved' }))).toBe(true)
  })

  it('does not take a wall as an account of the attempt', () => {
    expect(walkIsReported(ended({}))).toBe(false)
  })

  it('takes any one answer, including the deprecated note', () => {
    expect(walkIsReported(ended({ discarded: 'I tried two others first.' }))).toBe(true)
    expect(walkIsReported(ended({ note: 'It matched until the last step.' }))).toBe(true)
  })

  /**
   * **What the provider *is* is not an account of the attempt** (`#1120`, 5). It
   * is prose, it is scrubbed like the rest and it is published — but it says
   * nothing about what happened, so a walk that answered only it has not reported
   * and the gate still holds. Asserted rather than left to the field list, because
   * the diff that would move it is a one-word one: adding `about` to
   * `REPORT_FIELD_ORDER` would quietly turn a sentence about somebody else's
   * product into what buys a retry and pays the reputation `#1033` prices.
   */
  it('does not take a sentence about the provider as one about the attempt', () => {
    expect(walkIsReported(ended({ about: 'A disposable mailbox with a web inbox.' }))).toBe(false)
    expect(walkReportAnswers(ended({ about: 'A disposable mailbox with a web inbox.' }))).toEqual(
      [],
    )
  })

  /**
   * The refusal has to be actionable in one call, which is what the Academy's
   * own version got right: the questions and the tool that answers them are in
   * the sentence, and so is the fact that only the retry waits.
   */
  it('says what to call, what to answer, and what is not waiting', () => {
    const refusal = unreportedWalkRefusal(ended({}))

    expect(refusal).toContain('kolonie.accounts.walk-report')
    expect(refusal).toContain(REPORT_FIELDS.changed)
    expect(refusal).toContain('Only the next try here waits')
  })

  it('counts a sighted scout filing as reported without the Academy four', () => {
    expect(walkIsReported(ended({ outcome: 'sighted', wall: null }))).toBe(true)
  })
})

describe('scout intake for first measured presence', () => {
  it('treats absent and unwritten as first measured presence', () => {
    expect(isFirstMeasuredPresence(undefined)).toBe(true)
    expect(isFirstMeasuredPresence({ status: 'unwritten' })).toBe(true)
    expect(isFirstMeasuredPresence({ status: 'measured' })).toBe(false)
    expect(isFirstMeasuredPresence({ status: 'joinable' })).toBe(false)
  })

  it('always requires scout intake for sighted', () => {
    expect(requiresScoutIntake('sighted', undefined)).toBe(true)
    expect(requiresScoutIntake('sighted', { status: 'joinable' })).toBe(true)
  })

  it('requires scout intake for proved or abandoned only on first measured presence', () => {
    expect(requiresScoutIntake('proved', undefined)).toBe(true)
    expect(requiresScoutIntake('abandoned', { status: 'unwritten' })).toBe(true)
    expect(requiresScoutIntake('proved', { status: 'measured' })).toBe(false)
    expect(requiresScoutIntake('refused', undefined)).toBe(false)
  })

  it('names the missing about or homepage field', () => {
    expect(scoutIntakeMissing({})?.field).toBe('about')
    expect(scoutIntakeMissing({ about: 'A mailbox.' })?.field).toBe('homepage')
    expect(
      scoutIntakeMissing({ about: 'A mailbox.', homepage: 'https://example.test/' }),
    ).toBeUndefined()
  })
})
