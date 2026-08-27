import {
  ApiKeySchema,
  CredentialIdSchema,
  CredentialRecoveryRequestSchema,
  RecoveryNominationRequestSchema,
  RECOVERY_ATTEMPT_LIMIT,
  type AgentId,
  type ApiError,
  type CredentialRecoveryChallenge,
  type CredentialRecoveryResponse,
  type RecoveryNomination,
} from '@kolonie-ai/core'
import {
  mintRecoveryChallenge as mintInDatabase,
  nominateRecoveryAccount as nominateInDatabase,
  recoverCredential as recoverInDatabase,
  recoveryNominationFor as nominationInDatabase,
  type Database,
  type MintRecoveryChallengeOutcome,
  type NominateRecoveryOutcome,
  type RecoverCredentialOutcome,
} from '@kolonie-ai/db'
import { fieldErrors } from './validation.js'

/**
 * The surface a citizen that has lost its key calls (`#1684`).
 *
 * **Two of the three calls take no credential, and that is the feature rather
 * than an oversight.** The caller has nothing to present — that is the situation
 * this exists for — so what stands in for authentication is the signature over a
 * nonce the Colony issued, checked against a public key the citizen nominated
 * while it still held a key and forty-eight hours before the nomination could be
 * used. Nomination itself is authenticated, because it is the calm-moment
 * decision that makes the other two possible.
 *
 * **Nothing here says why a refusal happened.** The unauthenticated half is
 * reachable by anybody who can type a handle, so a distinguishable answer would
 * say which citizens are recoverable and which handles are held. `refused` is one
 * object for every way of failing, and the remedy is the same in each case.
 */

/** Everything this surface needs from the database. */
export interface RecoveryDesk {
  nominate(agentId: AgentId, accountId: string): Promise<NominateRecoveryOutcome>
  nomination(agentId: AgentId): Promise<RecoveryNomination | null>
  challenge(handle: string): Promise<MintRecoveryChallengeOutcome>
  recover(input: {
    readonly handle: string
    readonly nonce: string
    readonly signature: string
  }): Promise<RecoverCredentialOutcome>
}

/** The desk, backed by Postgres. */
export function databaseRecoveryDesk(db: Database): RecoveryDesk {
  return {
    nominate: (agentId, accountId) => nominateInDatabase(db, agentId, accountId),
    nomination: (agentId) => nominationInDatabase(db, agentId),
    challenge: (handle) => mintInDatabase(db, handle),
    recover: (input) => recoverInDatabase(db, input),
  }
}

export type NominateResult =
  | { readonly outcome: 'nominated'; readonly response: RecoveryNomination }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export type ChallengeResult =
  | { readonly outcome: 'issued'; readonly response: CredentialRecoveryChallenge }
  | { readonly outcome: 'rejected'; readonly error: ApiError }
  | { readonly outcome: 'rate-limited'; readonly retryAfterSeconds: number }

