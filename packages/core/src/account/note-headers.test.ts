import { describe, expect, it } from 'vitest'
import {
  OPERATOR_NEED_HEADER,
  OPERATOR_NEED_THREAD_HEADER,
  operatorNeedHeaders,
  readOperatorNeedHeaders,
  earnFocusHeaders,
  readEarnFocusHeaders,
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

/**
 * The Earn-Ops focus headers (`#1412`).
 *
 * The same shape as the operator-need pair above, and the tests worth having are
 * the same three: what a full tick writes, what an empty-handed one leaves out,
 * and that the two header sets can share one note without reading each other's
 * lines.
 */
describe('the Earn-Ops focus headers', () => {
  const full = {
    intent: 'bounty board, weekly sweep for TypeScript jobs',
    lastAction: 'read the board, nothing under 2 hours',
    usefulness: 'low',
    jobsSeen: 3,
    blocker: 'every open job wants a portfolio link',
    next: 'try the RSS feed instead of the web board',
  } as const

  it('writes the six lines a full tick has', () => {
    expect(earnFocusHeaders(full).split('\n')).toEqual([
      'intent: bounty board, weekly sweep for TypeScript jobs',
      'last_action: read the board, nothing under 2 hours',
      'usefulness: low',
      'jobs_seen: 3',
      'blocker: every open job wants a portfolio link',
      'next: try the RSS feed instead of the web board',
    ])
  })

  /**
   * A header carrying nothing reads as *this question was asked and not
   * answered*, which is a fault rather than the ordinary case. A tick with no
   * blocker had no blocker.
   */
  it('leaves out the blocker and the count where the tick had neither', () => {
    const written = earnFocusHeaders({
      intent: 'referral rail',
      lastAction: 'checked the dashboard',
      usefulness: 'unknown',
      next: 'ask the operator for the payout address',
    })

    expect(written).not.toContain('blocker')
    expect(written).not.toContain('jobs_seen')
    expect(written.split('\n')).toHaveLength(4)
  })

  it('reads back what it wrote', () => {
    expect(readEarnFocusHeaders(earnFocusHeaders(full))).toEqual({
      intent: full.intent,
      lastAction: full.lastAction,
      usefulness: 'low',
      jobsSeen: 3,
      blocker: full.blocker,
      next: full.next,
    })
  })

  it('reads a note that carries only some of them', () => {
    expect(readEarnFocusHeaders('usefulness: high\nnext: run it again tomorrow')).toEqual({
      usefulness: 'high',
      next: 'run it again tomorrow',
    })
  })

  /**
   * `#1602`'s headers and these share one note and do not know about each
   * other, which is what lets Earn-Ops touch an account that also has a live
   * operator ask.
   */
  it('shares a note with the operator-need headers, each reading its own lines', () => {
    const note = [
      operatorNeedHeaders({ need: 'open', threadId: THREAD }),
      '',
      earnFocusHeaders(full),
      '',
      'and a sentence of my own about the provider',
    ].join('\n')

    expect(readOperatorNeedHeaders(note)).toEqual({ need: 'open', threadId: THREAD })
    expect(readEarnFocusHeaders(note).usefulness).toBe('low')
    expect(readEarnFocusHeaders(note).intent).toBe(full.intent)
  })

  /** A reader of somebody else's free text does not claim to have understood it. */
  it('drops a usefulness word that is not one of the three', () => {
    expect(readEarnFocusHeaders('usefulness: quite good')).toEqual({})
  })

  it('drops a count that is not a whole number rather than rounding it', () => {
    expect(readEarnFocusHeaders('jobs_seen: about six')).toEqual({})
  })

  it('reads nothing out of a note that carries none of them', () => {
    expect(readEarnFocusHeaders('just a note to myself')).toEqual({})
    expect(readEarnFocusHeaders(null)).toEqual({})
  })

  /**
   * A newline inside a value would end the header and start whatever the next
   * line parses as, so it is collapsed rather than carried.
   */
  it('keeps a value on one line', () => {
    const written = earnFocusHeaders({
      intent: 'a rail\nwith a newline in it',
      lastAction: 'looked',
      usefulness: 'unknown',
      next: 'look again',
    })

    expect(written).toContain('intent: a rail with a newline in it')
    expect(written.split('\n')).toHaveLength(4)
  })
})
