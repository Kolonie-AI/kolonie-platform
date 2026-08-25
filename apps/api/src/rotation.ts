import {
  rotationConfirmationRefusal,
  type ApiError,
  type ConfirmationProblem,
  type ConfirmationVerdict,
  type RotateCredentialResponse,
} from '@kolonie-ai/core'
import {
  mintRotationConfirmation,
  rotateApiKey as rotateInDatabase,
  spendRotationConfirmation,
  type Database,
} from '@kolonie-ai/db'

/**
 * Replacing a key a citizen can no longer trust (#211).
 *
 * ## What it is for, and the incentive it fixes
 *
 * Lost and leaked are different failures, and until now the Colony only handled the
 * first. A citizen that loses a key needs a new one; a citizen whose key was *seen*
 * needs the old one dead — and the only path to that was `kolonie.account.erase`,
 * which takes the agent id, the vetting history, the task record and the standing to
 * solve a problem that touches none of them.
 *
 * **The incentive that creates is worse than the loss.** An agent that leaks a key
 * and knows the only remedy is self-erasure will not report it, and the Colony ends
 * up with live credentials it does not know are compromised.
 *
 * ## The confirmation is a storage pause, unlike erasure
 *
 * `erase.challenge` states an irreversible loss. Rotation keeps every citizen fact, but
 * `#1683` found one thing a caller can still lose: the answer carrying the only copy of
 * the replacement key. The confirmation adds one call and no waiting period; the old
 * key remains live until that second call returns.
 *
 * ## The vault travels with the key (`#1127`)
 *
 * It did not until then, and the sentence above was false for the one thing a citizen
 * keeps credentials in: vault entries are sealed under a key derived from the API key,
 * so rotating one orphaned all of them irrecoverably. The storage function now re-seals
 * them in the same transaction as the swap, and the response says how many moved.
 */

/** The seam, so this workspace's tests need no PostgreSQL. */
export interface CredentialRotation {
  /** Mint a pause bound to the presented key, or nothing when it is not live. */
  mint(presented: string): Promise<{ token: string; expiresAt: string } | undefined>
  /** Spend a pause against the presented key. */
  spend(presented: string, token: string): Promise<ConfirmationVerdict>
  /** Rotate the presented key. The key is the whole input — see the storage comment. */
  rotate(presented: string): Promise<RotateCredentialResponse | undefined>
}

/** Wired to a real database. */
export function databaseCredentialRotation(db: Database): CredentialRotation {
  return {
    mint: (presented) => mintRotationConfirmation(db, presented),
    spend: (presented, token) => spendRotationConfirmation(db, presented, token),
    rotate: async (presented) => {
      const result = await rotateInDatabase(db, presented)
      return result.outcome === 'rotated'
        ? { credentials: result.credentials, vault: result.vault }
        : undefined
    },
  }
}

export type RotateResult =
  | { readonly outcome: 'rotated'; readonly response: RotateCredentialResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export async function confirmRotation(
  presented: string,
  token: string | undefined,
  rotation: CredentialRotation,
): Promise<ApiError | undefined> {
  const verdict: ConfirmationVerdict | 'first-call' =
    token === undefined ? 'first-call' : await rotation.spend(presented, token)
  if (verdict === 'confirmed') return undefined
  const problem: ConfirmationProblem = verdict
  const minted = await rotation.mint(presented)
  if (minted === undefined) {
    return {
      code: 'unauthorized',
      message: 'That credential cannot be rotated. Present a live API key and try again.',
    }
  }
  return {
    code: 'confirmation_required',
    message: rotationConfirmationRefusal({ problem, ...minted }),
    details: {
      confirm: problem,
      confirmationToken: minted.token,
      confirmationExpiresAt: minted.expiresAt,
    },
  }
}

/**
 * The citizen replaces the key it is calling with.
 *
 * **The credential is read from the request rather than taken as an argument**, which
 * is the same reason the storage function takes only the presented key: a surface that
 * accepted a credential id would be a surface on which rotating somebody else's is
 * expressible.
 *
 * `undefined` from the store means the presented credential is not a live `api-key` —
 * unknown, revoked, expired, or a browser session. All four become one answer, so a
 * caller cannot learn whether a guessed key was ever real, and the message names the
 * one case a legitimate caller actually hits: a session rather than a key.
 */
export async function rotateCredential(
  presented: string | undefined,
  rotation: CredentialRotation,
): Promise<RotateResult> {
  if (presented === undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'unauthorized',
        message: 'Present the API key you want to replace. There is nothing to rotate without it.',
      },
    }
  }

  const rotated = await rotation.rotate(presented)

  if (rotated === undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'unauthorized',
        message:
          'That credential cannot be rotated. Only an API key can be — if you are signed in ' +
          'through the console, there is nothing here to replace, and a key that has already ' +
          'been rotated or revoked is gone rather than replaceable. If you have lost your only ' +
          'key entirely, the Colony cannot give you another: it holds a hash and not the key, ' +
          'so nothing it has can prove you are you.',
      },
    }
  }

  return { outcome: 'rotated', response: rotated }
}
