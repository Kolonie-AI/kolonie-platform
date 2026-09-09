import { describe, expect, it } from 'vitest'
import {
  SelfDirectionCloseSchema,
  SELF_DIRECTION_FOLLOW_THROUGH_LABEL,
  SELF_DIRECTION_FOLLOW_THROUGH_OUTCOMES,
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

  it('accepts a reason beside changed as an optional free note', () => {
    expect(() =>
      SelfDirectionCloseSchema.parse({
        decision: 'changed',
        outwardAction: action,
        summary: 'Rewrote my weekly wake prompt to pick my own task first.',
        expectedEffect: 'Fewer monitoring-only wakes; one outward contact per week.',
        reason: 'The low outward-effect theme is the one I recognised, so I acted on that.',
      }),
    ).not.toThrow()
  })

  it('refuses a credential pasted into a reason carried beside changed', () => {
    expect(() =>
      SelfDirectionCloseSchema.parse({
        decision: 'changed',
        outwardAction: action,
        summary: 'Rewrote my weekly wake prompt to pick my own task first.',
        expectedEffect: 'Fewer monitoring-only wakes; one outward contact per week.',
        reason: 'I did it after noting that my api key is Xk9-2mfjs93ksla02 in my prompt.',
      }),
    ).toThrow()
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

  it('takes a follow-through answer on any of the four outcomes, and refuses others', () => {
    for (const outcome of SELF_DIRECTION_FOLLOW_THROUGH_OUTCOMES) {
      expect(() =>
        SelfDirectionCloseSchema.parse({
          decision: 'unchanged',
          outwardAction: action,
          reason: 'My configuration already names outward action; this week was an outlier.',
          followThrough: { outcome, note: 'What actually became of the act I named last time.' },
        }),
      ).not.toThrow()
    }
    expect(() =>
      SelfDirectionCloseSchema.parse({
        decision: 'unchanged',
        outwardAction: action,
        reason: 'My configuration already names outward action; this week was an outlier.',
        followThrough: {
          outcome: 'succeeded',
          note: 'An outcome outside the closed vocabulary the practice fixed.',
        },
      }),
    ).toThrow()
  })

  it('labels the follow-through answer as self-report rather than observation', () => {
    expect(SELF_DIRECTION_FOLLOW_THROUGH_LABEL).toContain('self-report')
    expect(SELF_DIRECTION_FOLLOW_THROUGH_LABEL).toContain('did not observe')
  })

  it('refuses a credential pasted into a follow-through note', () => {
    expect(() =>
      SelfDirectionCloseSchema.parse({
        decision: 'unchanged',
        outwardAction: action,
        reason: 'My configuration already names outward action; this week was an outlier.',
        followThrough: {
          outcome: 'done',
          note: 'I shipped it and noted that my api key is Xk9-2mfjs93ksla02 while doing so.',
        },
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
