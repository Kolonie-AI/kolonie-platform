import { describe, expect, it } from 'vitest'
import { operatorNeedState, type OperatorNeedFacts } from './operator-need.js'

/**
 * Where an operator-need has got to (`#1601`).
 *
 * **Four words the Earn-Ops tick branches on**, derived from the thread rather
 * than stored beside it. What these tests hold is the order of the branches,
 * because every one of them is a case the issue named and the order is what
 * decides between them.
 */
describe('reading an operator-need off its thread', () => {
  const facts = (overrides: Partial<OperatorNeedFacts> = {}): OperatorNeedFacts => ({
    personReplied: false,
    shares: [],
    ...overrides,
  })

  const share = (overrides: Partial<OperatorNeedFacts['shares'][number]> = {}) => ({
    reads: 0,
    operatorWrote: false,
    ended: null,
    ...overrides,
  })

  it('is open where nobody has done anything', () => {
    expect(operatorNeedState(facts())).toBe('open')
  })

  /** An unread ask with a live credential on it is still just an ask. */
  it('is open where the credential is live and untouched', () => {
    expect(operatorNeedState(facts({ shares: [share()] }))).toBe('open')
  })

  /**
   * **The case `#1601` asks for by name**: a share that was read with no reply
   * is `seen` and must not reach `done`. A credential somebody opened and did
   * not act on is a thing still waiting.
   */
  it('is seen where the credential was opened and nothing else happened', () => {
    expect(operatorNeedState(facts({ shares: [share({ reads: 1 })] }))).toBe('seen')
  })

  it('is done where the person replied', () => {
    expect(operatorNeedState(facts({ personReplied: true }))).toBe('done')
  })

  it('is done where the person wrote back into the credential box', () => {
    expect(operatorNeedState(facts({ shares: [share({ operatorWrote: true })] }))).toBe('done')
  })

  /** An answer settles the ask however the boxes ended up. */
  it('is done even where the offer also expired', () => {
    expect(
      operatorNeedState(facts({ personReplied: true, shares: [share({ ended: 'expired' })] })),
    ).toBe('done')
  })

  /**
   * **Never silent-success** (`#1601`). An expired share nobody read must not
   * read as answered, and must not read as still waiting either: nothing is
   * going to happen now.
   */
  it('is blocked where the offer ran out unread', () => {
    expect(operatorNeedState(facts({ shares: [share({ ended: 'expired' })] }))).toBe('blocked')
  })

  it('is blocked where the citizen took the offer back unread', () => {
    expect(operatorNeedState(facts({ shares: [share({ ended: 'taken-back' })] }))).toBe('blocked')
  })

  /** One live offer is enough to still be waiting on somebody. */
  it('is open where one offer ended and another is still live', () => {
    expect(operatorNeedState(facts({ shares: [share({ ended: 'expired' }), share()] }))).toBe(
      'open',
    )
  })

  it('is seen where one offer ended unread and another was opened', () => {
    expect(
      operatorNeedState(facts({ shares: [share({ ended: 'expired' }), share({ reads: 2 })] })),
    ).toBe('seen')
  })

  /**
   * **A thread with no share cannot reach `seen`**, and that is the honest
   * limitation rather than an oversight: `seen` rests on the share because the
   * person's message read cursor is a read receipt `kolonie.messages.mark_read`
   * promises not to give. With no share and no reply the Colony knows nothing,
   * and `open` is what knowing nothing looks like.
   */
  it('stays open on a thread carrying no credential at all', () => {
    expect(operatorNeedState(facts({ shares: [] }))).toBe('open')
  })
})
