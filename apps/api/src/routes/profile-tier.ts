import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { clientIp } from '../client-ip.js'
import type { RateLimiter } from '../rate-limit.js'

/**
 * The brake in front of every public profile surface (`#828`).
 *
 * ## One limiter for the three surfaces, not one each
 *
 * The page, the record and the avatar are one page's worth of work: a browser
 * loading `/@colette` fetches two of them and, once `#820` lands, three. Three
 * separate allowances would mean the tier's real ceiling was whichever of them
 * happened to be smallest, discovered by a reader rather than decided here — and
 * an enumerator sweeping handles would get three budgets to do it with, one per
 * surface, for the same work.
 *
 * ## Refused before the lookup, and that is the whole design
 *
 * `refuse` runs first in each route, before `publicRecord` is called. Two
 * consequences, and both are the point:
 *
 * - **A refusal cannot leak whether the handle exists.** Over the limit, a name
 *   nobody holds and a name somebody holds get the same status, the same
 *   headers and the same bytes, because neither was looked up.
 * - **The refusal is cheaper than the thing refused.** A limiter that rendered
 *   an HTML page to say *slow down* would do more work per refusal than per
 *   answer, which is an amplifier rather than a brake. So the 429 is the JSON
 *   error shape on all three surfaces including the HTML one — the only caller
 *   that sees it is one that has already been told, in a header, to wait.
 *
 * ## What it keys on, and how honest that is
 *
 * The source address, via `clientIp` — there is no credential on this tier and
 * therefore no citizen to key on. That file is explicit that the headers it
 * reads are forgeable by anyone who can reach the origin directly
 * (`kolonie-infra#21`), so this is a brake on ordinary volume and not a defence
 * against somebody determined. `PROFILE_TIER_LIMIT` states the same limit about
 * enumeration: the tier bounds the rate at which *does this citizen exist* can
 * be asked, and does not pretend to stop the question being asked.
 */
export interface ProfileTierDependencies {
  /** The allowance, shared by the page, the record and the avatar. */
  readonly limiter: RateLimiter
}

/**
 * Charge one profile-tier request, and answer with the refusal if it is over.
 *
 * `undefined` means *carry on*, which is what lets a route write
 * `const refused = refuseOverLimit(...); if (refused !== undefined) return refused`
 * as its first line and leave everything below it unchanged.
 */
export function refuseOverLimit(
  deps: ProfileTierDependencies,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply | undefined {
  const verdict = deps.limiter.take(clientIp(request.headers, request.ip))
  if (verdict.allowed) return undefined

  /**
   * `no-store`, and it is the one cache header on this tier that is not about
   * the citizen. A 429 cached for a minute would go on refusing a caller that
   * has already served its wait, and a shared cache holding one would refuse
   * everybody behind it for something one of them did.
   *
   * **No `x-robots-tag`**, deliberately. Computing it needs the indexing read
   * this response exists to avoid making — and a `4xx` is not indexed by
   * anything, so there is nothing for the directive to protect here.
   *
   * `access-control-allow-origin: *` for the reason `routes/citizens.ts` gives:
   * a browser that cannot read the status cannot tell a refusal from an outage,
   * and *wait a minute* is the one message on this tier worth reading.
   */
  return reply
    .status(ERROR_STATUS.rate_limited)
    .header('retry-after', String(verdict.retryAfterSeconds))
    .header('cache-control', 'no-store')
    .header('access-control-allow-origin', '*')
    .type('application/json; charset=utf-8')
    .send({
      code: 'rate_limited',
      message: 'Too many requests for public profiles. Try again shortly.',
      details: { retryAfterSeconds: String(verdict.retryAfterSeconds) },
    })
}
