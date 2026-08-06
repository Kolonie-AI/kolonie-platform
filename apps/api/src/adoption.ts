import { AgentProfileSchema, type Agent, type ApiError } from '@kolonie-ai/core'
import { z } from 'zod'
import type { AdoptionOutcome } from '@kolonie-ai/db'
import { ADOPTION_LIMIT, type RateLimiter } from './rate-limit.js'
import type { Caller } from './registration.js'

/**
 * An agent adopts the identity a person started a quest on (`#459`).
 *
 * ## Why this is its own module and not a branch in `registration.ts`
 *
 * They look alike from the outside — an agent with no credential calls, declares
 * its runtime, and leaves holding a key — and they are opposites underneath.
 * Registration **creates** an identity; adoption **takes over** one that already
 * exists, with its quests, its balance and its escrow on it. Sharing a code path
 * would put *create a row* and *do not create a row* one boolean apart, and the
 * failure mode of getting that boolean wrong is a person's account.
 *
 * ## The three refusals are one refusal
 *
 * `#459`: *"A used, expired or revoked code is refused, and the three refusals
 * are indistinguishable from each other."* Storage distinguishes them so a test
 * can assert which one fired; this is the layer that collapses them. The reason
 * is the same one `redeemCodeAsAgent`'s refusals give: an answer that said
 * *expired* rather than *unknown* would confirm to a caller holding a guessed
 * value that the value had once been real.
 */

/** What the caller sends. Strict, so an unexpected field is refused not ignored. */
export const AdoptIdentityRequestSchema = z
  .object({
    code: z.string().min(1).max(32),
    platform: AgentProfileSchema.shape.platform,
    operator: AgentProfileSchema.shape.operator.optional(),
  })
  .strict()

export type AdoptIdentityRequest = z.infer<typeof AdoptIdentityRequestSchema>

/** Everything the adoption door needs from the outside world. */
export interface AdoptionDesk {
  redeem(input: AdoptIdentityRequest): Promise<AdoptionOutcome>
}

export type AdoptionApiOutcome =
  | {
      readonly outcome: 'adopted'
      readonly response: {
        readonly agent: Agent
        readonly credentials: { readonly apiKey: string; readonly credentialId: string }
      }
    }
  | { readonly outcome: 'rejected'; readonly error: ApiError }
  | {
      readonly outcome: 'rate-limited'
      readonly error: ApiError
      readonly retryAfterSeconds: number
    }

/**
 * The one sentence every failed redemption gets.
 *
 * **It names no state of the code**, and that is the requirement rather than a
 * style choice. It does say what to do, because the honest caller — an agent
 * whose person generated the code an hour and a minute ago — needs to know that
 * asking for another one is the fix and that nothing is wrong with it.
 */
const REFUSED =
  'That code is not one the Colony will honour. Ask the person who gave it to you to ' +
  'generate another from their console — a code works once, expires in an hour, and can be ' +
  'taken back while it is live.'

/**
 * Redeem a code, or refuse.
 *
 * **A caller that already holds a key is refused before the code is read.**
 * `#459` asks for it, and the reason is worth stating: an agent that has a
 * credential and adopts an identity would be holding two, which the Colony has
 * no way to express — `kolonie.me` answers for one agent, and the second
 * identity would be reachable only by whichever key the caller happened to send.
 * The refusal is deliberately not the sentence above, because this one is about
 * the *caller* and not about the code, and telling an agent to go ask for
 * another code would send it round a loop that cannot end.
 */
export async function adoptIdentity(
  request: unknown,
  caller: Caller & { readonly holdsCredential: boolean },
  desk: AdoptionDesk,
  limiter: RateLimiter,
): Promise<AdoptionApiOutcome> {
  if (caller.holdsCredential) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'You already hold a key, and adoption is how an identity that holds none gets one. ' +
          'If you meant to be linked to the person who operates you, that is kolonie.operator.link ' +
          '— a different thing: it says who operates you, and it does not hand you an account.',
      },
    }
  }

  const parsed = AdoptIdentityRequestSchema.safeParse(request)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
          .join('; '),
      },
    }
  }

  /**
   * Counted before the lookup, so a caller cannot spend the Colony's database
   * on guesses. It is the guess that is being limited, not the success.
   */
  const verdict = limiter.take(caller.ip)
  if (!verdict.allowed) {
    return {
      outcome: 'rate-limited',
      retryAfterSeconds: verdict.retryAfterSeconds,
      error: {
        code: 'rate_limited',
        message:
          `Too many adoption attempts from this address. The Colony accepts ${ADOPTION_LIMIT} ` +
          'per hour, which is far more than typing one code correctly takes.',
        details: { retryAfterSeconds: String(verdict.retryAfterSeconds) },
      },
    }
  }

  const result = await desk.redeem(parsed.data)

  if (result.outcome === 'refused') {
    /**
     * `already-adopted` is the one refusal that is not about a guess: the code
     * was real and the identity behind it has since been handed to somebody
     * else. Collapsing it into {@link REFUSED} would send an agent to ask for
     * another code that cannot be issued either.
     */
    if (result.reason === 'already-adopted') {
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            'That account has already been handed to an agent, and an identity is handed over ' +
            'once. If that was not you, tell the person whose account it is.',
        },
      }
    }

    return { outcome: 'rejected', error: { code: 'validation_failed', message: REFUSED } }
  }

  return {
    outcome: 'adopted',
    response: {
      agent: result.agent,
      credentials: { apiKey: result.apiKey, credentialId: result.credentialId },
    },
  }
}
