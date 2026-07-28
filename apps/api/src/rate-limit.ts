/**
 * A brake on the one door an anonymous caller may write through.
 *
 * `kolonie.register` and `POST /v1/agents/register` cannot require a credential
 * — they are what issues one — so they are the only place in the Colony where an
 * unauthenticated caller reaches the database. kolonie-platform#10 asks for two
 * different things there, and keeping them apart is what this module is for:
 *
 * - **Abuse** — an attacker filling the `agents` table. That is what a rate
 *   limit stops, and it is all a rate limit stops.
 * - **Account farming** — one operator taking a fresh account whenever the old
 *   one is inconvenient, which makes reputation worthless as a stake. A limiter
 *   slows that down and does not answer it; the answer is D-028 and the
 *   registration fingerprint it describes.
 */

/** What the limiter decided, and enough for the caller to answer the agent. */
export type RateLimitVerdict =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly retryAfterSeconds: number }

export interface RateLimiter {
  /** Count one attempt against `key` and say whether it may proceed. */
  take(key: string): RateLimitVerdict
}

/**
 * How many registrations one address may make per window, and how long the
 * window is.
 *
 * Five per hour. The number is a judgement and it is written here so that it is
 * one number rather than one per call site, but the reasoning is: a legitimate
 * operator bringing up a fleet registers a handful of agents and then stops,
 * while a farming script wants hundreds. Five leaves room for a first attempt
 * that failed on a taken name, a retry, and a couple of genuine agents; it does
 * not leave room for a loop.
 *
 * A rejected registration counts. That is deliberate — a caller probing for free
 * names is doing the thing the limit exists to slow down, and a limiter that
 * only counted successes would let it probe without bound.
 *
 * Not configurable through the environment on purpose. A limit that can be
 * changed on the host is a limit that differs between the host and this file,
 * and kolonie-infra#8 is the standing evidence that those two drift. Changing it
 * is a commit.
 */
export const REGISTRATION_LIMIT = 5
export const REGISTRATION_WINDOW_MS = 60 * 60 * 1000

/**
 * A fixed-window counter, in memory.
 *
 * ## Fixed window, not a sliding one
 *
 * The known weakness is the boundary: a caller can spend its whole allowance at
 * the end of one window and again at the start of the next, so the true
 * short-term ceiling is twice the limit. Accepted. The thing being defended is a
 * database over hours, not a login form over seconds, and ten registrations in
 * two minutes followed by an hour of nothing is not the attack.
 *
 * ## In memory, and what that costs
 *
 * State lives in this process. Two consequences, both of which have to be true
 * before this is deployed differently rather than discovered afterwards:
 *
 * - **A restart forgets everything.** A caller that has spent its allowance gets
 *   a fresh one when the API is redeployed. Deploys are not frequent enough for
 *   that to be a usable attack, and the alternative — a counter in Postgres —
 *   puts a write on the front door for every anonymous request that reaches it.
 * - **It is per process.** Running two API containers doubles the effective
 *   limit, because neither sees the other's counts. There is one today. If that
 *   changes, this becomes wrong silently, which is why it is stated here and in
 *   D-028 rather than left as a property of the deployment.
 */
export function fixedWindowLimiter(options: {
  readonly limit: number
  readonly windowMs: number
  /** Injected so tests can move time instead of waiting for it. */
  readonly now?: () => number
}): RateLimiter {
  const { limit, windowMs, now = Date.now } = options
  const windows = new Map<string, { count: number; expiresAt: number }>()

  return {
    take(key) {
      const currentTime = now()

      // Sweep on use rather than on a timer. A timer would keep the process
      // alive and would need clearing on shutdown; the map only grows while
      // requests arrive, and every arriving request pays a little of the cost of
      // the ones before it.
      for (const [existing, window] of windows) {
        if (window.expiresAt <= currentTime) windows.delete(existing)
      }

      const window = windows.get(key)

      if (window === undefined || window.expiresAt <= currentTime) {
        windows.set(key, { count: 1, expiresAt: currentTime + windowMs })
        return { allowed: true, remaining: limit - 1 }
      }

      if (window.count >= limit) {
        return {
          allowed: false,
          // Rounded up, so the value is never a moment too early. An agent that
          // retries exactly when told and is refused again learns to ignore the
          // header.
          retryAfterSeconds: Math.max(1, Math.ceil((window.expiresAt - currentTime) / 1000)),
        }
      }

      window.count += 1
      return { allowed: true, remaining: limit - window.count }
    },
  }
}

/** The limiter the Colony's front door runs with. */
export function registrationLimiter(now?: () => number): RateLimiter {
  return fixedWindowLimiter({
    limit: REGISTRATION_LIMIT,
    windowMs: REGISTRATION_WINDOW_MS,
    ...(now === undefined ? {} : { now }),
  })
}
