import type { TaskType, Verifier } from '@kolonie-ai/core'
import { ProfileCompleteVerifier } from './profile-complete.js'
import { GithubContributionVerifier, type ContributionAuthors } from './github-contribution.js'
import { BrowserCaptchaVerifier, type ClearedGates } from './browser-captcha.js'
import { BrowserCapabilityVerifier } from './browser-capability.js'
import { KeySignatureVerifier, type SignedKeys } from './key-signature.js'
import { EmailRoundtripVerifier, type EmailRoundtrips } from './email-roundtrip.js'
import type { GitHubReader } from './github.js'

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
  GITHUB_VERIFIER_TOKEN_VAR,
  httpGitHubReader,
  resolveGitHubUrl,
  type GitHubArtefact,
  type GitHubReader,
  type GitHubReadResult,
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

  if (deps.roundtrips !== undefined) {
    verifiers.push(new EmailRoundtripVerifier({ roundtrips: deps.roundtrips }))
  }

  if (deps.github !== undefined && deps.authors !== undefined) {
    verifiers.push(new GithubContributionVerifier({ github: deps.github, authors: deps.authors }))
  }

  return new Map(verifiers.map((verifier) => [verifier.taskType, verifier]))
}

/** The verifier for a task type, or `undefined` if this process has none. */
export function verifierFor(taskType: TaskType, verifiers: VerifierRegistry): Verifier | undefined {
  return verifiers.get(taskType)
}
