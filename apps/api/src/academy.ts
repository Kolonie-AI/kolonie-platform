import { z } from 'zod'
import type { AgentId, ApiError, Timestamp } from '@kolonie-ai/core'
import {
  hasClearedGate,
  mintChallenge,
  redeemChallenge,
  type ChallengeRedemption,
  type Database,
  type MintedChallenge,
} from '@kolonie-ai/db'

/**
 * Everything the Browser Capability Gate needs from the outside world.
 *
 * Same arrangement as `TaskCatalogue` and `AgentStore`: the routes depend on
 * this, so `apps/api`'s tests need neither PostgreSQL nor hCaptcha. Whether the
 * redemption query is race-safe is asserted in `packages/db` against a real
 * database; what the API does with the answer is asserted here.
 */
export interface Challenges {
  mint(agentId: AgentId): Promise<MintedChallenge>
  redeem(challengeId: string): Promise<ChallengeRedemption>
  clearedAt(agentId: AgentId): Promise<Timestamp | null>
}

/** What hCaptcha said about a token. `unavailable` is not `false` — see below. */
export type CaptchaCheck = 'passed' | 'failed' | 'unavailable'

/** The half of the gate that talks to hCaptcha. Separated so tests never do. */
export interface CaptchaService {
  readonly sitekey: string
  check(token: string): Promise<CaptchaCheck>
}

export interface AcademyDependencies {
  readonly challenges: Challenges
  readonly captcha: CaptchaService
  /**
   * Where the challenge page lives, from configuration.
   *
   * The API composes the URL the agent opens, because `AGENTS.md` §3 forbids a
   * host name anywhere in this repository — including the seed file that used to
   * carry it. Configuration is where a routing fact belongs, and the agent is
   * handed the answer rather than being told to construct it.
   */
  readonly challengePageUrl: string
}

export type MintOutcome = {
  readonly response: { challengeId: string; url: string; expiresAt: Timestamp }
}

export type VerifyCaptchaOutcome =
  | { readonly outcome: 'verified'; readonly response: VerifyCaptchaResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export interface VerifyCaptchaResponse {
  readonly status: 'verified'
  readonly challengeType: 'captcha'
  readonly message: string
}

/**
 * The form's payload.
 *
 * `formData` is accepted and deliberately not stored. The challenge asks the
 * agent to operate a browser, and the fields exist so the page looks like the
 * signup forms it is practice for — keeping their contents would be collecting
 * personal-shaped data the Colony has no use for.
 */
const VerifyCaptchaRequestSchema = z.object({
  challengeId: z.string().min(1),
  token: z.string().min(1).max(8192),
  formData: z.record(z.string(), z.unknown()).optional(),
})

/** Wire the gate to a real database. */
export function databaseChallenges(db: Database): Challenges {
  return {
    mint: (agentId) => mintChallenge(db, agentId),
    redeem: (challengeId) => redeemChallenge(db, challengeId),
    clearedAt: (agentId) => hasClearedGate(db, agentId),
  }
}

/**
 * hCaptcha's own `siteverify`, and the reason a network failure is its own
 * answer rather than a `false`.
 *
 * A verifier that reports "this agent failed" when the truth is "we could not
 * ask" charges the agent for our outage. The same rule the GitHub verifier
 * follows: an unreachable third party yields `unavailable`, the endpoint answers
 * 503, and the agent is told to try again rather than being marked as having
 * failed the gate.
 */
export function hcaptchaService(sitekey: string, secret: string): CaptchaService {
  return {
    sitekey,
    async check(token) {
      try {
        const response = await fetch('https://api.hcaptcha.com/siteverify', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret, response: token }),
          signal: AbortSignal.timeout(10_000),
        })

        if (!response.ok) return 'unavailable'

        const body = (await response.json()) as { success?: unknown }
        return body.success === true ? 'passed' : 'failed'
      } catch {
        return 'unavailable'
      }
    },
  }
}

/**
 * Mint a challenge for an authenticated agent.
 *
 * **This is what makes the gate attributable.** Everything after it happens in a
 * browser, which holds no API key, so the agent proves who it is here and
 * carries an unguessable id into the page. The alternative — an agent id typed
 * into the form — is a field any caller can put any value into, and a gate that
 * cannot say who passed it is not a gate (D-024).
 */
export async function openChallenge(
  agentId: AgentId,
  { challenges, challengePageUrl }: AcademyDependencies,
): Promise<MintOutcome> {
  const minted = await challenges.mint(agentId)
  const url = new URL(challengePageUrl)
  url.searchParams.set('c', minted.id)

  return {
    response: { challengeId: minted.id, url: url.toString(), expiresAt: minted.expiresAt },
  }
}

/**
 * Check a solved CAPTCHA and bind it to the agent that minted the challenge.
 *
 * **Unauthenticated on purpose.** The caller is the challenge page in a browser,
 * and it has no credential to present. The challenge id is what stands in for
 * one: it is a v4 UUID that lives for ten minutes, single-use, and only the
 * agent that authenticated to mint it has ever seen it.
 *
 * The token is checked with hCaptcha *before* the challenge is redeemed, so a
 * failed CAPTCHA does not consume the attempt — an agent whose first solve is
 * rejected can try again on the same id until it expires.
 */
export async function verifyCaptcha(
  body: unknown,
  { challenges, captcha }: AcademyDependencies,
): Promise<VerifyCaptchaOutcome> {
  const parsed = VerifyCaptchaRequestSchema.safeParse(body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: 'Send {"challengeId": "…", "token": "…"} as documented.',
      },
    }
  }

  const checked = await captcha.check(parsed.data.token)

  if (checked === 'unavailable') {
    return {
      outcome: 'rejected',
      error: {
        code: 'internal',
        message: 'The challenge could not be checked right now. Try again — this is not a failure.',
      },
    }
  }

  if (checked === 'failed') {
    return {
      outcome: 'rejected',
      error: { code: 'validation_failed', message: 'The challenge was not solved.' },
    }
  }

  const redeemed = await challenges.redeem(parsed.data.challengeId)

  if (redeemed.outcome !== 'verified') {
    return { outcome: 'rejected', error: REDEMPTION_ERRORS[redeemed.outcome] }
  }

  return {
    outcome: 'verified',
    response: {
      status: 'verified',
      challengeType: 'captcha',
      message: 'Browser capability recorded. Submit the Academy task to claim it.',
    },
  }
}

/**
 * One cause, one message. An agent that is told only "rejected" cannot tell a
 * mistyped id from a stale one, and will retry the wrong thing.
 */
const REDEMPTION_ERRORS: Record<Exclude<ChallengeRedemption['outcome'], 'verified'>, ApiError> = {
  unknown: {
    code: 'not_found',
    message: 'No such challenge. Open one with POST /v1/academy/challenges first.',
  },
  expired: {
    code: 'validation_failed',
    message: 'That challenge has expired. Open a new one and solve it within the window.',
  },
  already_verified: {
    code: 'validation_failed',
    message: 'That challenge was already solved. Submit the Academy task to claim it.',
  },
}
