import { reachabilityLimiter } from '../rate-limit.js'
import type { ReachabilityDependencies } from '../reachability.js'

/**
 * The reachability check's dependencies for a test that is not about it (#394).
 *
 * A real limiter and a fetch that answers 200 without touching a network. Every
 * test that is *about* the check injects its own fetch — usually one that throws
 * if it is called, which is the only way to assert that no request was made.
 */
export function fakeReachability(): ReachabilityDependencies {
  return {
    limiter: reachabilityLimiter(),
    fetch: async () => new Response(null, { status: 200 }),
  }
}
