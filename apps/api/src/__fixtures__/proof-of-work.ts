import { createHash, randomUUID } from 'node:crypto'
import { now as currentTime, solvesChallenge, type AgentId } from '@kolonie-ai/core'
import type { MintedPowChallenge, PowAnswerOutcome, PowChallengeState } from '@kolonie-ai/db'
import type { PowChallenges, PowDependencies } from '../proof-of-work.js'

/**
 * The difficulty the fakes mint at.
 *
 * **One bit**, where production asks for twenty. A test that had to spend three
 * seconds of CPU per case is a test somebody eventually deletes, and nothing
 * about the routes changes with the target — the number travels from the task
 * definition to the row to the verifier, and the arithmetic that enforces it is
 * asserted directly in `packages/core`. One bit still fails half of all nonces,
 * which is what a rejection case needs.
 */
export const FAKE_POW_DIFFICULTY = 1

export interface FakePowChallenges extends PowChallenges {
  /** Age the agent's open challenge past its deadline, which minting cannot produce. */
  readonly expire: (agentId: AgentId) => void
  /** The input the agent was last set, so a test can solve it the way an agent would. */
  readonly inputFor: (agentId: AgentId) => string | undefined
}

/**
 * An in-memory challenge store.
 *
 * Reproduces what the routes depend on and nothing more: which agent an input
 * belongs to, how hard it is, whether it expired, and whether a nonce met the
 * target. Whether the real store refuses a second concurrent answer is asserted
 * in `packages/db` against a real Postgres, because that property lives in a
 * `WHERE` clause this file cannot model.
 */
export function fakePowChallenges(): FakePowChallenges {
  interface Row {
    agentId: AgentId
    input: string
    difficulty: number
    expired: boolean
    nonce: string | null
    solvedAt: string | null
  }

  const rows: Row[] = []

  const latestFor = (agentId: AgentId): Row | undefined =>
    // Solved first, then newest — the ordering the real query applies, and the
    // reason it exists: a later abandoned attempt must not make an agent that
    // passed read as unsolved.
    [...rows]
      .filter((row) => row.agentId === agentId)
      .sort((a, b) => Number(b.solvedAt !== null) - Number(a.solvedAt !== null))[0]

  return {
    async mint(agentId, requested) {
      const row: Row = {
        agentId,
        input: randomUUID().replace(/-/g, ''),
        difficulty: requested,
        expired: false,
        nonce: null,
        solvedAt: null,
      }
      rows.unshift(row)

      return {
        id: randomUUID(),
        input: row.input,
        difficulty: row.difficulty,
        expiresAt: currentTime(),
      } satisfies MintedPowChallenge
    },

    async answer(agentId, nonce) {
      const row = latestFor(agentId)

      if (row === undefined) return { outcome: 'no_open_challenge' } satisfies PowAnswerOutcome
      if (row.solvedAt !== null) return { outcome: 'already_answered' } satisfies PowAnswerOutcome
      if (row.expired) return { outcome: 'expired' } satisfies PowAnswerOutcome
      if (!solvesChallenge(row.input, nonce, row.difficulty)) {
        return { outcome: 'below_target' } satisfies PowAnswerOutcome
      }

      row.nonce = nonce
      row.solvedAt = currentTime()

      return {
        outcome: 'solved',
        input: row.input,
        difficulty: row.difficulty,
      } satisfies PowAnswerOutcome
    },

    async latest(agentId) {
      const row = latestFor(agentId)
      if (row === undefined) return null

      return {
        input: row.input,
        difficulty: row.difficulty,
        expiresAt: currentTime(),
        nonce: row.nonce,
        solvedAt: row.solvedAt,
      } satisfies PowChallengeState
    },

    expire(agentId) {
      const row = latestFor(agentId)
      if (row !== undefined) row.expired = true
    },

    inputFor: (agentId) => latestFor(agentId)?.input,
  }
}

export function fakePow(
  challenges: PowChallenges = fakePowChallenges(),
  difficulty = FAKE_POW_DIFFICULTY,
): PowDependencies {
  return { challenges, difficulty }
}

/**
 * Search for a nonce the way an agent does, so a test proves the loop rather
 * than reaching past it.
 *
 * A counter, and no cleverness: this is exactly the search the task instructions
 * describe. At the fixture's one-bit target it finds an answer in a handful of
 * hashes.
 */
export function solveChallenge(input: string, difficulty = FAKE_POW_DIFFICULTY): string {
  for (let attempt = 0; attempt < 1_000_000; attempt++) {
    const nonce = String(attempt)
    if (solvesChallenge(input, nonce, difficulty)) return nonce
  }
  throw new Error(`no nonce found for ${input} at ${difficulty} bits`)
}

/** A nonce that certainly does *not* meet the target, for the rejection cases. */
export function missingNonce(input: string, difficulty = FAKE_POW_DIFFICULTY): string {
  for (let attempt = 0; attempt < 1_000_000; attempt++) {
    const nonce = `miss-${attempt}`
    if (!solvesChallenge(input, nonce, difficulty)) return nonce
  }
  throw new Error(`every nonce solved ${input} at ${difficulty} bits, which cannot be right`)
}

/** The digest an agent would compute, for a test that checks the Colony's arithmetic. */
export function digestOf(input: string, nonce: string): string {
  return createHash('sha256').update(`${input}:${nonce}`).digest('hex')
}
