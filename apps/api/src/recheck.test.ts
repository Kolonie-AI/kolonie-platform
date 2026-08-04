import { describe, expect, it } from 'vitest'
import { isPermanent } from './recheck.js'

/**
 * Which delivery failures are evidence about a citizen (`#226`).
 *
 * The direction of the caution is the decision: anything this cannot positively
 * read as a permanent rejection is temporary, so an unfamiliar phrasing costs
 * the Colony another re-check rather than costing a citizen its skill.
 */
describe('reading a delivery failure', () => {
  it.each([
    ['an SMTP enhanced code', '550 5.1.1 <colette@example.test>: no such user'],
    ['a prose rejection', 'Recipient rejected: address does not exist'],
  ])('reads %s as permanent', (_case, reason) => {
    expect(isPermanent(reason)).toBe(true)
  })

  it.each([
    ['a soft bounce', '451 4.7.1 try again later'],
    ['a full mailbox', '452 4.2.2 mailbox full'],
    ['an outage', '421 service unavailable'],
    ['a phrasing nobody has seen', 'the provider said something new'],
    ['no reason at all', undefined],
  ])('reads %s as temporary', (_case, reason) => {
    expect(isPermanent(reason)).toBe(false)
  })
})
