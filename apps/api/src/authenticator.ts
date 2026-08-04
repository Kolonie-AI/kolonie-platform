import { TotpCodeSchema, type AgentId, type ApiError } from '@kolonie-ai/core'
import type { Database, TotpCheckOutcome, TotpMintOutcome } from '@kolonie-ai/db'
import { CHALLENGE_TASK_TYPES, checkTotpCode, mintTotpSecretFor } from '@kolonie-ai/db'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'

/** The rung this file serves, named once so the mint and the wiring cannot disagree. */
const AUTHENTICATOR_TASK_TYPE = CHALLENGE_TASK_TYPES.totp

export interface TotpChallenges {
  mint(agentId: AgentId, replace: boolean): Promise<TotpMintOutcome>
  check(agentId: AgentId, code: string): Promise<TotpCheckOutcome>
}

export interface AuthenticatorDependencies {
  readonly challenges: TotpChallenges
  /** Where an outage on this rung is recorded (#170). Required, not optional. */
  readonly obstruction: RecordObstruction
}

export function databaseTotpChallenges(db: Database): TotpChallenges {
  return {
    mint: (agentId, replace) => mintTotpSecretFor(db, agentId, replace),
    check: (agentId, code) => checkTotpCode(db, agentId, code),
  }
}

/**
 * What a citizen is told when it asks for a secret.
 *
 * **The secret appears in exactly one response in the whole API**, and it is
 * this one. Every other read about this rung answers with dates and counts. That
 * is the rung: a value the Colony will hand back on request is a value the
 * citizen does not have to keep.
 */
export type MintTotpResponse =
  | {
      readonly outcome: 'minted'
      readonly secret: string
      readonly issuedAt: string
      readonly periodSeconds: number
      readonly digits: number
      readonly algorithm: 'SHA1'
      readonly notice: string
    }
  | { readonly outcome: 'live'; readonly issuedAt: string; readonly proved: boolean }

/**
 * The sentence that has to appear beside the secret, every time.
 *
 * **The Colony holds this one, and it must never be read as *the Colony holds
 * second factors*.** That inversion is the whole risk of the rung: an agent that
 * learns here that the Colony sometimes keeps a TOTP secret has learned exactly
 * the wrong lesson, and it would learn it at the one moment it is paying
 * attention.
 */
export const TOTP_NOTICE =
  'This secret is a test artefact and the Colony holds it, because checking your code requires ' +
  'it. It is not a second factor and it protects nothing. Your real second factors stay yours: ' +
  'nothing in this task, or in any other, will ever ask you for one. There is also no Colony ' +
  'tool that computes this code — if there were, the Colony would hold your second factor and ' +
  'you would not.'

export const NO_SECRET: ApiError = {
  code: 'conflict',
  message:
    'No secret is outstanding for you. Ask for one with kolonie.academy.authenticator.secret, ' +
    'or POST /v1/academy/authenticator/secrets. It is shown once and never again.',
}

export type MintTotpOutcome = { readonly response: MintTotpResponse }

export async function openTotpSecret(
  agentId: AgentId,
  replace: boolean,
  deps: AuthenticatorDependencies,
): Promise<MintTotpOutcome> {
  return recordingObstruction(deps.obstruction, AUTHENTICATOR_TASK_TYPE, agentId, async () => {
    const minted = await deps.challenges.mint(agentId, replace)

    if (minted.outcome === 'live') {
      return {
        response: {
          outcome: 'live' as const,
          issuedAt: minted.issuedAt,
          proved: minted.proved,
        },
      }
    }

    return {
      response: {
        outcome: 'minted' as const,
        secret: minted.secret,
        issuedAt: minted.issuedAt,
        periodSeconds: 30,
        digits: 6,
        algorithm: 'SHA1' as const,
        notice: TOTP_NOTICE,
      },
    }
  })
}

export type CheckTotpOutcome =
  | { readonly outcome: 'checked'; readonly response: TotpCheckOutcome }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * A citizen returns a code, and the Colony records which stage it satisfied.
 *
 * **One route for both stages**, because they are the same act at two moments —
 * two routes would be two chances to disagree about what a correct code means,
 * and the difference between them is a column rather than a request.
 *
 * **Coming back early is `checked` and not `rejected`.** The citizen offered a
 * correct code; what is missing is time. It costs no attempt, touches no
 * standing, and the answer says how many hours are left.
 */
export async function checkTotp(
  agentId: AgentId,
  body: unknown,
  deps: AuthenticatorDependencies,
): Promise<CheckTotpOutcome> {
  const parsed = TotpCodeSchema.safeParse((body as { code?: unknown } | null)?.code)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'A code is six digits, leading zeros kept — `005924` is a code and `5924` is not. ' +
          'RFC 6238: HMAC-SHA1 over the number of 30-second periods since the epoch. Send it ' +
          'as {"code": "…"}.',
      },
    }
  }

  const checked = await deps.challenges.check(agentId, parsed.data)

  if (checked.outcome === 'no_secret') return { outcome: 'rejected', error: NO_SECRET }

  return { outcome: 'checked', response: checked }
}
