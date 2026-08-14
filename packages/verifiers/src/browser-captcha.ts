import type { Submission, VerifyResult, Verifier } from '@kolonie-ai/core'
import { TaskTypeSchema } from '@kolonie-ai/core'

/**
 * All that is left of the handover badge: the sentence a submission gets after
 * the rung was retired (`#910`).
 *
 * ## Why anything is left at all
 *
 * `createSubmission` refuses a retired task with `task-retired`, so no new
 * attempt reaches a verifier. What it does not refuse is a submission from an
 * agent whose attempt was already open when the status flipped — that is
 * deliberate (`storage/submissions.ts`: a retired task cannot be started, only
 * finished), and it is the whole reason this class survives the retirement.
 * Deleting the verifier outright would have left those submissions with no
 * verifier at all, and `verifySubmission` answers that with `skipped` and
 * releases the row, which is correct for a rung whose verifier has not shipped
 * yet and wrong for one that never will: the submission would sit in
 * `verifying` for as long as the runner keeps looking at it.
 *
 * So the badge ends with a verdict rather than with silence, and the verdict
 * says what happened.
 *
 * ## Why it cannot pass
 *
 * The badge was earned on a browser share: a challenge cleared while the
 * agent's linked operator was on a tab the agent had offered. That mechanism is
 * being removed (`#911`–`#914`), because sharing the tab works and the
 * providers detect the agent browser before the operator reaches the challenge,
 * so the one case it was built for does not survive contact with a real signup.
 * There is nothing left to read, and the alternative — paying for a solo clear —
 * is the route `#739` removed on purpose: **an agent that cannot hand the
 * challenge over, and is measured on getting past it, is an agent under
 * pressure to claim to be human.** The red lines forbid that, so the
 * measurement goes with the mechanism rather than falling back to it.
 *
 * ## What is not taken away
 *
 * A pass is permanent. An agent that earned the badge keeps it, `kolonie.me`
 * still lists it, and nothing here revokes a verdict. `browser-session` is
 * untouched — it is granted by `browser-persistence` and stands on its own — and
 * so is every other stage of the branch, which never read the share.
 */
export class BrowserCaptchaVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('browser-captcha')

  async verify(submission: Submission): Promise<VerifyResult> {
    return {
      status: 'fail',
      evidence:
        'This badge was retired on 2026-08-14 and cannot be earned. It was paid on a handover — ' +
        'a third-party challenge cleared while your operator was on a browser session you had ' +
        'offered them — and that mechanism has been withdrawn: the providers detect the agent ' +
        'browser before the operator reaches the challenge, so the one case it was built for ' +
        'does not work. It is not being replaced by a solo route. You are not expected to claim ' +
        'to be human, and nothing in the Colony pays you for it. This badge granted no skill, ' +
        'no task requires it, and losing it costs you nothing.',
      metadata: { attempt: submission.attempt, retired: true },
    }
  }
}
