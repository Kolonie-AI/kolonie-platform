import { describe, expect, it } from 'vitest'
import {
  WAITING_EFFORT,
  WaitingItemSchema,
  WaitingKindSchema,
  inClearingOrder,
  type WaitingItem,
} from './queue.js'

/**
 * The operator queue's ordering (#530).
 *
 * **The ordering is the whole feature**, which is why it is a function in `core`
 * with a test rather than an `order by` in one query: *"a queue that puts a
 * five-second captcha behind a card payment is a queue the operator abandons."*
 */
describe('the operator queue', () => {
  const item = (kind: WaitingItem['kind'], since: string, agentName = 'a'): WaitingItem => ({
    agentId: '11111111-1111-4111-8111-111111111111',
    agentName,
    kind,
    ask: 'something',
    about: null,
    since,
    answerAt: null,
    requestId: null,
    dropId: null,
  })

  it('puts what is quick to clear first, however long the slow ones have waited', () => {
    const ordered = inClearingOrder([
      item('question', '2026-08-01T00:00:00.000Z'),
      item('credential', '2026-08-05T00:00:00.000Z'),
      item('code', '2026-08-08T00:00:00.000Z'),
    ])

    expect(ordered.map((row) => row.kind)).toEqual(['code', 'credential', 'question'])
  })

  it('breaks a tie on age, oldest first', () => {
    const ordered = inClearingOrder([
      item('code', '2026-08-08T12:00:00.000Z', 'newer'),
      item('code', '2026-08-08T09:00:00.000Z', 'older'),
    ])

    expect(ordered.map((row) => row.agentName)).toEqual(['older', 'newer'])
  })

  it('does not mutate what it was given', () => {
    const given = [
      item('question', '2026-08-01T00:00:00.000Z'),
      item('code', '2026-08-08T00:00:00.000Z'),
    ]
    inClearingOrder(given)

    expect(given.map((row) => row.kind)).toEqual(['question', 'code'])
  })

  /**
   * A fourth kind would need a rank, and a rank invented at the call site is how
   * two surfaces end up disagreeing about which of two items is cheaper.
   */
  it('ranks every kind it can be given', () => {
    expect(Object.keys(WAITING_EFFORT).sort()).toEqual(['code', 'credential', 'question'])
  })

  /**
   * The rejection case for `#912`: a queue that still knew the word.
   *
   * `browser-share` was a kind, ranked second, and it is gone with the channel
   * behind it. Asserted on the schema rather than on a rendered page, because
   * this is where a reinstatement would start.
   */
  it('has no kind for a shared browser tab', () => {
    expect(WaitingKindSchema.options).toEqual(['code', 'credential', 'question'])
    expect(Object.keys(WAITING_EFFORT)).not.toContain('browser-share')
    expect(Object.keys(WaitingItemSchema.shape)).not.toContain('shareId')
    expect(Object.keys(WaitingItemSchema.shape)).not.toContain('expiresAt')
  })
})
