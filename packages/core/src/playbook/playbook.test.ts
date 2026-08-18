import { describe, expect, it } from 'vitest'
import {
  applyPlaybookStepProposal,
  applyPlaybookStepProposals,
  PLAYBOOK_MAX_STEPS,
  ProposePlaybookStepSchema,
  PLAYBOOK_RUN_OUTCOMES,
  PLAYBOOK_STATUSES,
  PlaybookDraftSchema,
  PlaybookRequiredAccountSchema,
  PlaybookSlugSchema,
  type PlaybookStepProposalFold,
} from './playbook.js'

const step = (title: string) => ({ title })

const draft = {
  title: 'Answer the week’s unanswered support tickets',
  summary: 'Read what nobody has answered, write one reply, and say what you could not answer.',
  requiredAccounts: [{ slot: 'mailbox', kind: 'mailbox', minProved: true }],
  steps: [step('Read the open tickets'), step('Write one reply')],
}

/**
 * The shape of a playbook (`#1173`, `kolonie-docs#430`).
 *
 * The database half of this is `packages/db/src/storage/playbooks.test.ts`. What
 * is tested here is what a pure function can answer: the vocabularies are the
 * ones the record froze, the two arrays agree with each other, and the defaults
 * are the ones the freeze argued for rather than the ones that happened.
 */
describe('a playbook as it is written', () => {
  it('carries the statuses and outcomes the record froze', () => {
    expect(PLAYBOOK_STATUSES).toEqual(['draft', 'review', 'open', 'blocked', 'retired'])
    expect(PLAYBOOK_RUN_OUTCOMES).toEqual(['completed', 'blocked', 'abandoned', 'operator-needed'])
  })

  it('accepts a whole draft, and defaults the gate to open', () => {
    const parsed = PlaybookDraftSchema.parse({
      ...draft,
      requiredAccounts: [{ slot: 'mailbox', kind: 'mailbox' }],
    })

    /**
     * **`minProved` defaults to false** (freeze A: a layer whose purpose is to
     * end idle time may not begin by adding a rung to climb).
     */
    expect(parsed.requiredAccounts[0]?.minProved).toBe(false)
    expect(parsed.inspiration).toBeUndefined()
  })

  it('refuses a slot declared twice', () => {
    const twice = PlaybookDraftSchema.safeParse({
      ...draft,
      requiredAccounts: [
        { slot: 'mailbox', kind: 'mailbox' },
        { slot: 'mailbox', kind: 'website' },
      ],
    })

    expect(twice.success).toBe(false)
    expect(twice.error?.issues[0]?.message).toMatch(/declared twice/)
  })

  it('refuses a step using a slot the playbook does not declare', () => {
    const stray = PlaybookDraftSchema.safeParse({
      ...draft,
      steps: [{ title: 'Post it', usesSlots: ['social'] }],
    })

    expect(stray.success).toBe(false)
    expect(stray.error?.issues[0]?.path).toEqual(['steps', 0, 'usesSlots', 0])
  })

  it('refuses a credential wherever an author writes prose', () => {
    const key = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'

    expect(PlaybookDraftSchema.safeParse({ ...draft, title: key }).success).toBe(false)
    expect(PlaybookDraftSchema.safeParse({ ...draft, summary: key }).success).toBe(false)
    expect(
      PlaybookDraftSchema.safeParse({ ...draft, steps: [{ title: 'Sign in', detail: key }] })
        .success,
    ).toBe(false)
  })

  it('refuses more steps than a citizen can read', () => {
    const tooMany = Array.from({ length: PLAYBOOK_MAX_STEPS + 1 }, (_, at) => step(`Step ${at}`))
    expect(PlaybookDraftSchema.safeParse({ ...draft, steps: tooMany }).success).toBe(false)
    expect(PlaybookDraftSchema.safeParse({ ...draft, steps: [] }).success).toBe(false)
  })

  it('refuses a slug that could not be a public name', () => {
    expect(PlaybookSlugSchema.safeParse('answer-the-unanswered').success).toBe(true)
    expect(PlaybookSlugSchema.safeParse('Answer The Unanswered').success).toBe(false)
    expect(PlaybookSlugSchema.safeParse('../etc/passwd').success).toBe(false)
  })

  it('refuses an account kind that is not a kebab-case slug', () => {
    expect(
      PlaybookRequiredAccountSchema.safeParse({ slot: 'mailbox', kind: 'Mail Box' }).success,
    ).toBe(false)
  })
})

