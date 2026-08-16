import {
  FOLLOW_FEED_LIMIT,
  FOLLOW_LIMIT,
  type FollowEvent,
  type FollowFeedQuery,
} from '@kolonie-ai/core'
import { followRefusals, type Following } from '../following.js'

export interface FakeFollowing extends Following {
  /**
   * Put a citizen in the Colony, with the switch that decides whether it may be
   * followed at all.
   *
   * A parameter and not a default, for `fakeCitizenSearch`'s reason: a test
   * cannot write a citizen and forget to say which side of the line it is on,
   * when the line is what the surface is about.
   */
  readonly citizen: (handle: string, discoverable: boolean) => void
  /** Flip the switch on a citizen already here — what makes *off is immediate* testable. */
  readonly setDiscoverable: (handle: string, discoverable: boolean) => void
  /** Something a followed citizen did, for the feed to gather. */
  readonly event: (event: FollowEvent) => void
  /** Whom this caller follows — **the fixture may ask; no surface can.** */
  readonly followedBy: (followerId: string) => readonly string[]
}

/**
 * Following, in memory (`#1068`).
 *
 * **It reproduces the discovery gate, the two ceilings and idempotence**, which
 * are what `apps/api` decides. Which citizens `attributed` silences, and that a
 * quest can never reach a feed, are `packages/db`'s decisions and are tested
 * there against a real PostgreSQL — a fake that re-implemented those predicates
 * would be asserting a copy of the rule rather than the rule.
 *
 * `followedBy` exists here and has no counterpart anywhere in `src/`. That
 * asymmetry is the point: a test needs to see the list to assert that following
 * worked, and no citizen, route or tool may. Putting it on the fixture is how
 * both stay true.
 */
export function fakeFollowing(): FakeFollowing {
  const discoverable = new Map<string, boolean>()
  const follows = new Map<string, Set<string>>()
  const events: FollowEvent[] = []

  const canonical = (handle: string): string | undefined =>
    [...discoverable.keys()].find((held) => held.toLowerCase() === handle.toLowerCase())

  return {
    citizen(handle, isDiscoverable) {
      discoverable.set(handle, isDiscoverable)
    },
    setDiscoverable(handle, isDiscoverable) {
      const held = canonical(handle)
      if (held !== undefined) discoverable.set(held, isDiscoverable)
    },
    event(event) {
      events.push(event)
    },
    followedBy: (followerId) => [...(follows.get(followerId) ?? [])],

    async set(followerId, handle, following) {
      const held = canonical(handle)
      if (held === undefined) {
        return { outcome: 'refused', error: followRefusals['no-such-citizen'] }
      }

      const held_ = follows.get(followerId) ?? new Set<string>()

      if (!following) {
        held_.delete(held)
        follows.set(followerId, held_)
        return { outcome: 'following', response: { handle: held, following: false } }
      }

      if (discoverable.get(held) !== true) {
        return { outcome: 'refused', error: followRefusals['not-discoverable'] }
      }
      if (!held_.has(held) && held_.size >= FOLLOW_LIMIT) {
        return { outcome: 'refused', error: followRefusals['at-limit'] }
      }

      held_.add(held)
      follows.set(followerId, held_)
      return { outcome: 'following', response: { handle: held, following: true } }
    },

    async feed(followerId, query: FollowFeedQuery) {
      const held = follows.get(followerId) ?? new Set<string>()

      const gathered = events
        .filter((event) => held.has(event.handle) && discoverable.get(event.handle) === true)
        .filter((event) => query.kind === undefined || event.kind === query.kind)
        .filter((event) => query.since === undefined || event.on >= query.since)
        .sort((left, right) => right.on.localeCompare(left.on))

      return {
        events: gathered.slice(0, FOLLOW_FEED_LIMIT),
        truncated: gathered.length > FOLLOW_FEED_LIMIT,
      }
    },

    async count(followerId, since) {
      return (await this.feed(followerId, { since })).events.length
    },
  }
}