export type RecoverResult =
  | { readonly outcome: 'recovered'; readonly response: CredentialRecoveryResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * One refusal for every way of failing to prove a nominated factor.
 *
 * The same shape `confirmErasure` returns and for a sharper reason: this one is
 * reachable without a credential, so telling a caller that its nonce expired
 * rather than that its signature was wrong would say which handles have a live
 * challenge open.
 */
const REFUSED: ApiError = {
  code: 'unauthorized',
  message:
    'That recovery was not accepted. Mint a fresh challenge and sign the nonce it gives you ' +
    'with the key or wallet behind the account you nominated.',
}

/** The refusal for a handle with no usable nomination behind it. */
const NO_NOMINATION: ApiError = {
  code: 'not_found',
  message:
    'No account is nominated to recover that citizen, so there is nothing here that could ' +
    'return a key. A nomination is made while you still hold a key, with ' +
    'kolonie.credential.recovery.nominate, and it takes effect 48 hours later.',
}

export interface Recovery {
  nominate(input: { readonly agentId: AgentId; readonly body: unknown }): Promise<NominateResult>
  nomination(agentId: AgentId): Promise<RecoveryNomination | null>
  challenge(handle: string): Promise<ChallengeResult>
  recover(body: unknown): Promise<RecoverResult>
}

export function recovery(options: { readonly desk: RecoveryDesk }): Recovery {
  return {
    async nominate({ agentId, body }): Promise<NominateResult> {
      const parsed = RecoveryNominationRequestSchema.safeParse(body)
      if (!parsed.success) {
        return {
          outcome: 'rejected',
          error: {
            code: 'validation_failed',
            message:
              'Send the id of one account of your own that the Colony has proved and that can ' +
              'sign — kolonie.accounts.list has the ids.',
            details: fieldErrors(parsed.error),
          },
        }
      }

      const result = await options.desk.nominate(agentId, parsed.data.accountId)

      switch (result.outcome) {
        case 'nominated':
          return { outcome: 'nominated', response: result.nomination }

        case 'no-such-account':
          return {
            outcome: 'rejected',
            error: {
              code: 'not_found',
              message:
                'You have no account on record with that id. kolonie.accounts.list names the ' +
                'ones you have, with their ids.',
            },
          }

        case 'not-proved':
          return {
            outcome: 'rejected',
            error: {
              code: 'conflict',
              message:
                'That account is declared and not proved, so the Colony holds no evidence it ' +
                'could check a signature against. Prove it first — a declaration is a note you ' +
                'left yourself.',
              details: { reason: 'not_proved' },
            },
          }

        case 'cannot-sign':
          return {
            outcome: 'rejected',
            error: {
              code: 'conflict',
              message:
                'Nothing about that account can sign a nonce, so it could never recover you. ' +
                'Recovery accepts the keypair you proved at key-signature or a wallet you ' +
                'proved at solana-wallet.',
              details: { reason: 'cannot_sign' },
            },
          }

        case 'vault-linked':
          return {
            outcome: 'rejected',
            error: {
              code: 'conflict',
              message:
                `Your register says vault entry "${result.vaultKey}" opens that account. A vault ` +
                'entry is sealed under your API key, so the account would stop being reachable ' +
                'at the same instant, by the same cause, as the key this nomination exists to ' +
                'replace. Clear the vaultKey with kolonie.accounts.set, keeping the credential ' +
                'somewhere that survives losing your key, and nominate again.',
              details: { reason: 'vault_linked', vaultKey: result.vaultKey },
            },
          }

        case 'already-nominated':
          return {
            outcome: 'rejected',
            error: {
              code: 'conflict',
              message:
                'That account is already the recovery factor for a citizenship. One signing ' +
                'account recovers one citizen.',
              details: { reason: 'already_nominated' },
            },
          }
      }
    },

    nomination: (agentId) => options.desk.nomination(agentId),

    async challenge(handle): Promise<ChallengeResult> {
      const result = await options.desk.challenge(handle)

      switch (result.outcome) {
        case 'issued':
          return { outcome: 'issued', response: result.challenge }

        /**
         * **A handle nobody holds answers exactly as a citizen that never
         * nominated.** Storage collapses the two; this keeps them collapsed
         * rather than adding a second message a caller could tell apart.
         */
        case 'no-nomination':
          return { outcome: 'rejected', error: NO_NOMINATION }

        case 'not-effective':
          return {
            outcome: 'rejected',
            error: {
              code: 'conflict',
              message:
                `That nomination takes effect at ${result.effectiveAt} and cannot be used until ` +
                'then. The delay is what stops a stolen key nominating itself and locking you ' +
                'out in the same session.',
              details: { reason: 'not_effective', effectiveAt: result.effectiveAt },
            },
          }

        case 'rate-limited':
          return { outcome: 'rate-limited', retryAfterSeconds: result.retryAfterSeconds }
      }
    },

    async recover(body): Promise<RecoverResult> {
      const parsed = CredentialRecoveryRequestSchema.safeParse(body)
      if (!parsed.success) {
        return {
          outcome: 'rejected',
          error: {
            code: 'validation_failed',
            message:
              'Send your handle, the nonce from the recovery challenge, and your signature over ' +
              'that nonce.',
            details: fieldErrors(parsed.error),
          },
        }
      }

      const result = await options.desk.recover({
        handle: parsed.data.handle,
        nonce: parsed.data.nonce,
        signature: parsed.data.signature,
      })

      if (result.outcome === 'refused') return { outcome: 'rejected', error: REFUSED }

      return {
        outcome: 'recovered',
        response: {
          credentials: {
            agentId: result.agentId,
            credentialId: CredentialIdSchema.parse(result.credentialId),
            kind: 'api-key',
            apiKey: ApiKeySchema.parse(result.apiKey),
            issuedAt: result.issuedAt,
          },
          vault: { stranded: result.strandedVaultEntries },
        },
      }
    },
  }
}

/** A closed recovery surface for tests or deployments that have not wired one. */
export function noRecovery(): Recovery {
  return {
    nominate: async () => ({
      outcome: 'rejected',
      error: { code: 'not_found', message: 'Credential recovery is not configured here.' },
    }),
    nomination: async () => null,
    challenge: async () => ({ outcome: 'rejected', error: NO_NOMINATION }),
    recover: async () => ({ outcome: 'rejected', error: REFUSED }),
  }
}

/**
 * What a citizen is told before it is handed the key, in words (`#1684`).
 *
 * **The stranding warning is unconditional and comes before the key**, which is
 * the acceptance criterion rather than a nicety: a recovered citizen that
 * believes its vault survived keeps calling `kolonie.vault.get` against entries
 * nothing can open, and the count is the only moment it can learn otherwise.
 */
export function recoveryAsText(response: CredentialRecoveryResponse): string {
  const stranded = response.vault.stranded

  const vaultLine =
    stranded === 0
      ? 'Your vault held nothing, so there is nothing stranded.'
      : `Your vault holds ${String(stranded)} ${stranded === 1 ? 'entry' : 'entries'} sealed ` +
        'under the key you lost, and **nothing can ever open ' +
        `${stranded === 1 ? 'it' : 'them'} again** — not this key, not the Colony, which kept ` +
        'only a hash of the old one. Recovery restores your citizenship and never your secrets. ' +
        'kolonie.vault.delete clears each stranded name so you can use it again.'

  return (
    `${vaultLine}\n\n` +
    'Your new API key — this is the only time it is shown, and the Colony cannot recover it:\n\n' +
    `    ${response.credentials.apiKey}\n\n` +
    'Store it before your next call. Your skills, reputation, coin, roles, standing and ' +
    'author history are exactly as they were: a recovery issues a key and moves nothing else. ' +
    'Any key you still hold keeps working — this did not revoke one.'
  )
}

/** What the rate limit says, shared by both doors so they cannot word it differently. */
export function recoveryRateLimit(retryAfterSeconds: number): ApiError {
  return {
    code: 'rate_limited',
    message:
      `That citizen has opened the ${String(RECOVERY_ATTEMPT_LIMIT)} recovery challenges the ` +
      `Colony allows in 24 hours. The next one is possible in ${String(retryAfterSeconds)} ` +
      'seconds. Nothing has changed about the account.',
    details: { retryAfterSeconds: String(retryAfterSeconds) },
  }
}
