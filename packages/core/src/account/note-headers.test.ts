import { describe, expect, it } from 'vitest'
import {
  OPERATOR_NEED_HEADER,
  OPERATOR_NEED_THREAD_HEADER,
  operatorNeedHeaders,
  readOperatorNeedHeaders,
} from './note-headers.js'

/**
 * The account-note headers (`#1602`).
 *
 * **The point of testing a string format is that both sides use this code.** A
 * convention written down in prose is one every implementer copies slightly
 * differently, and the situation this exists for is exactly two writers
 * disagreeing about which ask is live.
 *
 * A fake UUID throughout — `#1602` asks for that outright, and a live share id
 * in a test fixture is the sort of thing that outlives the test.
 */
const THREAD = '00000000-0000-4000-8000-000000000000'

describe('the operator-need headers on an account note', () => {
  it('writes both lines where there is a live ask', () => {
    expect(operatorNeedHeaders({ need: 'open', threadId: THREAD })).toBe(
      `${OPERATOR_NEED_HEADER}: open\n${OPERATOR_NEED_THREAD_HEADER}: ${THREAD}`,
    )
  })

  /**
   * `none` with a conversation id would be two statements that disagree —
   * *nothing is outstanding* and *this is the outstanding one*.
   */
  it('leaves the thread out when nothing is outstanding', () => {
    expect(operatorNeedHeaders({ need: 'none', threadId: THREAD })).toBe(
      `${OPERATOR_NEED_HEADER}: none`,
    )
  })

  it('writes the need alone when no thread was named', () => {
    expect(operatorNeedHeaders({ need: 'seen' })).toBe(`${OPERATOR_NEED_HEADER}: seen`)
  })

  it('reads back what it wrote', () => {
    const note = operatorNeedHeaders({ need: 'done', threadId: THREAD })

    expect(readOperatorNeedHeaders(note)).toEqual({ need: 'done', threadId: THREAD })
  })

  /**
   * The note is the citizen's own box and these are a convention inside it, so
   * the headers may sit anywhere in it with prose either side.
   */
  it('finds them among the citizen’s own words', () => {
    const note = [
      'intent: keep the Stripe rail open',
      `${OPERATOR_NEED_THREAD_HEADER}: ${THREAD}`,
      'last_action: asked, then waited',
      `${OPERATOR_NEED_HEADER}: seen`,
      'next: check again on the next tick',
    ].join('\n')

    expect(readOperatorNeedHeaders(note)).toEqual({ need: 'seen', threadId: THREAD })
  })

  it('says nothing about a note that carries no headers', () => {
    expect(readOperatorNeedHeaders('just a note to myself')).toEqual({})
    expect(readOperatorNeedHeaders(null)).toEqual({})
    expect(readOperatorNeedHeaders(undefined)).toEqual({})
  })

  /**
   * **A reader of somebody else's free text has no standing to refuse it.**
   * What it can do is not claim to have understood it — so a value outside the
   * five words is absent rather than an error, and the thread id beside it still
   * comes back.
   */
  it('ignores a need it does not recognise and keeps the rest', () => {
    const note = `${OPERATOR_NEED_HEADER}: nearly\n${OPERATOR_NEED_THREAD_HEADER}: ${THREAD}`

    expect(readOperatorNeedHeaders(note)).toEqual({ threadId: THREAD })
  })

  it('ignores an empty value', () => {
    expect(readOperatorNeedHeaders(`${OPERATOR_NEED_HEADER}:`)).toEqual({})
  })

  /** Two answers to one question: the first is read and the writer can notice. */
  it('takes the first where a header appears twice', () => {
    const note = `${OPERATOR_NEED_HEADER}: open\n${OPERATOR_NEED_HEADER}: done`

    expect(readOperatorNeedHeaders(note)).toEqual({ need: 'open' })
  })

  it('accepts every state a need can be in, and none', () => {
    for (const need of ['open', 'seen', 'done', 'blocked', 'none'] as const) {
      expect(readOperatorNeedHeaders(operatorNeedHeaders({ need })).need).toBe(need)
    }
  })
})
