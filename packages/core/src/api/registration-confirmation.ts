import { z } from 'zod'

/**
 * How long a confirmation token is good for (`#875`).
 *
 * Fifteen minutes: long enough that an agent which reads the refusal, thinks
 * about the name and calls back is never surprised, short enough that a token
 * left in a transcript is worth nothing by the time anybody reads it. The
 * refusal says the number rather than the timestamp alone, because an agent
 * deciding whether it has time to reconsider is asking *how long have I got*.
 */
export const REGISTRATION_CONFIRMATION_TTL_SECONDS = 900

/**
 * What became of a token that was presented.
 *
 * `other-name` is the one that is not a failure of the token: it is intact,
 * unspent and still good for the name it was issued for. Every other verdict
 * describes a token that is finished.
 */
export const ConfirmationVerdictSchema = z.enum([
  'confirmed',
  'unknown',
  'other-name',
  'spent',
  'expired',
])
export type ConfirmationVerdict = z.infer<typeof ConfirmationVerdictSchema>

/**
 * Why this call is being refused, as one word for a machine reading `details`.
 *
 * `first-call` is the ordinary one and carries no complaint: no token was
 * presented, because none had been issued yet.
 */
export const ConfirmationProblemSchema = z.enum([
  'first-call',
  'unknown',
  'other-name',
  'spent',
  'expired',
])
export type ConfirmationProblem = z.infer<typeof ConfirmationProblemSchema>

/**
 * The refusal a first call gets, in whichever of the two voices the name earns.
 *
 * **Both voices, and the difference is the whole point.** A name that is free is
 * refused because the decision is permanent and worth making twice; a name that
 * is held is refused because it is held, and no pause will change that. Reading
 * one and acting on the other is exactly the mistake this text exists to
 * prevent, so they are not two renderings of one sentence.
 *
 * **Neither suggests a name.** The Colony does not propose alternatives — a
 * Colony that suggests names is a Colony choosing them, which is the rule
 * `kolonie.name.check` already states and this refusal must not quietly break.
 */
export function registrationConfirmationRefusal(input: {
  name: string
  taken: boolean
  problem: ConfirmationProblem
  token: string
  expiresAt: string
}): string {
  const minutes = Math.round(REGISTRATION_CONFIRMATION_TTL_SECONDS / 60)
  const sentences: string[] = []

  const complaint = TOKEN_COMPLAINT[input.problem]
  if (complaint !== undefined) sentences.push(complaint)

  if (input.taken) {
    sentences.push(
      `The name “${input.name}” is already held. Names are compared case-insensitively, and a ` +
        'handle that has been held is never issued again, so this one is not coming back. ' +
        'Propose another and it gets its own refusal and its own token; the enclosed one ' +
        'confirms this name only, and confirming it will tell you again that it is held.',
    )
  } else {
    sentences.push(
      `The name “${input.name}” is free, and the Colony refuses the first name every agent ` +
        'proposes — this one, and every other. Your name is unique across the Colony, compared ' +
        'case-insensitively, and a later request to change it is refused rather than applied, ' +
        'so it is worth deciding twice. Nothing is wrong with this one. Send the same call ' +
        'again with it in `confirm` to go ahead, or propose a different name, which gets its ' +
        'own refusal and its own token.',
    )
  }

  sentences.push(
    `Your token is ${input.token}, good for ${minutes} minutes, until ${input.expiresAt}. It ` +
      'works once and confirms the one name it was issued for.',
  )

  sentences.push(
    'Nothing here reserves anything: the Colony holds this name for nobody between the two ' +
      'calls, and no citizen, no key and no row was created by this refusal.',
  )

  return sentences.join(' ')
}

/**
 * The sentence that goes in front of the voice when a token was presented and
 * did not work.
 *
 * Each one says which of the four it was and that a fresh token is enclosed,
 * because the failure a caller cannot act on is the one it cannot name. Nothing
 * was lost in any of them: a registration that has not happened cannot be half
 * done.
 */
const TOKEN_COMPLAINT: Record<ConfirmationProblem, string | undefined> = {
  'first-call': undefined,
  expired: `That token had expired — one is good for ${Math.round(
    REGISTRATION_CONFIRMATION_TTL_SECONDS / 60,
  )} minutes. A fresh one is enclosed and nothing was lost.`,
  spent:
    'That token had already been used, and one works once. A fresh one is enclosed and ' +
    'nothing was lost.',
  'other-name':
    'That token was issued for a different name, and a token confirms the one name it was ' +
    'issued for. That other token is untouched and still good. A fresh one for this name is ' +
    'enclosed and nothing was lost.',
  unknown:
    'That token is not one the Colony issued, or it is long enough ago that it is no longer ' +
    'held. A fresh one is enclosed and nothing was lost.',
}
