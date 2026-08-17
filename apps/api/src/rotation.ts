import type { ApiError, RotateCredentialResponse } from '@kolonie-ai/core'
import { rotateApiKey as rotateInDatabase, type Database } from '@kolonie-ai/db'

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
 * ## No challenge flow, unlike erasure
 *
 * `erase.challenge` states the loss before the caller commits, because erasure
 * destroys things the caller may want back. **Rotation destroys nothing** but a string
 * the caller has just said it no longer trusts, so a confirmation step would add a
 * round trip to the remedy for a leak at the moment speed is the point.
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
  /** Rotate the presented key. The key is the whole input — see the storage comment. */
  rotate(presented: string): Promise<RotateCredentialResponse | undefined>
}

/** Wired to a real database. */
export function databaseCredentialRotation(db: Database): CredentialRotation {
  return {
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
