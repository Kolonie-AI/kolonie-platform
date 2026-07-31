import { describe, expect, it } from 'vitest'
import { txtFailure } from './dns.js'

/** What `node:dns` throws, reduced to the one property this classification reads. */
const answering = (code: string) => Object.assign(new Error(code), { code })

/** The reason a failure carries. `ok` has none, and reaching here would be the bug. */
const reasonOf = (result: ReturnType<typeof txtFailure>): string => {
  if (result.outcome === 'ok') throw new Error('a failure classified as a successful read')

  return result.reason
}

describe('txtFailure', () => {
  /**
   * The half that costs a citizen its attempt if it is wrong. A resolver that
   * timed out has told the Colony about its own network and nothing about the
   * citizen's zone, so this must never become a `fail` one layer up.
   */
  it('calls a resolver problem unavailable, so the verdict pends', () => {
    for (const code of ['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED']) {
      expect(txtFailure(answering(code), '_kolonie-challenge.example.com').outcome).toBe(
        'unavailable',
      )
    }
  })

  /**
   * The other half, which costs the Colony a timeout if it is wrong. The zone
   * answered and the answer was no; waiting for it to change is waiting for
   * something that has already happened.
   */
  it('calls a real answer no-record, so the verdict fails now', () => {
    expect(txtFailure(answering('ENOTFOUND'), 'a.example.com').outcome).toBe('no-record')
    expect(txtFailure(answering('ENODATA'), 'a.example.com').outcome).toBe('no-record')
  })

  it('tells "no such name" apart from "no TXT there" in the reason', () => {
    expect(reasonOf(txtFailure(answering('ENODATA'), 'a.example.com'))).toContain('no TXT record')
    expect(reasonOf(txtFailure(answering('ENOTFOUND'), 'a.example.com'))).toContain(
      'does not exist',
    )
  })

  /**
   * An unrecognised code is a `no-record` and not an `unavailable`, which is the
   * safer default of the two: the citizen is told now, with the code in the
   * reason, rather than waiting out a timeout and being told it ran out of time.
   */
  it('defaults an unknown failure to a decided answer, naming the code', () => {
    const result = txtFailure(answering('EBADRESP'), 'a.example.com')

    expect(result.outcome).toBe('no-record')
    expect(reasonOf(result)).toContain('EBADRESP')
  })

  it('survives something that is not an Error at all', () => {
    expect(reasonOf(txtFailure('not an error', 'a.example.com'))).toContain('unknown')
  })
})
