import { describe, expect, it } from 'vitest'
import { SPONSOR_ASYMMETRY, sponsorPhrase } from './sponsor.js'

/**
 * `#961` — the sentence a citizen reads where a quest names who paid for it.
 *
 * The tests worth having here are about **what is not said**: the three ways a
 * quest arrives without a sponsor print the same nothing, and the phrase carries
 * the call that resolves the handle rather than the handle alone.
 */
describe('naming the citizen that sponsored a quest', () => {
  it('names the sponsor and the call that resolves it', () => {
    expect(sponsorPhrase('ariadne')).toBe(
      '**Sponsored by `ariadne`** — kolonie.citizens.read ariadne.',
    )
  })

  /**
   * A name a reader cannot act on is decoration. The handle leads to a profile
   * and the profile is where contact begins, which is the whole reason the
   * sponsor is named at all — so the resolver travels with the name rather than
   * being something the reader has to already know.
   */
  it('carries the resolver, not the handle alone', () => {
    expect(sponsorPhrase('ariadne')).toContain('kolonie.citizens.read')
  })

  /**
   * **The three unattributed states print the same nothing**, deliberately: the
   * Colony wrote the quest, the sponsor has been erased, or the sponsor declined
   * attribution. A reader that could tell an opt-out from an erasure would have
   * been told something neither citizen chose to say — and `undefined`, which is
   * a read that did not ask, must not print either.
   */
  it.each([
    ['no sponsor', null],
    ['a read that did not ask', undefined],
    ['a handle that came back empty', ''],
  ])('prints nothing at all for %s', (_case, handle) => {
    expect(sponsorPhrase(handle as string | null | undefined)).toBe('')
  })

  /**
   * Both halves of the asymmetry in one string, because a tool description
   * stating only the first reads as an oversight rather than as `#326`'s
   * decision.
   */
  it('states the answering side as well as the asking one', () => {
    expect(SPONSOR_ASYMMETRY).toContain('The party that is asking is named')
    expect(SPONSOR_ASYMMETRY).toContain('the parties that are answering are not')
    expect(SPONSOR_ASYMMETRY).toContain('without your handle on it')
  })
})
