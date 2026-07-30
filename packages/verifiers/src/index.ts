import type { TaskType, Verifier } from '@kolonie-ai/core'
import { ProfileCompleteVerifier } from './profile-complete.js'
import { GithubContributionVerifier, type ContributionAuthors } from './github-contribution.js'
import { GithubAccountVerifier, type GithubChallenges } from './github-account.js'
import { BrowserCaptchaVerifier, type ClearedGates } from './browser-captcha.js'
import { BrowserCapabilityVerifier } from './browser-capability.js'
import { KeySignatureVerifier, type SignedKeys } from './key-signature.js'
import { ProofOfWorkVerifier, type SolvedChallenges } from './proof-of-work.js'
import { EmailRoundtripVerifier, type EmailRoundtrips } from './email-roundtrip.js'
import {
  SocialAccountVerifier,
  type SocialAccounts,
  type SocialChallenges,
} from './social-account.js'
import { SocialPostVerifier, type SocialGrants } from './social-post.js'
import type { GitHubReader } from './github.js'
import type { SocialReader } from './social.js'

export {
  BrowserCaptchaVerifier,
  type BrowserCaptchaDependencies,
  type ChallengeKind,
  type ClearedGates,
} from './browser-captcha.js'
export {
  BrowserCapabilityVerifier,
  type BrowserCapabilityDependencies,
} from './browser-capability.js'
export {
  KeySignatureVerifier,
  type KeyAttempt,
  type KeySignatureDependencies,
  type SignedKeys,
} from './key-signature.js'
export {
  ProofOfWorkVerifier,
  type PowAttempt,
  type ProofOfWorkDependencies,
  type SolvedChallenges,
} from './proof-of-work.js'
export {
  EmailRoundtripVerifier,
  type EmailRoundtripDependencies,
  type EmailRoundtripState,
  type EmailRoundtrips,
} from './email-roundtrip.js'
export { ProfileCompleteVerifier } from './profile-complete.js'
export {
  contributionText,
  GithubContributionVerifier,
  MINIMUM_CONTRIBUTION_LENGTH,
  type ContributionAuthors,
  type GithubContributionDependencies,
} from './github-contribution.js'
export {
  GithubAccountVerifier,
  type GithubAccountDependencies,
  type GithubChallenges,
} from './github-account.js'
export {
  SocialAccountVerifier,
  type SocialAccountDependencies,
  type SocialAccounts,
  type SocialChallenges,
} from './social-account.js'
export {
  MINIMUM_SOCIAL_POST_LENGTH,
  SocialPostVerifier,
  socialPostText,
  type SocialGrants,
  type SocialPostDependencies,
} from './social-post.js'
export {
  blueskyAdapter,
  htmlToText,
  httpSocialReader,
  MASTODON_INSTANCES_VAR,
  mastodonAdapter,
  parseMastodonInstances,
  resolveBlueskyUrl,
  resolveMastodonUrl,
  type ResolvedBlueskyUrl,
  type ResolvedMastodonUrl,
  type SocialAdapter,
  type SocialNetwork,
  type SocialPost,
  type SocialReader,
  type SocialReadResult,
} from './social.js'
export { hasMarkerLine, isMarkerLine } from './marker.js'
export {
  GITHUB_VERIFIER_TOKEN_VAR,
  httpGitHubReader,
  resolveGistUrl,
  resolveGitHubUrl,
  type GitHubArtefact,
  type GitHubGistArtefact,
  type GitHubGistReadResult,
  type GitHubReader,
  type GitHubReadResult,
  type ResolvedGistUrl,
  type ResolvedGitHubUrl,
} from './github.js'

/** The verifiers one process has deployed, keyed by the task type each handles. */
export type VerifierRegistry = ReadonlyMap<TaskType, Verifier>

/**
 * What the verifiers that read the outside world need in order to exist.
 *
 * Every field is optional, and a verifier whose dependencies are missing is left
 * out of the registry rather than built half-wired. That is the same rule this
 * package has always applied to a task type with no module at all: the runner
 * never claims a type it cannot verify, so such a submission waits for the
 * deploy that can — rather than being claimed, mis-decided, and paid or refused
 * on the strength of a dependency nobody supplied.
 */
