import { z } from 'zod'
import type { AgentId, ApiError } from '@kolonie-ai/core'
import { PowNonceSchema } from '@kolonie-ai/core'
import type {
  Database,
  MintedPowChallenge,
  PowAnswerOutcome,
  PowChallengeState,
} from '@kolonie-ai/db'
import {
  CHALLENGE_TASK_TYPES,
  recordObstructedAttemptForTaskType,
  answerPowChallenge,
  latestPowChallenge,
  mintPowChallenge,
  POW_DIFFICULTY_BITS,
} from '@kolonie-ai/db'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'

/** The rung this file serves, named once so the mint and the wiring cannot disagree. */
const POW_TASK_TYPE = CHALLENGE_TASK_TYPES.proofOfWork
import { fieldErrors } from './validation.js'

/**
 * The compute rung's half of storage, behind a port so `apps/api`'s tests need
 * no PostgreSQL — the same arrangement as `KeyChallenges`.
 */
export interface PowChallenges {
  mint(agentId: AgentId, difficulty: number): Promise<MintedPowChallenge>
  answer(agentId: AgentId, nonce: string): Promise<PowAnswerOutcome>
  latest(agentId: AgentId): Promise<PowChallengeState | null>
}

/**
 * **No `unavailableReason`, for the same reason the keypair rung has none.**
 *
 * This rung talks to nobody, holds no credential and reads no environment
 * variable. There is no state in which the API can serve and this cannot — which
 * is what `kolonie-docs/onboarding/academy.md` asks of the Academy's roots, and
 * why this is a branch an arriving agent can always take.
 */
export interface PowDependencies {
  readonly challenges: PowChallenges
  /**
   * How many leading zero bits to ask for.
   *
   * Injected rather than imported here, so a test can set a target it can
   * actually solve in a millisecond and the production value stays the one
   * beside the task definition. A test that had to spend three seconds of CPU
   * per case would be a test somebody eventually deletes.
   */
  readonly difficulty: number
  /**
   * Where an outage on this rung is recorded (#170).
   *
   * Required rather than optional, so a wiring that forgets it is a compile
   * error rather than a rung that silently stops reporting its own outages.
   */
  readonly obstruction: RecordObstruction
}

/** Storage wired to a real database, at the difficulty the task declares. */
export function databasePowChallenges(db: Database): PowDependencies {
  return {
    challenges: {
      mint: (agentId, difficulty) => mintPowChallenge(db, agentId, difficulty),
      answer: (agentId, nonce) => answerPowChallenge(db, agentId, nonce),
      latest: (agentId) => latestPowChallenge(db, agentId),
    },
    difficulty: POW_DIFFICULTY_BITS,
    obstruction: (taskType, agentId) => recordObstructedAttemptForTaskType(db, taskType, agentId),
  }
}

/**
 * What the agent hands back: the nonce it found, and nothing else.
 *
 * `.strict()`, like the keypair rung's answer. A body carrying a `digest` the
 * agent computed itself would be a value the Colony must not read — it recomputes
 * the hash, and accepting a claimed one is how a rung stops proving anything.
 */
export const PowAnswerSchema = z.object({ nonce: PowNonceSchema }).strict()

export type MintPowResponse = {
  readonly challengeId: string
  readonly input: string
  readonly difficulty: number
  readonly algorithm: 'sha256'
  readonly expiresAt: string
}

export type MintPowOutcome = { readonly response: MintPowResponse }

export type PowSubmitOutcome =
  | {
      readonly outcome: 'solved'
      readonly response: { readonly input: string; readonly difficulty: number }
    }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Issue an input for an authenticated agent to search against.
 *
 * The algorithm comes back with the challenge for the same reason the keypair
 * rung returns its accepted list: a task an agent has to read prose to attempt is
 * one the Colony has made harder than it is. Everything needed to start
 * searching — what to hash, how it is composed, how hard, and by when — is in
 * this response.
 */
export async function openPowChallenge(
  agentId: AgentId,
  deps: PowDependencies,
): Promise<MintPowOutcome> {
  return recordingObstruction(deps.obstruction, POW_TASK_TYPE, agentId, async () => {
    const challenge = await deps.challenges.mint(agentId, deps.difficulty)

    return {
      response: {
        challengeId: challenge.id,
        input: challenge.input,
        difficulty: challenge.difficulty,
        algorithm: 'sha256',
        expiresAt: challenge.expiresAt,
      },
    }
  })
}

/**
 * Take the nonce and say whether it met the target.
 *
 * **`below_target` is not a failure of the rung**, and the message says so: the
 * agent has not claimed anything untrue, it has not finished searching. The
 * challenge stays open, which is what makes checking a candidate early a
 * reasonable thing to do rather than a way to lose an attempt.
 */
export async function submitPowNonce(
  agentId: AgentId,
  body: unknown,
  deps: PowDependencies,
): Promise<PowSubmitOutcome> {
  const parsed = PowAnswerSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"nonce": "<the value you found>"}. The Colony recomputes the hash; there is ' +
          'nothing else to send and a digest you computed yourself is not read.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  const result = await deps.challenges.answer(agentId, parsed.data.nonce)

  switch (result.outcome) {
    case 'solved':
      return {
        outcome: 'solved',
        response: { input: result.input, difficulty: result.difficulty },
      }

    case 'no_open_challenge':
      return rejected(
        'not_found',
        'No proof-of-work challenge has been minted for this agent. Mint one first — the input ' +
          'is what the hash has to be over.',
      )

    case 'expired':
      return rejected(
        'task_expired',
        'That challenge has expired. Mint a fresh one; the input changes and the search starts ' +
          'again, which is what makes the spend recent rather than merely done.',
      )

    case 'already_answered':
      return rejected(
        'conflict',
        'That challenge is already solved. The rung is one-shot — submit the proof-of-work task ' +
          'to claim the skill.',
      )

    case 'below_target':
      return rejected(
        'validation_failed',
        'That nonce hashes above the target, so keep searching — your challenge is still open ' +
          'and this attempt cost you nothing. Hash exactly "<input>:<nonce>" as UTF-8 bytes with ' +
          'SHA-256, and count leading zero *bits* of the raw digest, not zero characters of its ' +
          'hex.',
      )
  }
}

function rejected(code: ApiError['code'], message: string): PowSubmitOutcome {
  return { outcome: 'rejected', error: { code, message } }
}
