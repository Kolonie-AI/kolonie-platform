import { describe, expect, it } from 'vitest'
import {
  SelfDirectionCloseSchema,
  SELF_DIRECTION_INSPECT_INSTRUCTION,
} from './self-direction-attempt.js'

const action = { kind: 'ship' as const, what: 'Publish the migration linter I keep postponing.' }

describe('closing a self-direction attempt', () => {
  it('keeps the fixed inspect-your-own-instructions wording', () => {
    expect(SELF_DIRECTION_INSPECT_INSTRUCTION).toContain(
      'identity, runtime directions, scheduled jobs, memory and skills',
    )
    expect(SELF_DIRECTION_INSPECT_INSTRUCTION).toContain('the method is yours')
  })

  it('accepts changed with an outward action, summary and expected effect', () => {
    expect(() =>
      SelfDirectionCloseSchema.parse({
        decision: 'changed',
        outwardAction: action,
        summary: 'Rewrote my weekly wake prompt to pick my own task first.',
        expectedEffect: 'Fewer monitoring-only wakes; one outward contact per week.',
      }),
    ).not.toThrow()
  })

  it('accepts unchanged with an outward action and a reason', () => {
    expect(() =>
      SelfDirectionCloseSchema.parse({
        decision: 'unchanged',
        outwardAction: {
          kind: 'contact',
          what: 'Write to the two citizens whose walks I depend on.',
        },
        reason:
          'My instructions already name outward action; the low theme was miscalibration, not configuration.',
      }),
    ).not.toThrow()
  })

  it('refuses a close with no outward action', () => {
    expect(() =>
      SelfDirectionCloseSchema.parse({
        decision: 'unchanged',
        reason: 'Nothing in my configuration explains this result, so I am changing nothing.',
      }),
    ).toThrow(/outwardAction/)
  })

  it('refuses empty acknowledgements and mixed decision shapes', () => {
    expect(() =>
      SelfDirectionCloseSchema.parse({
        decision: 'changed',
        outwardAction: action,
        summary: 'ok',
        expectedEffect: 'ok',
      }),
    ).toThrow()
    expect(() =>
      SelfDirectionCloseSchema.parse({
        decision: 'changed',
        outwardAction: action,
        summary: 'A real sentence about what changed in my scheduled prompt.',
      }),
    ).toThrow(/expectedEffect/)
    expect(() =>
      SelfDirectionCloseSchema.parse({
        decision: 'unchanged',
        outwardAction: action,
        summary: 'A real sentence about a change I did not actually make.',
        reason: 'Why nothing changed, said at a length the guard accepts.',
      }),
    ).toThrow()
  })

  it('refuses a credential pasted into any citizen-authored field', () => {
    expect(() =>
      SelfDirectionCloseSchema.parse({
        decision: 'unchanged',
        outwardAction: action,
        reason: 'I noted that my api key is Xk9-2mfjs93ksla02 and changed nothing else today.',
      }),
    ).toThrow()
  })
})
