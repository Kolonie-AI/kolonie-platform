import { describe, expect, it } from 'vitest'
import { RETIRED_WAKE_EVENTS, WakeEventSchema } from '@kolonie-ai/core'
import { wakeEvent } from './schema/enums.js'

/**
 * The guard that replaces a derivation (`#913`).
 *
 * Until the browser share was withdrawn this enum was built straight from
 * `WakeEventSchema.options`, so it could not disagree with the vocabulary
 * (D-002). It cannot be any more: two values are retired and the database type
 * still carries them, because PostgreSQL will not drop a value from an enum in
 * place. The list in `schema/enums.ts` is therefore written out, in the order
 * the type was built in, and what stopped being structural is asserted here.
 *
 * The order matters as much as the membership. Drizzle compares the enum it
 * renders against the one the database holds, so a value moved — even a retired
 * one — is a diff, and a diff nobody meant is a migration nobody wrote.
 */
describe('the wake_event type carries the live vocabulary and the retired names', () => {
  it('holds every event the vocabulary names', () => {
    for (const event of WakeEventSchema.options) expect(wakeEvent.enumValues).toContain(event)
  })

  it('still holds the two names the share knocked with', () => {
    for (const event of RETIRED_WAKE_EVENTS) expect(wakeEvent.enumValues).toContain(event)
  })

  /**
   * Nothing else. A value in the type that neither list names is either a
   * vocabulary somebody removed without saying so here, or a name that was never
   * meant to reach the database at all.
   */
  it('holds nothing beyond the two lists', () => {
    const accounted = new Set<string>([...WakeEventSchema.options, ...RETIRED_WAKE_EVENTS])
    expect(wakeEvent.enumValues.filter((value) => !accounted.has(value))).toEqual([])
  })

  /**
   * The order the type was built in, written out rather than derived, because a
   * derivation would agree with whatever the schema did and prove nothing.
   */
  it('keeps the order the database holds', () => {
    expect(wakeEvent.enumValues).toEqual([
      'operator-answer',
      'operator-note',
      'wish-wanted',
      'share-ended',
      'share-joined',
      'verdict',
      'quest-opened',
    ])
  })

  /** The withdrawal itself: the two are gone from what an agent can be told. */
  it('keeps the retired names out of the vocabulary', () => {
    for (const event of RETIRED_WAKE_EVENTS)
      expect(WakeEventSchema.options).not.toContain(event as never)
  })
})
