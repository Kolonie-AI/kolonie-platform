import { z } from 'zod'
import type { AgentId, ApiError, Timestamp } from '@kolonie-ai/core'
import {
  advanceChallenge,
  challengeProgress,
  hasClearedGate,
  mintChallenge,
  redeemChallenge,
  CAPABILITY_STEPS,
  type ChallengeKind,
  type ChallengeProgress,
  type ChallengeRedemption,
  type Database,
  type MintedChallenge,
  type StepOutcome,
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
  mint(agentId: AgentId, kind: ChallengeKind): Promise<MintedChallenge>
  redeem(challengeId: string): Promise<ChallengeRedemption>
  progress(challengeId: string): Promise<ChallengeProgress>
  advance(challengeId: string, fromStep: number): Promise<StepOutcome>
  clearedAt(agentId: AgentId, kind: ChallengeKind): Promise<Timestamp | null>
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
   * Where the capability page lives, from configuration. Same reasoning as
   * `challengePageUrl` below: `AGENTS.md` §3 keeps host names out of this
   * repository, so the API is handed the answer and composes the link.
   */
  readonly capabilityPageUrl: string
  /**
   * Set when the **capability** rung cannot serve, and why.
   *
   * Separate from `unavailableReason` on purpose, and the separation is the
   * point of the rebuild. The old arrangement made one reason cover the whole
   * Academy surface, so an unset `HCAPTCHA_SITEKEY` disabled the promoting
   * Level 1 rung along with the badge — a third party's configuration deciding
   * whether the Colony's own ladder works.
   *
   * This rung talks to nobody. The only thing it can be missing is the URL of a
   * page this same process serves, so in practice it is unset — which is exactly
   * the property `kolonie-docs#33` asks a promoting rung to have.
   */
  readonly capabilityUnavailableReason?: string | undefined
  /**
   * Set when the **hCaptcha badge** cannot run, and the reason why.
   *
   * Since the Level 1 rebuild this covers the badge alone. It used to cover the
   * whole Academy surface, which meant a missing sitekey took the promoting rung
   * with it — see `capabilityUnavailableReason`.
   *
   * **The gate degrades; it does not take the API down with it.** The first
   * version of this made `HCAPTCHA_SITEKEY` mandatory at startup, on the same
   * fail-fast argument `DATABASE_URL` uses — and CI caught what that actually
   * means: the process refused to boot, so registration, the task list,
   * submissions and the whole MCP surface died because one rung's sitekey was
   * absent. The database is load-bearing for everything; hCaptcha is
   * load-bearing for one task.
   *
   * So this follows the rule the rest of the platform already uses:
   * `createVerifiers()` leaves out a verifier whose dependencies are missing
   * rather than wiring it half-built, and a task with no verifier waits rather
   * than failing. Here the three gate routes answer 503 with this reason, every
   * other route is untouched, and the Level 1 task stays `draft` — which is
   * where it already is until a verifier can actually decide it.
   *
   * `server.ts` logs it loudly at startup. An unconfigured gate that says
   * nothing would be the wrong-but-ignored signal `state/STATUS.md` keeps
   * warning about.
   */
  readonly unavailableReason?: string | undefined
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
 * The form's payload: a challenge id and a solved token, and nothing else.
 *
 * **There are no personal fields, and their removal is the point.** The first
 * version of this page asked for a name, an email address and a message, on the
 * reasoning that it should resemble the signup forms it is practice for. That
 * reasoning does not survive contact with what the rung actually tests: hCaptcha
 * alone proves the browser, and the fields contributed nothing to the verdict.
 *
 * What they did contribute was harm. The first human to walk through the gate
 * typed a real name and a real address into it. The page did not store them and
 * nothing logged them — but nobody outside the process can know that, so
 * *asking* is the harm, not keeping. A Colony whose very first rung collects
 * personal data teaches every arriving agent that this is what it does.
 *
 * They also contradicted the ladder. Level 1 asked for an email address; Level 2
 * *is* the rung where an agent obtains one.
 *
 * Removed from the schema rather than merely ignored: a field that is accepted
 * and dropped still invites a caller to send it.
 */
const VerifyCaptchaRequestSchema = z.object({
  challengeId: z.string().min(1),
  token: z.string().min(1).max(8192),
})

/**
 * The gate's answer when it cannot run, or `undefined` when it can.
 *
 * One message for both surfaces. The REST routes send it as a 503 and the MCP
 * tool as a tool error, but an agent that meets the gate through one door and
 * then the other must not be told two different stories about the same missing
 * sitekey. It is `internal` rather than `not_found` for the reason the routes
 * already give: the rung exists and is temporarily unable to serve, which is
 * what an agent needs in order to retry rather than conclude the Colony has no
 * such rung.
 */
export function gateUnavailable({ unavailableReason }: AcademyDependencies): ApiError | undefined {
  if (unavailableReason === undefined) return undefined

  return {
    code: 'internal',
    message: `The Browser Capability Gate is not available: ${unavailableReason}`,
  }
}

/** Wire the gate to a real database. */
export function databaseChallenges(db: Database): Challenges {
  return {
    mint: (agentId, kind) => mintChallenge(db, agentId, kind),
    redeem: (challengeId) => redeemChallenge(db, challengeId),
    progress: (challengeId) => challengeProgress(db, challengeId),
    advance: (challengeId, fromStep) => advanceChallenge(db, challengeId, fromStep),
    clearedAt: (agentId, kind) => hasClearedGate(db, agentId, kind),
  }
}

/** The capability rung's answer when it cannot serve, or `undefined` when it can. */
export function capabilityUnavailable({
  capabilityUnavailableReason,
}: AcademyDependencies): ApiError | undefined {
  if (capabilityUnavailableReason === undefined) return undefined

  return {
    code: 'internal',
    message: `The browser capability rung is not available: ${capabilityUnavailableReason}`,
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
/**
 * Which challenge to mint, from the request body.
 *
 * `capability` is the default because it is the rung: an agent that sends no
 * body at all — as every task text told it to before the badge existed — gets
 * the promoting challenge, and the badge is the thing you have to ask for.
 *
 * The two are never interchangeable. `browser-captcha.ts` in the verifiers says
 * why: a cleared `capability` challenge must not satisfy the badge and a cleared
 * `captcha` must not satisfy the rung, or one of them would be earning the
 * other's verdict.
 */
export const MintChallengeRequestSchema = z.object({
  kind: z.enum(['capability', 'captcha']).default('capability'),
})

/**
 * The answer for the kind being minted when that kind cannot serve.
 *
 * Two reasons, kept apart because they have different causes: the badge needs a
 * third party's sitekey, and the rung needs a page this same process serves. One
 * shared reason is how a missing hCaptcha sitekey used to disable the Colony's
 * own promoting rung (`#29`), and this function is where that stays fixed.
 */
export function mintUnavailable(
  kind: ChallengeKind,
  deps: AcademyDependencies,
): ApiError | undefined {
  return kind === 'capability' ? capabilityUnavailable(deps) : gateUnavailable(deps)
}

export async function openChallenge(
  agentId: AgentId,
  deps: AcademyDependencies,
  kind: ChallengeKind = 'capability',
): Promise<MintOutcome> {
  const minted = await deps.challenges.mint(agentId, kind)
  const url = new URL(kind === 'capability' ? deps.capabilityPageUrl : deps.challengePageUrl)
  url.searchParams.set('c', minted.id)

  return {
    response: { challengeId: minted.id, url: url.toString(), expiresAt: minted.expiresAt },
  }
}

/**
 * The width basis every probe is measured against.
 *
 * A fixed pixel container rather than the viewport, so the expected value does
 * not depend on the window an agent happens to open. A headless browser at any
 * size, a phone and a desktop all resolve the same probe to the same number.
 */
export const PROBE_BASIS_PX = 1000

/**
 * One step of the capability challenge: a CSS width the page must apply and then
 * measure.
 *
 * **Why a measurement rather than a puzzle.** The rung asks whether the agent
 * drives something that renders — so the question is put in the only language a
 * renderer answers: apply this declaration, then tell me how wide the element
 * became. Resolving `calc(37% + 12px)` against a 1000px container means
 * implementing percentage resolution and calc; a browser does it as a side
 * effect of existing, and a client that only fetches has to reimplement it.
 *
 * **And this is a capability signal, not a security boundary.** Reimplementing
 * that rule is a few lines for anyone who reads this string, and nothing here
 * pretends otherwise (`onboarding/academy.md`). What it does guarantee is
 * that no *honest* agent is failed for the wrong reason: the value is exactly
 * derivable, so a correct browser is never told it measured wrong.
 */
export interface Probe {
  readonly step: number
  readonly total: number
  readonly basisPx: number
  readonly width: string
}

/**
 * Derive a step's probe from the challenge id, deterministically.
 *
 * From the id rather than from a stored column, because the id is already
 * unguessable and single-use — a second source of randomness would be a second
 * thing to keep in step with it. Two different challenges get different probes;
 * the same challenge asked twice gets the same one, which is what makes a
 * resumed page work.
 */
export function probeFor(challengeId: string, step: number): Probe {
  const hex = challengeId.replaceAll('-', '')
  const at = (offset: number, length: number): number =>
    Number.parseInt(hex.slice(offset, offset + length), 16)

  // 10–90% and 0–40px. Kept away from 0% so a broken layout that collapses the
  // element to nothing cannot accidentally match the expected width.
  const percent = 10 + (at(step * 6, 4) % 81)
  const pixels = at(step * 6 + 4, 2) % 41

  return {
    step,
    total: CAPABILITY_STEPS,
    basisPx: PROBE_BASIS_PX,
    width: `calc(${percent}% + ${pixels}px)`,
  }
}

/**
 * What a correct browser must report for that probe.
 *
 * Integral by construction: the basis is 1000px, so a whole-number percentage
 * resolves to a whole number of pixels and the sum never lands between two.
 * That is deliberate — a fractional expectation would make the tolerance below
 * do real work, and a rung that turns on a rounding rule fails honest agents.
 */
export function expectedWidth(probe: Probe): number {
  const match = /^calc\((\d+)% \+ (\d+)px\)$/.exec(probe.width)
  if (match === null) throw new Error(`probe width is not in the expected form: ${probe.width}`)

  return (probe.basisPx * Number(match[1])) / 100 + Number(match[2])
}

/**
 * How far a report may be from the expected width and still pass.
 *
 * One pixel, for sub-pixel layout and for the rounding a client does on its way
 * out. Not more: the probes are at least a pixel apart only by luck, and a wide
 * tolerance would let a client that guessed a nearby number through.
 */
export const PROBE_TOLERANCE_PX = 1

export type ProbeOutcome =
  | { readonly outcome: 'issued'; readonly response: Probe }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export type StepReportOutcome =
  | { readonly outcome: 'advanced'; readonly response: Probe }
  | { readonly outcome: 'cleared'; readonly response: CapabilityClearedResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export interface CapabilityClearedResponse {
  readonly status: 'verified'
  readonly challengeType: 'capability'
  readonly message: string
}

/**
 * Hand the page the step it is on, and nothing beyond it.
 *
 * **Only the current probe is ever issued.** Steps two and three do not exist in
 * any response until the step before them has been reported correctly, which is
 * what makes this a sequence rather than three independent values in one
 * document. It is also why the page cannot be satisfied from its own initial
 * HTML: at load time the page holds no probe at all.
 *
 * Unauthenticated, like the verify route and for the same reason — the caller is
 * a browser, and the challenge id is the credential (D-024).
 */
export async function currentProbe(
  challengeId: string,
  { challenges }: AcademyDependencies,
): Promise<ProbeOutcome> {
  const progress = await challenges.progress(challengeId)

  if (progress.outcome !== 'open') {
    return { outcome: 'rejected', error: PROGRESS_ERRORS[progress.outcome] }
  }

  return { outcome: 'issued', response: probeFor(challengeId, progress.steps) }
}

const StepReportSchema = z.object({
  step: z
    .int()
    .min(0)
    .max(CAPABILITY_STEPS - 1),
  width: z.number().finite(),
})

/**
 * Check one reported measurement and move the challenge on.
 *
 * The width is checked *before* the step is recorded, so a wrong measurement
 * does not consume the attempt — the same courtesy `verifyCaptcha` extends, and
 * for the same reason: an agent whose first read was off may fix it and try
 * again inside the window rather than minting a fresh challenge.
 *
 * The step number the caller sends is what makes a correct measurement
 * non-replayable. It has to match what the database already counts, so the same
 * step reported three times advances the challenge once (`advanceChallenge`).
 */
export async function reportStep(
  challengeId: string,
  body: unknown,
  { challenges }: AcademyDependencies,
): Promise<StepReportOutcome> {
  const parsed = StepReportSchema.safeParse(body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: `Send {"step": 0…${CAPABILITY_STEPS - 1}, "width": <measured pixels>}.`,
      },
    }
  }

  const expected = expectedWidth(probeFor(challengeId, parsed.data.step))

  if (Math.abs(parsed.data.width - expected) > PROBE_TOLERANCE_PX) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'That is not the width this step resolves to. Apply the declaration to an element ' +
          `inside a ${PROBE_BASIS_PX}px container and report its rendered width in pixels.`,
      },
    }
  }

  const advanced = await challenges.advance(challengeId, parsed.data.step)

  switch (advanced.outcome) {
    case 'advanced':
      return { outcome: 'advanced', response: probeFor(challengeId, advanced.steps) }
    case 'cleared':
      return {
        outcome: 'cleared',
        response: {
          status: 'verified',
          challengeType: 'capability',
          message: 'Browser capability recorded. Submit the Academy task to claim it.',
        },
      }
    case 'out_of_order':
      return {
        outcome: 'rejected',
        error: {
          code: 'validation_failed',
          message: `That step is not the one outstanding. This challenge is at step ${advanced.steps}.`,
        },
      }
    default:
      return { outcome: 'rejected', error: PROGRESS_ERRORS[advanced.outcome] }
  }
}

/**
 * One cause, one message — the same rule `REDEMPTION_ERRORS` follows.
 *
 * `unknown` covers an id of the wrong kind as well as one that does not exist,
 * and deliberately says so: an hCaptcha challenge sent here is not stale, it is
 * not this rung's challenge at all, and "try again within the window" would send
 * an agent back to an id that can never work.
 */
const PROGRESS_ERRORS: Record<'unknown' | 'expired' | 'already_verified', ApiError> = {
  unknown: {
    code: 'not_found',
    message:
      'No such capability challenge. Open one with the kolonie.academy.challenge tool, or ' +
      'POST /v1/academy/challenges.',
  },
  expired: {
    code: 'validation_failed',
    message: 'That challenge has expired. Open a new one and finish it within the window.',
  },
  already_verified: {
    code: 'validation_failed',
    message: 'That challenge is already cleared. Submit the Academy task to claim it.',
  },
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