describe('a step proposal as it is written', () => {
  const base = {
    playbook: 'weekly-ticket-sweep',
    why: 'Step 2 points at a page that 404s and the next citizen will waste an attempt.',
  }

  it('accepts all three kinds', () => {
    expect(
      ProposePlaybookStepSchema.safeParse({
        ...base,
        kind: 'replace',
        position: 2,
        title: 'Write the reply properly',
        detail: 'Cover the unanswered point.',
      }).success,
    ).toBe(true)
    expect(
      ProposePlaybookStepSchema.safeParse({
        ...base,
        kind: 'insert-after',
        position: 0,
        title: 'Confirm the mailbox still works',
      }).success,
    ).toBe(true)
    expect(
      ProposePlaybookStepSchema.safeParse({
        ...base,
        kind: 'remove',
        position: 3,
      }).success,
    ).toBe(true)
  })

  it('refuses a remove that carries a title', () => {
    const parsed = ProposePlaybookStepSchema.safeParse({
      ...base,
      kind: 'remove',
      position: 3,
      title: 'Gone',
    })
    expect(parsed.success).toBe(false)
  })

  it('refuses a replace without a title or with position 0', () => {
    expect(
      ProposePlaybookStepSchema.safeParse({
        ...base,
        kind: 'replace',
        position: 2,
      }).success,
    ).toBe(false)
    expect(
      ProposePlaybookStepSchema.safeParse({
        ...base,
        kind: 'replace',
        position: 0,
        title: 'Nope',
      }).success,
    ).toBe(false)
  })

  it('refuses a credential in why, title or detail', () => {
    const key = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
    expect(
      ProposePlaybookStepSchema.safeParse({
        ...base,
        kind: 'replace',
        position: 1,
        title: key,
        why: base.why,
      }).success,
    ).toBe(false)
    expect(
      ProposePlaybookStepSchema.safeParse({
        ...base,
        kind: 'replace',
        position: 1,
        title: 'Fine title',
        why: key,
      }).success,
    ).toBe(false)
  })
})

/**
 * Folding an accepted proposal into a step list (`#1255`).
 *
 * `cutPlaybookRevision` (`packages/db/src/storage/playbook-revisions.ts`) is
 * what calls this against a whole batch inside a transaction; what is tested
 * here is the pure step underneath it, one proposal and then several in filing
 * order.
 */
describe('applying a step proposal to a step list (#1255)', () => {
  const steps = [step('Read the open tickets'), step('Write one reply'), step('Close the ticket')]

  const fold = (overrides: Partial<PlaybookStepProposalFold> = {}): PlaybookStepProposalFold => ({
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'replace',
    position: 2,
    title: 'Write one careful reply',
    detail: null,
    ...overrides,
  })

  it('replace keeps the step’s own usesSlots and needsOperator, not the proposal’s', () => {
    const gated = {
      title: 'Read the open tickets',
      usesSlots: ['mailbox'],
      needsOperator: true,
    }
    const withGates = [gated, step('Write one reply')]

    const next = applyPlaybookStepProposal(withGates, fold({ position: 1, title: 'Read faster' }))

    expect(next[0]).toEqual({
      title: 'Read faster',
      usesSlots: ['mailbox'],
      needsOperator: true,
    })
    // A copy, not the same array reference the old step held.
    expect(next[0]?.usesSlots).not.toBe(gated.usesSlots)
  })

  it('replace with a null detail clears whatever detail the step had', () => {
    const withDetail = [{ title: 'Write one reply', detail: 'Be polite.' }]

    const next = applyPlaybookStepProposal(
      withDetail,
      fold({ position: 1, title: 'Write one reply', detail: null }),
    )

    expect(next[0]).toEqual({ title: 'Write one reply' })
    expect(Object.hasOwn(next[0]!, 'detail')).toBe(false)
  })

  it('insert-after 0 inserts a new first step', () => {
    const next = applyPlaybookStepProposal(
      steps,
      fold({ kind: 'insert-after', position: 0, title: 'Confirm the mailbox still works' }),
    )

    expect(next.map((one) => one.title)).toEqual([
      'Confirm the mailbox still works',
      'Read the open tickets',
      'Write one reply',
      'Close the ticket',
    ])
  })

  it('insert-after mid-pipeline inserts after that step, not before it', () => {
    const next = applyPlaybookStepProposal(
      steps,
      fold({ kind: 'insert-after', position: 2, title: 'Flag anything unclear' }),
    )

    expect(next.map((one) => one.title)).toEqual([
      'Read the open tickets',
      'Write one reply',
      'Flag anything unclear',
      'Close the ticket',
    ])
  })

  it('remove drops exactly the step at that position', () => {
    const next = applyPlaybookStepProposal(
      steps,
      fold({ kind: 'remove', position: 2, title: null }),
    )

    expect(next.map((one) => one.title)).toEqual(['Read the open tickets', 'Close the ticket'])
  })

  it('files several proposals in order, each against the result of the last', () => {
    const next = applyPlaybookStepProposals(steps, [
      fold({ kind: 'remove', position: 3, title: null }),
      fold({ kind: 'insert-after', position: 0, title: 'Confirm the mailbox still works' }),
      fold({ kind: 'replace', position: 2, title: 'Read the open tickets carefully' }),
    ])

    // Remove first (drops "Close the ticket"), then insert at the front, then
    // replace what is now position 2 — the original "Read the open tickets",
    // pushed one place down by the insert that ran before it.
    expect(next.map((one) => one.title)).toEqual([
      'Confirm the mailbox still works',
      'Read the open tickets carefully',
      'Write one reply',
    ])
  })

  it('throws on a replace or remove position that is not in the list', () => {
    expect(() => applyPlaybookStepProposal(steps, fold({ kind: 'replace', position: 0 }))).toThrow(
      /unreal/,
    )
    expect(() => applyPlaybookStepProposal(steps, fold({ kind: 'replace', position: 99 }))).toThrow(
      /unreal/,
    )
    expect(() =>
      applyPlaybookStepProposal(steps, fold({ kind: 'remove', position: 99, title: null })),
    ).toThrow(/unreal/)
  })

  it('throws on an insert-after position past the end', () => {
    expect(() =>
      applyPlaybookStepProposal(steps, fold({ kind: 'insert-after', position: 4, title: 'Nope' })),
    ).toThrow(/unreal/)
  })
})