export interface VerifierDependencies {
  /** Reads issues and comments. See `github.ts` for why a missing token is not a failure. */
  readonly github?: GitHubReader
  /** Answers which citizen a GitHub account has already passed the GitHub rung for. */
  readonly authors?: ContributionAuthors
  /**
   * Answers what the Colony recorded about an agent's mailbox round trip.
   *
   * Its own port rather than a second method on `gates`, because the two rungs
   * record different things in different tables and a shared port would let a
   * wiring mistake answer one rung with the other's evidence — the failure
   * `kind` was added to `browser_challenges` to prevent, one layer up.
   */
  readonly roundtrips?: EmailRoundtrips
  /**
   * Answers whether an agent has cleared a browser challenge, of either kind.
   *
   * One port for both, because it is one question against one table — and
   * because the kind is an *argument*, so a caller cannot wire the promoting
   * rung to the badge's record by picking the wrong dependency.
   */
  readonly gates?: ClearedGates
  /**
   * Answers what the Colony recorded about an agent's key challenge.
   *
   * Its own port for the same reason `roundtrips` is: a shared one would let a
   * wiring mistake answer one rung with another's evidence.
   */
  readonly keys?: SignedKeys
  /**
   * Answers what the Colony recorded about an agent's proof-of-work challenge.
   *
   * Its own port for the same reason `keys` is: a shared one would let a wiring
   * mistake answer one rung with another's evidence.
   */
  readonly work?: SolvedChallenges
  /**
   * Answers which nonces the Colony has issued to an agent for the GitHub rung.
   *
   * Its own port for the same reason `roundtrips` and `keys` are: a shared one
   * would let a wiring mistake answer one rung with another's evidence.
   */
  readonly githubChallenges?: GithubChallenges
  /**
   * Reads a public post on a network the Colony has assessed.
   *
   * **Unlike `github`, this one needs no credential to be useful**, so there is
   * no equivalent of the token check that leaves the GitHub reader answering
   * `unavailable` when it is unconfigured. What it is still optional for is the
   * rule this whole interface exists to serve: a verifier whose dependencies are
   * missing is left out of the registry rather than built half-wired.
   */
  readonly social?: SocialReader
  /**
   * Answers which nonces the Colony has issued to an agent for the social rung.
   *
   * Its own port for the same reason `githubChallenges` is: a shared one would
   * let a wiring mistake answer one rung with another's evidence.
   */
  readonly socialChallenges?: SocialChallenges
  /** Answers which citizen a social account has already certified. */
  readonly socialAccounts?: SocialAccounts
  /**
   * Answers what the Colony already recorded about this citizen's account: which
   * one it certified, and what it was asked to publish to certify it.
   *
   * Its own port rather than a second method on `socialAccounts`, which asks the
   * mirror-image question for a different rung. The badge reads the grant
   * forwards and the granting node reads it backwards, and a shared port would
   * invite one to be wired to the other.
   */
  readonly socialGrants?: SocialGrants
}

/**
 * Build the set of verifiers this process can run.
 *
 * A function rather than the constant it used to be, because verifiers stopped
 * being uniformly self-contained the moment one of them had to read GitHub and
 * consult the Colony's own history. The two alternatives are worse in the
 * directions you would expect: a module-level singleton reading `process.env` at
 * import time makes the package untestable and its wiring invisible, and letting
 * a verifier reach for the database itself crosses the boundary `AGENTS.md` §3
 * draws and D-018 already rejected once.
 *
 * Called with no arguments it yields the self-contained verifiers only, which is
 * what every test that does not care about GitHub wants. `apps/verifier-runner`
 * is the one place that supplies the rest, and it is the only place that should.
 */
export function createVerifiers(deps: VerifierDependencies = {}): VerifierRegistry {
  const verifiers: Verifier[] = [new ProfileCompleteVerifier()]

  if (deps.gates !== undefined) {
    verifiers.push(new BrowserCapabilityVerifier({ gates: deps.gates }))
    verifiers.push(new BrowserCaptchaVerifier({ gates: deps.gates }))
  }

  if (deps.keys !== undefined) {
    verifiers.push(new KeySignatureVerifier({ keys: deps.keys }))
  }

  if (deps.work !== undefined) {
    verifiers.push(new ProofOfWorkVerifier({ work: deps.work }))
  }

  if (deps.roundtrips !== undefined) {
    verifiers.push(new EmailRoundtripVerifier({ roundtrips: deps.roundtrips }))
  }

  if (
    deps.social !== undefined &&
    deps.socialChallenges !== undefined &&
    deps.socialAccounts !== undefined
  ) {
    verifiers.push(
      new SocialAccountVerifier({
        social: deps.social,
        challenges: deps.socialChallenges,
        accounts: deps.socialAccounts,
      }),
    )
  }

  if (deps.social !== undefined && deps.socialGrants !== undefined) {
    verifiers.push(new SocialPostVerifier({ social: deps.social, grants: deps.socialGrants }))
  }

  if (deps.github !== undefined && deps.authors !== undefined) {
    verifiers.push(new GithubContributionVerifier({ github: deps.github, authors: deps.authors }))

    if (deps.githubChallenges !== undefined) {
      verifiers.push(
        new GithubAccountVerifier({
          github: deps.github,
          challenges: deps.githubChallenges,
          authors: deps.authors,
        }),
      )
    }
  }

  return new Map(verifiers.map((verifier) => [verifier.taskType, verifier]))
}

/** The verifier for a task type, or `undefined` if this process has none. */
export function verifierFor(taskType: TaskType, verifiers: VerifierRegistry): Verifier | undefined {
  return verifiers.get(taskType)
}
