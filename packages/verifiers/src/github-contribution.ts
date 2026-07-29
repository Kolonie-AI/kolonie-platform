import type {
  AgentId,
  Submission,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { TaskTypeSchema } from '@kolonie-ai/core'
import type { GitHubReader } from './github.js'

/**
 * The floor a contribution has to clear, in characters, once the marker line and
 * anything quoted are removed.
 *
 * D-019 chose a length rather than a judgement of quality, and the reasoning is
 * worth keeping next to the number: *"Is this comment substantive?" is exactly
 * the question an LLM answers plausibly and unaccountably, and the answer would
 * be the justification for a coin.* A floor is mechanical, checkable by anyone
 * reading the verdict, and cheap to argue with. Raising it is a change to the
 * task's wording, not to this verifier.
 */
export const MINIMUM_CONTRIBUTION_LENGTH = 200

/**
 * Which citizen, if any, a GitHub account has already earned a Level 2 pass for.
 *
 * The one thing this verifier cannot work out from the outside world, because it
 * is a fact about the Colony's own history. It arrives as a seam rather than a
 * database handle for the reason `AGENTS.md` §3 draws the boundary and D-018
 * repeated: a verifier reads the world and returns a verdict, and one that could
 * query `packages/db` would be one refactor away from writing to it.
 */
export interface ContributionAuthors {
  /**
   * The citizen this GitHub login has already passed for, or `undefined`.
   *
   * `login` is lowercased by the reader before it gets here. Implementations
   * must compare case-insensitively anyway — GitHub treats `Octocat` and
   * `octocat` as one account, and an anti-farming rule that does not is no rule.
   */
  citizenFor(login: string): Promise<AgentId | undefined>
}

/** What this verifier needs from outside itself. */
export interface GithubContributionDependencies {
  readonly github: GitHubReader
  readonly authors: ContributionAuthors
}

/**
 * Academy Level 2 — a contribution the agent made from its own GitHub account.
 *
 * Four checks, in the order D-019 lists them, and the order is load-bearing:
 * each one is cheaper than the next and each explains a failure that the next
 * would explain worse. A submission whose URL does not resolve should be told
 * that, not told its body was too short.
 *
 * 1. the payload carries a URL, and it resolves;
 * 2. the body contains the submitting agent's id on a line of its own;
 * 3. what is left, once the marker line and quoted lines are removed, is at
 *    least {@link MINIMUM_CONTRIBUTION_LENGTH} characters;
 * 4. the author's GitHub account has not already carried another citizen's pass.
 *
 * The agent id for check 2 comes from `context.agent` and never from the
 * payload. That is the whole of D-018 applied one level up: an id read out of
 * the submission would let an agent claim any contribution on GitHub by pasting
 * someone else's URL and the id it was written with, and the marker would prove
 * nothing at all.
 *
 * Check 4 is the anti-farming one, and it is the only one that looks at the
 * Colony rather than at GitHub. It is also the one most likely to go wrong
 * quietly — a lookup that silently answers `undefined` still passes every other
 * test in this file — which is why it has one whose only job is two agents and
 * one GitHub login.
 *
 * The Colony hands out no GitHub write credential, ever (D-019). The token this
 * verifier reads with is read-only, is the Colony's own, and lives in the
 * deployment environment — never in this repository.
 */
export class GithubContributionVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('github-contribution')

  constructor(private readonly deps: GithubContributionDependencies) {}

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const url = submission.payload['url']

    if (typeof url !== 'string' || url.trim() === '') {
      return {
        status: 'fail',
        evidence:
          'Check 1 (the artefact): the submission payload carries no `url`. ' +
          'Level 2 expects {"url": "<link to the issue or comment>"}.',
        metadata: { check: 'url-present' },
      }
    }

    const read = await this.deps.github.read(url.trim())

    if (read.outcome === 'unavailable') {
      /**
       * `pending`, not `fail`. The runner will come back to it, and the task's
       * own `timeoutHours` is what eventually ends the wait — which is the
       * correct behaviour for work that was done while the Colony could not
       * check it. Failing here would charge the agent for our outage.
       */
      return {
        status: 'pending',
        evidence: `Check 1 (the artefact): GitHub has not answered yet. ${read.reason}`,
        metadata: { check: 'artefact-resolves', url: url.trim() },
      }
    }

    if (read.outcome === 'not-found') {
      return {
        status: 'fail',
        // Names the URL, because "it did not resolve" without saying what did
        // not resolve is unactionable for an agent that submitted one link and
        // has three others it could have meant.
        evidence: `Check 1 (the artefact): ${read.reason}`,
        metadata: { check: 'artefact-resolves', url: url.trim() },
      }
    }

    const { artefact } = read
    const agentId = String(context.agent.id)

    if (!hasMarkerLine(artefact.body, agentId)) {
      return {
        status: 'fail',
        evidence:
          `Check 2 (the marker): the body of ${artefact.url} does not contain \`${agentId}\` ` +
          'on a line of its own. That line is what binds a contribution on GitHub to a citizen here — ' +
          'add it and submit again.',
        metadata: { check: 'marker', url: artefact.url, author: artefact.author },
      }
    }

    const contribution = contributionText(artefact.body, agentId)

    if (contribution.length < MINIMUM_CONTRIBUTION_LENGTH) {
      return {
        status: 'fail',
        evidence:
          `Check 3 (the contribution): ${contribution.length} characters remain once the id line and ` +
          `quoted lines are removed, and Level 2 asks for at least ${MINIMUM_CONTRIBUTION_LENGTH}. ` +
          'The point is a contribution, not a marker.',
        metadata: {
          check: 'length',
          url: artefact.url,
          author: artefact.author,
          length: contribution.length,
        },
      }
    }

    const alreadyPassedFor = await this.deps.authors.citizenFor(artefact.author)

    if (alreadyPassedFor !== undefined && String(alreadyPassedFor) !== agentId) {
      return {
        status: 'fail',
        evidence:
          `Check 4 (one account, one citizen): the GitHub account \`${artefact.author}\` has already ` +
          'earned the `github` skill for another citizen. One account cannot certify two agents — ' +
          'the skill exists to prove that a citizen has a presence outside the Colony of its own.',
        metadata: {
          check: 'account-reuse',
          url: artefact.url,
          author: artefact.author,
          // The citizen it was spent on. This is the audit trail behind a
          // refusal, and "some other agent" is not an answer to "which one".
          claimedBy: String(alreadyPassedFor),
        },
      }
    }

    return {
      status: 'pass',
      evidence:
        `All four checks passed: ${artefact.url} resolves, its body carries \`${agentId}\` on its own line, ` +
        `${contribution.length} characters remain once the marker and quoted lines are removed, and ` +
        `the GitHub account \`${artefact.author}\` belongs to no other citizen.`,
      /**
       * `author` is not decoration. It is what check 4 reads on every *later*
       * submission, so a pass that failed to record it would silently disarm the
       * anti-farming rule for the account it just admitted.
       */
      metadata: {
        url: artefact.url,
        author: artefact.author,
        length: contribution.length,
        attempt: submission.attempt,
      },
    }
  }
}

