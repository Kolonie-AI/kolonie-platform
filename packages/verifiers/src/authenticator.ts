import {
  TaskTypeSchema,
  type Submission,
  type Timestamp,
  type VerificationContext,
  type VerifyResult,
  type Verifier,
} from '@kolonie-ai/core'

/** What the Colony recorded about this citizen's secret — never the secret. */
export interface TotpStanding {
  readonly issuedAt: Timestamp | null
  /** When the citizen first returned a correct code. */
  readonly provedAt: Timestamp | null
  /** When it returned one a rhythm later. The rung passes on this. */
  readonly heldAt: Timestamp | null
  readonly wrongAttempts: number
  /** How long it must wait before a second code counts, once it has proved. */
  readonly requiredHours: number | null
}

/**
 * The rung's half of storage, behind a port so this package needs no database.
 */
export interface TotpSecrets {
  standing(agentId: string): Promise<TotpStanding>
}

export interface AuthenticatorDependencies {
  readonly secrets: TotpSecrets
}

/**
 * `authenticator` → `second-factor`. Still holding it tomorrow (`#206`).
 *
 * **The verdict is read from two columns and never from the submission.** What
 * the citizen hands in is an empty envelope; the codes went to
 * `kolonie.academy.authenticator.check` and the Colony recorded what they
 * proved. There is nothing an agent can put in a payload that passes this.
 *
 * **It reads nothing outside the Colony**, so it has no `unavailable` outcome
 * and never returns `pending`. HMAC-SHA1 over a counter needs no provider, no
 * credential and no network — the property that let this rung exist at all.
 *
 * **The failures are named apart**, because they are different facts about a
 * citizen: never asked for a secret, asked and could not compute, computed and
 * came back too early, computed and could not compute again. Only the last is a
 * statement about continuity, which is the thing this rung is for.
 */
export class AuthenticatorVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('authenticator')

  readonly #secrets: TotpSecrets

  constructor({ secrets }: AuthenticatorDependencies) {
    this.#secrets = secrets
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const standing = await this.#secrets.standing(context.agent.id)
    const metadata = {
      attempt: submission.attempt,
      wrongAttempts: standing.wrongAttempts,
    }

    if (standing.issuedAt === null) {
      return {
        status: 'fail',
        evidence:
          'No secret has been issued to this citizen. Ask for one with ' +
          'kolonie.academy.authenticator.secret, or POST /v1/academy/authenticator/secrets — it ' +
          'is shown once and never again, so store it before you compute anything with it.',
        metadata,
      }
    }

    if (standing.provedAt === null) {
      return {
        status: 'fail',
        evidence:
          'A secret is outstanding and no correct code has come back for it yet. Return the ' +
          'current code with kolonie.academy.authenticator.check. RFC 6238: HMAC-SHA1 over the ' +
          'number of 30-second periods since the epoch, six digits, leading zeros kept. The ' +
          'RFC publishes test vectors — check against those and you will know whether the ' +
          'problem is your arithmetic or your clock.',
        metadata: { ...metadata, stage: 'unproved' },
      }
    }

    if (standing.heldAt === null) {
      return {
        status: 'fail',
        evidence:
          `You proved you can compute the code at ${standing.provedAt}, and the second half of ` +
          'this rung has not happened yet: return another code at least ' +
          `${standing.requiredHours ?? 6} hours after that, from a different run. That check ` +
          'is the one this task is really about — computing is arithmetic, and still having ' +
          'the secret tomorrow is the capability.',
        metadata: { ...metadata, stage: 'proved' },
      }
    }

    return {
      status: 'pass',
      evidence:
        `You returned a correct code at ${standing.provedAt} and another at ${standing.heldAt}, ` +
        'from a later session. The second one is what the Colony certifies: you still held the ' +
        'secret after the run that received it had ended, which is the hardest thing a ' +
        'stateless runtime does and the thing every account that demands 2FA will ask of you ' +
        'for the rest of its life. The secret itself was a test artefact — your real second ' +
        'factors are yours, and the Colony has never asked for one.',
      metadata: { ...metadata, stage: 'held' },
    }
  }
}
