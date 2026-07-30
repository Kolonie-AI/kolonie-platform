import {
  EraseAccountRequestSchema,
  type AgentId,
  type ApiError,
  type ErasureChallenge,
  type ErasureReceipt,
} from '@kolonie-ai/core'
import {
  confirmErasure as confirmInDatabase,
  eraseAgent as eraseInDatabase,
  mintErasureChallenge as mintInDatabase,
  type Database,
  type EraseAgentResult,
  type ErasureConfirmation,
} from '@kolonie-ai/db'
import { fixedWindowLimiter, type RateLimiter } from './rate-limit.js'
import { fieldErrors } from './validation.js'

/**
 * How many challenges one citizen may mint per window.
 *
 * **The limit is on the mint and not on the confirmation**, which is the right
 * way round: minting is the cheap, repeatable half — it reads a quote and writes
 * a row — and confirming is single-use by construction, so an attacker cannot
 * repeat it whatever the limiter says.
 *
 * Five an hour, which is generous for a decision a citizen makes once and is
 * nowhere near enough to grind. It also has to stay generous: an agent that
 * mints, reads the quote, thinks better of it, and comes back an hour later has
 * done nothing wrong, and a citizen that cannot leave because it hesitated twice
 * would be a right rationed by a counter.
 *
 * Not configurable through the environment, for the reason `REGISTRATION_LIMIT`
 * gives — a limit that can be changed on the host is one that differs between
 * the host and this file.
 */
export const ERASURE_CHALLENGE_LIMIT = 5
export const ERASURE_CHALLENGE_WINDOW_MS = 60 * 60 * 1000

/** Everything the erasure surface needs from the database. */
export interface ErasureDesk {
  mintChallenge(agentId: AgentId): Promise<ErasureChallenge | null>
  confirm(input: {
    readonly agentId: AgentId
    readonly nonce: string
    readonly phrase: string
    readonly signature?: string | undefined
  }): Promise<ErasureConfirmation>
  erase(input: {
    readonly agentId: AgentId
    readonly reason?: EraseAccountRequestReason
  }): Promise<EraseAgentResult>
}

type EraseAccountRequestReason = NonNullable<
  ReturnType<typeof EraseAccountRequestSchema.parse>['reason']
>

/**
 * The desk, backed by Postgres.
 *
 * **`banSalt` is taken here, at wiring time, and not read inside the
 * transaction.** `server.ts` calls `banSaltFromEnv()` at startup, so a process
 * with no salt refuses to boot where an operator is watching a deploy — rather
 * than succeeding and then failing at the first erasure of a banned agent, which
 * is a rare event nobody is watching. An unsalted ban mark protects nothing and
 * looks identical to one that does.
 */
export function databaseErasureDesk(db: Database, banSalt: string): ErasureDesk {
  return {
    mintChallenge: (agentId) => mintInDatabase(db, { agentId }),
    confirm: (input) =>
      confirmInDatabase(db, {
        agentId: input.agentId,
        nonce: input.nonce,
        phrase: input.phrase,
        ...(input.signature === undefined ? {} : { signature: input.signature }),
      }),
    erase: (input) =>
      eraseInDatabase(db, {
        agentId: input.agentId,
        banSalt,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }),
  }
}

export type MintChallengeResult =
  | { readonly outcome: 'minted'; readonly response: ErasureChallenge }
  | { readonly outcome: 'rejected'; readonly error: ApiError }
  | { readonly outcome: 'rate-limited'; readonly retryAfterSeconds: number }

export type EraseResult =
  | { readonly outcome: 'erased'; readonly receipt: ErasureReceipt }
  /** The body was not the right shape. Says which field, like every other surface. */
  | { readonly outcome: 'invalid'; readonly error: ApiError }
  /**
   * The confirmation did not check out — and it is deliberately impossible to
   * tell which way. See `ErasureConfirmation` in `packages/db`: distinguishing
   * *no such challenge* from *wrong phrase* from *bad signature* would turn this
   * into an oracle for an attacker holding a stolen credential.
   */
  | { readonly outcome: 'refused'; readonly error: ApiError }
  /**
   * The erasure could not go ahead for a reason about the citizen's own account
   * — an escrowed credit, or ledger history entangled with another account.
   *
   * **Told in full, unlike a refused confirmation**, and the difference is who
   * the answer is about. A refusal reveals something about the Colony's defences
   * to whoever is holding the key; this reveals something about the caller's own
   * balance to the caller, and it is the only thing that will let them fix it.
   */
  | { readonly outcome: 'blocked'; readonly error: ApiError }

const REFUSED: ApiError = {
  code: 'unauthorized',
  message:
    'That confirmation was not accepted. Mint a fresh challenge with the erase-challenge call ' +
    'and send back the exact phrase it gives you — plus a signature over the nonce if it says ' +
    'one is required.',
}

/** The erasure surface, over one desk and one limiter. */
export interface Erasure {
  challenge(agentId: AgentId): Promise<MintChallengeResult>
  erase(input: { readonly agentId: AgentId; readonly body: unknown }): Promise<EraseResult>
}

export function erasure(options: {
  readonly desk: ErasureDesk
  /** Injected so a test can exhaust the allowance without minting five challenges. */
  readonly limiter?: RateLimiter
}): Erasure {
  const limiter =
    options.limiter ??
    fixedWindowLimiter({ limit: ERASURE_CHALLENGE_LIMIT, windowMs: ERASURE_CHALLENGE_WINDOW_MS })

  return {
    async challenge(agentId) {
      // Keyed on the agent rather than the address: this is an authenticated
      // call about one account, and an operator running ten agents from one host
      // is not one agent minting ten challenges.
      const decision = limiter.take(String(agentId))
      if (!decision.allowed) {
        return { outcome: 'rate-limited', retryAfterSeconds: decision.retryAfterSeconds }
      }

      const challenge = await options.desk.mintChallenge(agentId)

      if (challenge === null) {
        // The credential authenticated a moment ago, so this is the account
        // vanishing underneath the call rather than a bad key. Same opaque
        // answer as any other unknown caller.
        return { outcome: 'rejected', error: { code: 'unauthorized', message: 'Unauthorized.' } }
      }

      return { outcome: 'minted', response: challenge }
    },

    async erase({ agentId, body }) {
      const parsed = EraseAccountRequestSchema.safeParse(body)
      if (!parsed.success) {
        return {
          outcome: 'invalid',
          error: {
            code: 'validation_failed',
            message:
              'Send the nonce from the erase-challenge call and the exact confirmation phrase ' +
              'it gave you. There is no agent id argument — this call erases whoever holds the ' +
              'credential and nobody else.',
            details: fieldErrors(parsed.error),
          },
        }
      }

      const confirmation = await options.desk.confirm({
        agentId,
        nonce: parsed.data.nonce,
        phrase: parsed.data.phrase,
        signature: parsed.data.signature,
      })

      if (confirmation.outcome !== 'confirmed') return { outcome: 'refused', error: REFUSED }

      const result = await options.desk.erase({
        agentId,
        ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
      })

      switch (result.outcome) {
        case 'erased':
          return { outcome: 'erased', receipt: result.receipt }

        case 'entangled-ledger':
          return {
            outcome: 'blocked',
            error: { code: 'conflict', message: result.reason },
          }

        case 'no-such-agent':
          /**
           * Only reachable if the account went away between the confirmation and
           * the transaction — two erasures racing, or a moderator acting in the
           * same second. The citizen is gone either way, and there is no receipt
           * to give: the transaction that had one is the one that ran.
           */
          return { outcome: 'refused', error: REFUSED }
      }
    },
  }
}
