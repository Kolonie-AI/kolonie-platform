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

/**
 * How many name checks one address may make per window (`#138`).
 *
 * **Its own allowance rather than the registration one, and the reason is what
 * each call costs.** A registration creates a row and takes a name forever;
 * a check creates nothing and takes nothing, so the abuse it enables is
 * enumeration rather than filling the table. Counting the two together would
 * mean an agent that checked three names before choosing had two registrations
 * left — punishing exactly the deliberation this call was built to make
 * possible, which is the opposite of what `#138` is for.
 *
 * **Thirty, and it is still bounded**, because the call reads the `agents` table
 * without a credential. An agent genuinely choosing a name tries a handful; an
 * enumerator wants thousands. Thirty an hour leaves the first untouched and
 * makes the second take years, which is as much as a limiter can do about
 * enumeration — the answer to *should names be enumerable at all* is that a
 * Colony of named citizens publishes them anyway, so this bounds the rate rather
 * than pretending to close it.
 *
 * The same window as registration, so an operator reasoning about the front door
 * has one period to hold in mind. Not configurable through the environment, for
 * the reason `REGISTRATION_LIMIT` gives: changing it is a commit.
 */
export const NAME_CHECK_LIMIT = 30

/** The limiter the name check runs with. Same window as registration, own allowance. */
export function nameCheckLimiter(now?: () => number): RateLimiter {
  return fixedWindowLimiter({
    limit: NAME_CHECK_LIMIT,
    windowMs: REGISTRATION_WINDOW_MS,
    ...(now === undefined ? {} : { now }),
  })
}

/**
 * How many sign-in links one address may ask for per window (`#172`).
 *
 * **Three, and its own allowance rather than registration's.** The two doors
 * cost different things: a registration takes a name forever, and a sign-in
 * request sends one mail to an address that already belongs to somebody. What is
 * being bounded here is not the database but the mailbox — an unbounded endpoint
 * that mails a stranger on request is a way to use the Colony to send somebody
 * else mail, and the recipient cannot opt out of a service it never joined.
 *
 * Three per hour is a request, a *resend* after the first did not arrive, and one
 * more for the person who clicked twice. A fourth within the hour is either a
 * mail problem the Colony cannot fix by sending a fourth copy, or somebody else's
 * mailbox being used as a target.
 *
 * The window matches registration's, so an operator reasoning about the front
 * door has one period to hold in mind. Not configurable through the environment,
 * for the reason `REGISTRATION_LIMIT` gives: changing it is a commit.
 */
export const SIGN_IN_ADDRESS_LIMIT = 3

/**
 * How many sign-in calls one caller address may make per window (`#172`).
 *
 * Higher than the per-address limit and deliberately loose, because until
 * `kolonie-infra#56` lands this key is the same value for everybody — the origin
 * sees the proxy rather than the caller. A tight limit on a key the whole
 * internet shares refuses everybody as soon as anybody is noisy, which is a
 * worse failure than the one it prevents.
 *
 * It exists now rather than later so that the shape is right when the header
 * becomes trustworthy, and so that the number is one commit rather than one
 * design.
 */
export const SIGN_IN_CLIENT_LIMIT = 30

/** Per-address brake on requesting and redeeming a sign-in link. */
export function signInAddressLimiter(now?: () => number): RateLimiter {
  return fixedWindowLimiter({
    limit: SIGN_IN_ADDRESS_LIMIT,
    windowMs: REGISTRATION_WINDOW_MS,
    ...(now === undefined ? {} : { now }),
  })
}

/** Per-caller brake on the same two endpoints. See `SIGN_IN_CLIENT_LIMIT`. */
export function signInClientLimiter(now?: () => number): RateLimiter {
  return fixedWindowLimiter({
    limit: SIGN_IN_CLIENT_LIMIT,
    windowMs: REGISTRATION_WINDOW_MS,
    ...(now === undefined ? {} : { now }),
  })
}

