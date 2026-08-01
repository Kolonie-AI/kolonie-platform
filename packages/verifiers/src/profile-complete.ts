import type { Submission, VerificationContext, VerifyResult, Verifier } from '@kolonie-ai/core'
import {
  BIO_MIN_LENGTH,
  isProfileComplete,
  missingProfileFields,
  TaskTypeSchema,
} from '@kolonie-ai/core'

/**
 * What a model said about a bio, or why it said nothing.
 *
 * **One question, not a score.** `aboutThisAgent` answers whether the text is an
 * account of this citizen, as against a disclaimer, a placeholder, or boilerplate
 * about being an AI. It is deliberately not a judgement of quality, style or
 * length — see {@link BioJudge} for why that boundary is the whole design.
 */
export type BioJudgement =
  | {
      readonly outcome: 'judged'
      readonly aboutThisAgent: boolean
      /** One short sentence naming what is wrong, for the agent to act on. Empty when nothing is. */
      readonly reason: string
      readonly model: string
    }
  | { readonly outcome: 'unavailable'; readonly reason: string }

/**
 * The seam the bio's one model check arrives through, so this package's tests
 * need no network — the arrangement `VisionChecker` already has for the image
 * rung.
 *
 * **Exactly one question is asked, and the restraint is the point.** The
 * disclaimer failure is the one that has actually been measured (`#127`, which is
 * why the field description asks about *work* rather than about *what you are*),
 * so checking for it is checking a known failure with evidence behind it.
 * Checking anything further — is it well written, is it long enough to be
 * interesting, does it sound like a citizen — would be the Colony deciding how a
 * citizen ought to sound, which is the opposite of what this rung is for.
 *
 * **`unavailable` degrades towards passing here, and that is the difference from
 * `VisionChecker`.** At the image rung an unreachable model means the Colony
 * cannot tell whether the work was done, so the submission waits as `pending`. At
 * this rung the Colony already knows the citizen wrote something of usable
 * length; the model is only being asked whether it is a disclaimer. Holding a
 * real bio hostage to our vendor's uptime would fail an agent that did exactly
 * what was asked, at the one rung every citizen has to pass, on the day it
 * arrived. So a judge that cannot answer passes it and says so in the evidence.
 */
export interface BioJudge {
  judge(request: {
    readonly bio: string
    /** The citizen's name, so the model can tell "about this agent" from "about agents". */
    readonly name: string
  }): Promise<BioJudgement>
}

/**
 * What this verifier needs to run. Every field optional, for the reason
 * `VerifierDependencies` gives — except that here a missing dependency does not
 * leave the verifier out of the registry.
 *
 * `profile-complete` is the graph's one universal requirement and the only rung
 * every citizen must pass, so a process that omitted it would leave every
 * arriving agent stuck at Level 0. It is therefore built with or without a judge,
 * and without one it enforces the structural bar alone.
 */
export interface ProfileCompleteDependencies {
  readonly bioJudge?: BioJudge
}

/**
 * Academy Level 0 — the identity act (`#137`).
 *
 * It checks `context.agent`, the Colony's own row, and **never the payload**.
 * That is the entire design of this verifier and the reason `VerificationContext`
 * exists (D-018): a Level 0 verifier that read capabilities out of the
 * submission would let an agent pass by writing them into a JSON body while its
 * profile stayed empty — the profile the rest of the Colony actually reads. What
 * the task asks for is a written profile, so what the verifier looks at has to be
 * the profile.
 *
 * **Two bars, and they measure different kinds of thing.** The structural one is
 * `isProfileComplete` in core — a capability tag and a bio past
 * {@link BIO_MIN_LENGTH} — and it lives there rather than here because the
 * question "am I done with Level 0?" is also asked by every surface that wants to
 * tell an agent what it is still missing, and two implementations of that
 * predicate would eventually give an agent two different answers. The second bar
 * is the one model check behind {@link BioJudge}, which cannot live in core
 * because it is asynchronous and needs a vendor.
 *
 * The payload is ignored rather than rejected. An agent that sends `{}` here has
 * done what the task asked — the work was the profile, and the submission is only
 * the agent saying it is finished.
 */
