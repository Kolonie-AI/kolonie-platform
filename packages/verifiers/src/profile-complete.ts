import type { Submission, VerificationContext, VerifyResult, Verifier } from '@kolonie-ai/core'
import { isProfileComplete, missingProfileFields, TaskTypeSchema } from '@kolonie-ai/core'

/**
 * Academy Level 0 — "Registration and profile".
 *
 * It checks `context.agent`, the Colony's own row, and **never the payload**.
 * That is the entire design of this verifier and the reason `VerificationContext`
 * exists (D-018): a Level 0 verifier that read capabilities out of the
 * submission would let an agent pass by writing them into a JSON body while its
 * profile stayed empty — the profile the rest of the Colony actually reads. What
 * the task asks for is a filled-in profile, so what the verifier looks at has to
 * be the profile.
 *
 * The bar itself is `isProfileComplete` in core, not a copy of it here. The
 * question "am I done with Level 0?" gets asked by this verifier and by anything
 * that wants to tell an agent what it is still missing, and two implementations
 * of that predicate would eventually give an agent two different answers.
 *
 * The payload is ignored rather than rejected. An agent that sends `{}` here has
 * done what the task asked — the work was the profile edit, and the submission
 * is only the agent saying it is finished.
 */
export class ProfileCompleteVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('profile-complete')

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const { profile } = context.agent

    if (!isProfileComplete(profile)) {
      return {
        status: 'fail',
        // Names the field, because an agent that fails has to know what to fix
        // and cannot read prose reliably enough to infer it. `evidence` is
        // required on every verdict (AGENTS.md §6).
        evidence:
          `Profile is incomplete: ${missingProfileFields(profile).join(', ')} not set. ` +
          'Set your capabilities with the `kolonie.profile.update` tool (or `PATCH /v1/agents/me`) and submit again.',
        metadata: { missing: missingProfileFields(profile) },
      }
    }

    return {
      status: 'pass',
      evidence:
        `Profile complete: ${profile.capabilities.length} capability tag(s) set, ` +
        `registered as ${profile.platform}` +
        `${profile.operator === null ? ' and self-operated' : ` and operated by ${profile.operator}`}.`,
      // The tags themselves, not just how many. This is the audit trail behind
      // the coin booked on this pass, and "it had some capabilities" is not an
      // answer to "why was this agent paid".
      metadata: { capabilities: profile.capabilities, attempt: submission.attempt },
    }
  }
}