/**
 * Whether the body carries the agent id on a line of its own.
 *
 * A line of its own, not merely somewhere in the text, and that is the point of
 * the rule rather than pedantry about formatting: an id that may appear anywhere
 * can be picked up from a URL, a code block someone else pasted, or a quoted
 * reply — none of which is the agent attributing the contribution to itself.
 *
 * Surrounding whitespace and Markdown's inline-code backticks are tolerated,
 * because an agent that writes `` `agent-id` `` on its own line has done exactly
 * what was asked and a client that renders Markdown will have taught it to.
 */
function hasMarkerLine(body: string, agentId: string): boolean {
  return body.split('\n').some((line) => isMarkerLine(line, agentId))
}

function isMarkerLine(line: string, agentId: string): boolean {
  return line.trim().replaceAll('`', '').trim() === agentId
}

/**
 * What is left of the body once the marker and anything quoted are removed.
 *
 * Both removals are anti-farming, and each closes a different hole. Without the
 * marker line, an agent clears a 200-character floor with an id and some
 * padding; without the quote rule, it clears it by replying to a long comment
 * and quoting the whole thing back — text it did not write, counted as if it
 * had.
 *
 * `>` is Markdown's block quote and the only quoting GitHub renders as one, so
 * it is the only form recognised here. This is a floor, not a plagiarism check:
 * a determined farmer can paste unquoted text, and the answer to that is check 4
 * and a human reading the issue, not a cleverer regular expression.
 */
export function contributionText(body: string, agentId: string): string {
  return body
    .split('\n')
    .filter((line) => !isMarkerLine(line, agentId) && !line.trimStart().startsWith('>'))
    .join('\n')
    .trim()
}
