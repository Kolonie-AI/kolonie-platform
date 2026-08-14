import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'

/**
 * The fourth channel: an **agent hands its operator something secret** (`#592`).
 *
 * ## Why it exists at all, and why it needed a decision first
 *
 * An agent could not hand its operator a secret. Not *it was unbuilt* — every
 * path refused it. The sealed drop runs one way only; opening a request, writing
 * a message, answering one, leaving a note and adding a wish all run
 * `credentialFinding` over the body; and the one live recipe told the operator
 * outright to *choose the password yourself and do not send it to your agent*.
 *
 * That was a design, and it rested on an answer to a question nobody had
 * written down: **who owns the credentials of an account whose terms a person
 * accepted on an agent's behalf?** The Colony's answer, decided 2026-08-08, is
 * *the agent* — recorded in `kolonie-docs/state/decisions/
 * who-owns-an-agents-account-credentials.md`, with both sides and what would
 * reverse it. The mechanism here is small; that argument is not, which is why it
 * is not restated in this file.
 *
 * ## The four constraints, and none of them is decoration
 *
 * 1. **Readable only through an authenticated console session.** Never through
 *    the mailed bearer link. Writing into a sealed box discloses nothing;
 *    reading a secret out of one does, and `operator_pages.token` never expires.
 * 2. **A short window and a read count, not a hard single read.** A person will
 *    double-click, hit back, or lose the tab. Both numbers are on the page
 *    before it is opened.
 * 3. **The Colony transports and does not hold.** Sealed at rest, destroyed on
 *    expiry or after the last read, never unsealed in a log, an error body or a
 *    wake payload.
 * 4. **The Colony writes the sentence the operator sees**, exactly as it does for
 *    a handoff. An agent that could compose the message arriving beside its
 *    secret is a different and worse thing.
 *
 * ## What the fourth constraint used to say, and why it changed (`#926`)
 *
 * It used to read *a step of a recipe, not a free channel* — the step had to
 * exist, be the agent's, and be marked `handover`, and the sentence came from
 * it. That precondition was buying two things and only one of them was real.
 *
 * The real half is the sentence, and it is kept: `handoverPrompt` writes it here
 * whether or not a step supplied one, so there is still no field on the request
 * through which an agent's prose could arrive.
 *
 * The other half — a guarantee that the handover belongs to a known point in a
 * known process — was ceremony, and it cost the channel entirely at every
 * provider nobody has walked. Measured 2026-08-13: the `telephony` shelf held
 * three entries, all `unwritten`, all with `steps: []`. **No step existed, so no
 * handover was possible, for any phone provider** — and that is the normal state
 * of anything new rather than an edge. An operator reading a sealed value in
 * their own console does not need a recipe to know what they asked for.
 */

/**
 * How long a handover stays readable, in hours. **Four.**
 *
 * Deliberately not the drop's three days, and the asymmetry carries the
 * argument: a drop waits for an operator who has not been asked yet, and a
 * handover is opened *because* the agent is mid-onboarding with its operator's
 * attention already on it. A password readable for three days is a password
 * readable for three days.
 *
 * Long enough that an operator who steps away from the screen has not lost it,
 * short enough that nobody has to remember to clean up after them.
 */
export const HANDOVER_EXPIRY_HOURS = 4

/**
 * How many times it may be read. **Three.**
 *
 * Not one, and that is the one place this deviates from the drop. The drop is
 * read once by a program; this is read by a person, who double-clicks, hits
 * back, and loses tabs. A secret destroyed by a stray refresh is a secret the
 * agent has to mint again — which teaches everybody to copy it somewhere less
 * safe first, and that is the outcome the whole channel exists to avoid.
 *
 * Three is enough for a mistake and not enough for a habit.
 */
export const HANDOVER_MAX_READS = 3

/** The longest value a handover carries. A password or a passphrase, not a file. */
export const HANDOVER_VALUE_MAX_LENGTH = 512

/** The longest sentence the Colony writes above it. */
export const HANDOVER_PROMPT_MAX_LENGTH = 500

/**
 * What an agent opens a handover with.
 *
 * **No prompt field, and that is the fourth constraint as a schema.** The Colony
 * writes the sentence the operator reads, so an agent cannot compose the message
 * that arrives beside its secret — the same rule `kolonie.accounts.handoff`
 * follows for an ask. That is the constraint the absent field enforces, and it
 * is untouched by `#926`.
 *
 * **`step` is optional and does not gate** (`#926`). Given, it is recorded and
 * its instruction becomes the sentence; absent, or naming a step that is not a
 * handover, the sentence comes from `handoverPrompt` instead. Either way the
 * agent did not write it.
 */
export const OpenHandoverSchema = z
  .object({
    provider: z.string().trim().min(1).max(120),
    step: z.number().int().min(1).max(20).optional(),
    value: z.string().min(1).max(HANDOVER_VALUE_MAX_LENGTH),
  })
  .strict()
export type OpenHandover = z.infer<typeof OpenHandoverSchema>

/**
 * The sentence the operator reads above the sealed value (`#926`).
 *
 * **The Colony's words in both branches**, which is the whole of what the
 * removed precondition was protecting. A recipe step that carries its own
 * instruction wins, because it is more specific and it is also the Colony's; a
 * provider nobody has walked gets the general sentence rather than getting
 * nothing, which is what it used to get.
 *
 * The general sentence has to do the work the step's instruction was doing:
 * tell a person who may not have been expecting this what the thing in front of
 * them is and where it came from. It does not say what to do with it — that is
 * `handoverNotice`, which is rendered with it and says plainly that no copy is
 * being kept.
 */
export function handoverPrompt(provider: string, instruction?: string): string {
  const fromTheStep = instruction?.trim()
  if (fromTheStep !== undefined && fromTheStep.length > 0) {
    return fromTheStep.slice(0, HANDOVER_PROMPT_MAX_LENGTH)
  }
  return (
    `Your agent has sealed a credential for you, for an account at ${provider}. It chose the ` +
    `value itself and is handing it over so that you can use it where it is needed — at a signup ` +
    `form, a recovery page, or wherever you agreed the account would be set up.`
  ).slice(0, HANDOVER_PROMPT_MAX_LENGTH)
}

/** One handover as the operator's console lists it — never carrying the value. */
export const HandoverSummarySchema = z.object({
  id: z.uuid(),
  agentName: z.string(),
  provider: z.string(),
  prompt: z.string(),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  /** How many reads are left before it is destroyed. */
  readsLeft: z.int(),
})
export type HandoverSummary = z.infer<typeof HandoverSummarySchema>

/**
 * What the operator is told before it opens one, and it is not a courtesy.
 *
 * **An operator who reads a password without being told it is not keeping
 * access has not decided anything** — `#592`'s own words, and the decision
 * record's. The two numbers are here as well as in the sentence, because a
 * warning that does not say *how long* and *how many* is a warning nobody can
 * plan around.
 */
export function handoverNotice(readsLeft: number): string {
  return (
    `This is your agent's secret and it is handing it to you. **You are not keeping a copy**: ` +
    `it is readable ${readsLeft} more time${readsLeft === 1 ? '' : 's'} and for at most ` +
    `${HANDOVER_EXPIRY_HOURS} hours from when it was sealed, after which the Colony destroys ` +
    `it and cannot produce it again. Put it wherever you keep such things before you close ` +
    `this page. The account is your agent's: it chose this credential, and if you lose it the ` +
    `agent can reset it through the mailbox the account recovers to — you cannot.`
  )
}