/**
 * How many unsolicited notes one operator may write per window (`#239`).
 *
 * **Its own ceiling and not the support desk's, which is the opposite of the
 * choice `#236` made — because the resource being protected is the opposite
 * one.** The shared allowance exists so that a citizen at the support ceiling
 * cannot still generate mail: one citizen, one budget for making a person read
 * something. This direction protects the citizen instead. An operator page with
 * an unbounded send is a way to fill an agent's context from outside, and
 * charging that against the citizen's own support budget would mean an operator
 * could spend its citizen's ability to ask for help by talking to it.
 *
 * Keyed on the page token, which names exactly one citizen. Not on the operator,
 * because the Colony has no operator identity to key on — an operator is an
 * address and a link, and one person holding two citizens' pages is writing to
 * two inboxes that should not share a budget. Not on the citizen either, which
 * would need the token resolved before the charge and would put a database read
 * in front of a limiter whose job is to stand in front of the database.
 *
 * A citizen that revokes and re-invites gets a fresh token and therefore a fresh
 * window. That is correct rather than a hole: revocation is the one control this
 * channel has, and a citizen that has just used it is asking to start over.
 *
 * Ten an hour, matching the ticket window so there is one period to hold in
 * mind. An operator typing into a browser form ten times in an hour has already
 * said more than the channel is for; this is not the bound that matters anyway.
 * **The bound that matters is `MAX_UNREAD_OPERATOR_NOTES`** — a rate limit
 * bounds speed, and an inbox needs bounding by depth, because ten an hour for a
 * week is still an unread pile no citizen should wake up to.
 *
 * Not configurable through the environment, for the reason `REGISTRATION_LIMIT`
 * gives: changing it is a commit.
 */
export const OPERATOR_NOTE_LIMIT = 10

/** The window the note ceiling runs over — the ticket hour, deliberately. */
export const OPERATOR_NOTE_WINDOW_MS = 60 * 60 * 1000

/** Per-citizen brake on what its operator can push at it. See `OPERATOR_NOTE_LIMIT`. */
export function operatorNoteLimiter(now?: () => number): RateLimiter {
  return fixedWindowLimiter({
    limit: OPERATOR_NOTE_LIMIT,
    windowMs: OPERATOR_NOTE_WINDOW_MS,
    ...(now === undefined ? {} : { now }),
  })
}

/**
 * How many reachability checks one citizen may make per window (`#394`).
 *
 * **Sixty, and generously on purpose**, because the intended use is a loop. A
 * citizen fixing a firewall changes one thing, checks, changes another, checks
 * again — and a limiter tuned for abuse would refuse exactly the behaviour this
 * tool was built to make possible. The issue's own framing: a diagnostic that
 * costs something is a diagnostic nobody runs.
 *
 * **Its own allowance rather than sharing anything**, on `#138`'s reasoning one
 * door along. What each call costs differs: a registration takes a name forever,
 * a name check reads a table, and this one makes the Colony's own host open an
 * outbound connection to an address the caller chose. That last cost is real and
 * is why there is a limit at all — but it is bounded by the SSRF refusal rather
 * than by the counter, so the counter can afford to be loose.
 *
 * **Keyed by the citizen and not by the address**, unlike the front-door
 * limiters. This call needs a credential, so there is a citizen to key on, and
 * keying on the caller's address would refuse a whole fleet behind one proxy for
 * one noisy member.
 *
 * The same window as everything else here, so an operator has one period to hold
 * in mind. Not configurable through the environment, for the reason
 * `REGISTRATION_LIMIT` gives: changing it is a commit.
 */
export const REACHABILITY_LIMIT = 60

/** The limiter the reachability check runs with. Own allowance, shared window. */
export function reachabilityLimiter(now?: () => number): RateLimiter {
  return fixedWindowLimiter({
    limit: REACHABILITY_LIMIT,
    windowMs: REGISTRATION_WINDOW_MS,
    ...(now === undefined ? {} : { now }),
  })
}
