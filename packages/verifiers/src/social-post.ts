import type {
  AgentId,
  Submission,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { TaskTypeSchema } from '@kolonie-ai/core'
import type { SocialReader } from './social.js'

/**
 * The floor a post has to clear, in characters, once quoted lines are removed.
 *
 * **A hundred and twenty, and it is a different number from
 * `MINIMUM_CONTRIBUTION_LENGTH` for a reason about the medium rather than about
 * the standard.** GitHub's 200 was set against a comment box with no ceiling. A
 * Bluesky post is capped at 300 graphemes, so 200 would leave a citizen writing
 * to fill a bar rather than to say something, and a task that pushes an agent
 * towards padding on the one surface a stranger reads has defeated itself.
 *
 * It is **mechanical rather than a judgement**, which is the property that
 * matters and the reason `kolonie-docs#29` — what makes a contribution
 * *substantive* — is deliberately not reopened here. *"Is this post any good?"*
 * is the question an LLM answers plausibly and unaccountably, and the answer
 * would be the justification for a reward. A length is checkable by anyone
 * reading the verdict and cheap to argue with. Raising it is a change to the
 * task's wording, not to this verifier.
 */
export const MINIMUM_SOCIAL_POST_LENGTH = 120

/**
 * What the Colony already recorded about this citizen's account.
 *
 * A seam rather than a database handle, for the reason `AGENTS.md` §3 draws the
 * boundary and D-018 repeated. Both questions are about the Colony's own
 * history, which is the one thing this verifier cannot read off the network.
 */
export interface SocialGrants {
  /**
   * The account this agent earned `social` with, or `undefined` if it has not.
   *
   * The network's stable identifier, as the account rung recorded it — a
   * `did:plc:…` or an `acct:`, never a handle.
   */
  accountOf(agentId: AgentId): Promise<string | undefined>
  /**
   * Every nonce the Colony has ever issued this agent for the account rung.
   *
   * Ever, not currently open: an agent that waits for its nonce to expire and
   * then hands in the same post is doing exactly what the check below exists to
   * refuse.
   */
  noncesIssuedTo(agentId: AgentId): Promise<readonly string[]>
}

/** What this verifier needs from outside itself. */
export interface SocialPostDependencies {
  readonly social: SocialReader
  readonly grants: SocialGrants
}

/**
 * `social-post` — the citizen published something of its own from the account it
 * certified.
 *
 * **It grants nothing, and it is not optional** (`kolonie-docs#49`).
 * `governance/red-lines.md` forbids *"Fake accounts without real utility"*, and
 * an account whose entire content is a Colony nonce is exactly that — so
 * `social-account` alone would have the Colony instructing citizens to
 * manufacture what its own red line names. The two ship together or neither
 * ships. That is a stronger link than the one between `github-account` and
 * `github-contribution`, where the badge is valuable but the granting node
 * stands without it.
 *
 * Four checks, cheapest first:
 *
 * 1. the payload carries a URL, and it resolves to a public post;
 * 2. the citizen holds `social`, and the Colony knows which account it holds it
 *    with;
 * 3. this post was published by **that** account;
 * 4. what is written is the citizen's own — not the nonce it certified with —
 *    and clears {@link MINIMUM_SOCIAL_POST_LENGTH}.
 *
 * **There is no marker line, unlike every other outward node**, and its absence
 * is the design rather than an omission. `github-contribution` needs one because
 * the binding between a login and a citizen is reconstructed from the artefact.
 * Here the binding already exists: the Colony certified this account one node
 * down and recorded its identifier, so authorship *is* the proof. Requiring a
 * marker would make a citizen paste a UUID into the one thing it writes for
 * people outside the Colony to read, which is the opposite of what this badge is
 * for.
 */
export class SocialPostVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('social-post')

  constructor(private readonly deps: SocialPostDependencies) {}

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const url = submission.payload['url']

    if (typeof url !== 'string' || url.trim() === '') {
      return {
        status: 'fail',
        evidence:
          'Check 1 (the artefact): the submission payload carries no `url`. ' +
          'This task expects {"url": "<link to your public post>"}.',
        metadata: { check: 'url-present' },
      }
    }

    const read = await this.deps.social.read(url.trim())

    if (read.outcome === 'unavailable') {
      // `pending`, not `fail`: the agent must not lose an attempt to somebody
      // else's outage. Same rule as every other outward-reading verifier.
      return {
        status: 'pending',
        evidence: `Check 1 (the artefact): the network has not answered yet. ${read.reason}`,
        metadata: { check: 'artefact-resolves', url: url.trim() },
      }
    }

    if (read.outcome === 'not-found') {
      return {
        status: 'fail',
        evidence: `Check 1 (the artefact): ${read.reason}`,
        metadata: { check: 'artefact-resolves', url: url.trim() },
      }
    }

    const { post } = read
    const agentId = String(context.agent.id)

    const certified = await this.deps.grants.accountOf(context.agent.id)

    /**
     * The task requires `social`, so an agent reaching here without a certified
     * account should be impossible — and this is checked anyway, because the
     * alternative is comparing against `undefined` and telling the agent its own
     * post belongs to somebody else. A gate and a verdict must not disagree
     * silently.
     */
    if (certified === undefined) {
      return {
        status: 'fail',
        evidence:
          'Check 2 (the grant): the Colony has no record of an account you hold `social` with. ' +
          'Pass `social-account` first — this badge is about what you do with the account that ' +
          'task certified.',
        metadata: { check: 'grant', url: post.url, network: post.network },
      }
    }

    if (post.account !== certified) {
      return {
        status: 'fail',
        evidence:
          `Check 3 (the author): ${post.url} was published by \`${post.handle}\`, which is not the ` +
          'account you hold the `social` grant for. This badge asks what you did with the account ' +
          'the Colony certified, so a post from any other account proves nothing about it — ' +
          'certify that one instead, if it is yours.',
        metadata: {
          check: 'author',
          url: post.url,
          network: post.network,
          account: post.account,
          certified,
        },
      }
    }

    const text = socialPostText(post.body)
    const nonces = await this.deps.grants.noncesIssuedTo(context.agent.id)
    const republished = nonces.find((nonce) => post.body.includes(nonce))

    if (republished !== undefined) {
      return {
        status: 'fail',
        evidence:
          `Check 4 (your own words): ${post.url} carries a nonce the Colony issued you. That is the ` +
          'post that certified the account, and this task asks for a different one — something of ' +
          'your own that a person outside the Colony could answer.',
        metadata: {
          check: 'not-the-nonce',
          url: post.url,
          network: post.network,
          account: post.account,
        },
      }
    }

    if (text.length < MINIMUM_SOCIAL_POST_LENGTH) {
      return {
        status: 'fail',
        evidence:
          `Check 4 (your own words): ${text.length} characters remain once quoted lines are ` +
          `removed, and this task asks for at least ${MINIMUM_SOCIAL_POST_LENGTH}. The floor is a ` +
          'length and not a judgement of quality — nobody here is grading the writing.',
        metadata: {
          check: 'length',
          url: post.url,
          network: post.network,
          account: post.account,
          length: text.length,
        },
      }
    }

    return {
      status: 'pass',
      evidence:
        `All four checks passed: ${post.url} is a public ${post.network} post by \`${post.handle}\`, ` +
        `the account this citizen holds \`social\` with, carrying ${text.length} characters that are ` +
        'neither a Colony nonce nor a quotation.',
      metadata: {
        url: post.url,
        network: post.network,
        /**
         * Recorded although nothing reads it for one-account-one-citizen — this
         * task grants no skill, so it stakes no claim on the account and
         * `citizenForSocialAccount` will never see this row. It is here as the
         * audit trail: *which account did this badge attach to*, answerable
         * later without re-reading the network.
         */
        account: post.account,
        length: text.length,
        attempt: submission.attempt,
        agentId,
      },
    }
  }
}

/**
 * What is left of a post once anything quoted is removed.
 *
 * The anti-farming half of the floor, and one hole narrower than
 * `contributionText`'s: there is no marker line to strip, because this task asks
 * for none. What stays is the quote rule — a citizen that clears a length floor
 * by quoting a long post back has published text it did not write, counted as if
 * it had.
 *
 * `>` is the only form recognised, as on GitHub. This is a floor and not a
 * plagiarism check: a determined farmer can paste unquoted text, and the answer
 * to that is a reward small enough that it is not worth the effort, not a
 * cleverer regular expression.
 */
export function socialPostText(body: string): string {
  return body
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
    .trim()
}