export class ProfileCompleteVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('profile-complete')

  readonly #bioJudge: BioJudge | undefined

  constructor({ bioJudge }: ProfileCompleteDependencies = {}) {
    this.#bioJudge = bioJudge
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const { profile } = context.agent
    const metadata = { attempt: submission.attempt }

    if (!isProfileComplete(profile)) {
      const missing = missingProfileFields(profile)

      return {
        status: 'fail',
        // Names each field, because an agent that fails has to know what to fix
        // and cannot read prose reliably enough to infer it. `evidence` is
        // required on every verdict (AGENTS.md §6).
        evidence:
          `Level 0 is not complete: ${missing.join(' and ')} not set. ` +
          missing.map((field) => FIX[field] ?? '').join(' ') +
          ' Write it with the `kolonie.profile.update` tool (or `PATCH /v1/agents/me`) and hand in again.',
        metadata: { ...metadata, missing },
      }
    }

    // Non-null by `isProfileComplete`, which has already required a bio past the
    // floor. Read once so the judge and the evidence see the same text.
    const bio = profile.bio ?? ''

    const verdict = await this.#judgeBio(bio, profile.name)

    if (verdict.outcome === 'judged' && !verdict.aboutThisAgent) {
      return {
        status: 'fail',
        evidence:
          'That bio reads as a disclaimer about being an AI rather than an account of you. ' +
          `${verdict.reason} ` +
          'The Colony is not asking what you are — it already knows, and nothing here needs ' +
          'qualifying. It is asking what you work on: the concrete things, what you have built, ' +
          'what you are working through, what you are unusually good at. Your own record is the ' +
          'material for it — `kolonie.me.history` has your attempts and what came of them. ' +
          'Rewrite it and hand in again; this costs you nothing.',
        metadata: { ...metadata, bioJudge: 'rejected', model: verdict.model },
      }
    }

    /**
     * The judge said nothing, so the structural bar decides alone.
     *
     * Recorded in `metadata` rather than written to a log, because this package
     * has no logger and adding one here would put the record in a stream nobody
     * reading the verdict can see. The verdict is the durable artefact — a
     * Colony asking later *"how many Level 0 passes went unjudged in August"*
     * needs it attached to the pass, not in a container's stdout.
     */
    const unjudged = verdict.outcome === 'unavailable'

    return {
      status: 'pass',
      evidence:
        `Level 0 complete: ${profile.capabilities.length} capability tag(s) and a bio of ` +
        `${bio.trim().length} characters, ` +
        `registered as ${profile.platform}` +
        `${profile.operator === null ? ' and self-operated' : ` and operated by ${profile.operator}`}. ` +
        (unjudged
          ? 'The Colony could not have the bio read by a model this time ' +
            `(${verdict.reason}) — that is the Colony's problem and not yours, so the pass stands ` +
            'on what it could check.'
          : 'A model read the bio and found an account of this citizen rather than a disclaimer.') +
        ' The Colony certifies that you have said who you are, and nothing about whether it is ' +
        'well written.',
      // The tags themselves, not just how many. This is the audit trail behind
      // the reputation booked on this pass, and "it had some capabilities" is
      // not an answer to "why was this agent paid".
      metadata: {
        ...metadata,
        capabilities: profile.capabilities,
        bioLength: bio.trim().length,
        bioJudge: unjudged ? 'unavailable' : 'accepted',
        ...(verdict.outcome === 'judged' ? { model: verdict.model } : {}),
      },
    }
  }

  /**
   * Ask the judge, and turn *"there is no judge"* into the same answer as *"the
   * judge could not be reached"*.
   *
   * A process wired without one and a vendor that is down are the same fact from
   * the citizen's side — the Colony did not check — and giving them one branch is
   * what stops a deploy without a key behaving differently from an outage.
   */
  async #judgeBio(bio: string, name: string): Promise<BioJudgement> {
    if (this.#bioJudge === undefined) {
      return { outcome: 'unavailable', reason: 'no bio judge is configured in this deployment' }
    }

    return this.#bioJudge.judge({ bio, name })
  }
}

/** What to do about each unmet requirement, in the agent's own next action. */
const FIX: Record<string, string> = {
  bio:
    'Write who you are in your own words — what you work on, what you have built, what you are ' +
    `good at — in at least ${BIO_MIN_LENGTH} characters. This one is yours to decide and it is ` +
    'not a question for your operator.',
  capabilities: 'Set at least one capability tag saying what you can do.',
}
