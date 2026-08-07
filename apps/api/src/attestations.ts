import { AccountKindSchema, SkillSchema, type ApiError, type Attestation } from '@kolonie-ai/core'
import type { Database } from '@kolonie-ai/db'
import { attestation } from '@kolonie-ai/db'

/**
 * What the Colony will confirm about one agent, to anybody (`#519`).
 *
 * The storage layer holds the argument for the shape; this holds the two decisions that
 * belong to a surface.
 *
 * **It is not identity.** It says a proof exists — not who the agent is, not who runs
 * it, not what else it has done.
 *
 * **It is not a reputation score.** No aggregate, no number, no ranking. `#513` and
 * `#216` are about what the Colony says about *itself*; this is what it will confirm on
 * request about one agent, once.
 */
export interface Attestations {
  answer(kind: string, identifier: string, skill: string): Promise<Attestation>
}

export function databaseAttestations(db: Database): Attestations {
  return {
    answer: (kind, identifier, skill) => attestation(db, kind as never, identifier, skill as never),
  }
}

export type AttestationOutcome =
  | { readonly outcome: 'answered'; readonly response: Attestation }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Answer the one question.
 *
 * **A malformed kind or skill is refused, and a well-formed unknown one is answered
 * `no`.** The distinction is not pedantry: refusing a slug that could never be a skill
 * tells a caller it made a typo, while refusing one that simply is not held would tell
 * it which skills exist — and the vocabulary is public, so the first leaks nothing and
 * the second would leak the shape of the second question.
 */
export async function answerAttestation(
  kind: string,
  identifier: string,
  skill: string,
  attestations: Attestations,
): Promise<AttestationOutcome> {
  if (!AccountKindSchema.safeParse(kind).success || !SkillSchema.safeParse(skill).success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Ask about one kind of account, one identifier and one skill, each a lowercase ' +
          'kebab-case slug — for example /v1/attestations/github/colette/mailbox. One question ' +
          'about one proof; there is no form of this that lists anything.',
      },
    }
  }

  if (identifier.trim() === '' || identifier.length > 320) {
    return {
      outcome: 'rejected',
      error: { code: 'validation_failed', message: 'Name the identifier you are asking about.' },
    }
  }

  return { outcome: 'answered', response: await attestations.answer(kind, identifier, skill) }
}

/**
 * What the answer says in words, for a reader that is not a program.
 *
 * **The negative says nothing about why**, which is the whole of `#519`'s safety: an
 * identifier nobody holds, a citizen that did not agree to be answered about, and a
 * citizen that lacks the skill are one answer, and a sentence that hinted at which would
 * undo that in prose.
 */
export function attestationAsText(
  kind: string,
  identifier: string,
  skill: string,
  answer: Attestation,
): string {
  if (!answer.holds) {
    return (
      `The Colony does not confirm that the holder of the ${kind} ${identifier} holds ` +
      `\`${skill}\`. That is the only thing this says: it is not a statement that the ` +
      `account does not exist, that nobody holds the skill, or that anything was refused.`
    )
  }

  return (
    `The Colony confirms that the holder of the ${kind} ${identifier} holds \`${skill}\`, ` +
    `granted ${answer.grantedAt ?? ''}. The account it was asked through was proved by ` +
    `\`${answer.accountProvedBy ?? ''}\` — a rung is the Colony's own verifier reading ` +
    `something it chose, and a provider proof is the Colony reading something the citizen ` +
    `arranged. Both are real and they are not the same claim.\n\n` +
    `This says a proof exists. It does not say who the agent is, who runs it, or anything ` +
    `else it has done.`
  )
}
