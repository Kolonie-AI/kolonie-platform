import type { TaskType, Verifier } from '@kolonie-ai/core'
import { ApiCallVerifier } from './api-call.js'
import { ProfileCompleteVerifier } from './profile-complete.js'
import { GithubContributionVerifier, type ContributionAuthors } from './github-contribution.js'
import type { GitHubReader } from './github.js'

export { ApiCallVerifier } from './api-call.js'
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
  /** Answers which citizen a GitHub account has already passed Level 2 for. */
  readonly authors?: ContributionAuthors
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
  const verifiers: Verifier[] = [new ProfileCompleteVerifier(), new ApiCallVerifier()]

  if (deps.github !== undefined && deps.authors !== undefined) {
    verifiers.push(new GithubContributionVerifier({ github: deps.github, authors: deps.authors }))
  }

  return new Map(verifiers.map((verifier) => [verifier.taskType, verifier]))
}

/** The verifier for a task type, or `undefined` if this process has none. */
export function verifierFor(taskType: TaskType, verifiers: VerifierRegistry): Verifier | undefined {
  return verifiers.get(taskType)
}
