import type { TaskType, Verifier } from '@kolonie-ai/core'
import { ProfileCompleteVerifier } from './profile-complete.js'
import { GithubContributionVerifier, type ContributionAuthors } from './github-contribution.js'
import { GithubAccountVerifier, type GithubChallenges } from './github-account.js'
import { BrowserCaptchaVerifier, type ClearedGates } from './browser-captcha.js'
import { BrowserCapabilityVerifier } from './browser-capability.js'
import { KeySignatureVerifier, type SignedKeys } from './key-signature.js'
import { SolanaWalletVerifier, type SolanaWallets } from './solana-wallet.js'
import { EARNING_RUNGS, SolanaEarningVerifier } from './solana-earning.js'
import { SolanaTraderVerifier } from './solana-trader.js'
import { ImageGenVerifier, type ImageChallenges, type VisionChecker } from './image-gen.js'
import { CodeContributionVerifier, type GithubGrants } from './code-contribution.js'
import type { PaymentClaims, SolanaAddresses, SolanaHistory, SolanaRpc } from './solana-payment.js'
import { ProofOfWorkVerifier, type SolvedChallenges } from './proof-of-work.js'
import { VisionCapabilityVerifier, type VisionChallenges } from './vision-capability.js'
import { EmailRoundtripVerifier, type EmailRoundtrips } from './email-roundtrip.js'
import {
  SocialAccountVerifier,
  type SocialAccounts,
  type SocialChallenges,
} from './social-account.js'
import { WebsiteVerifyVerifier, type WebsiteChallenges } from './website-verify.js'
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
  SolanaWalletVerifier,
  type SolanaWalletAttempt,
  type SolanaWalletDependencies,
  type SolanaWallets,
} from './solana-wallet.js'
export {
  ProofOfWorkVerifier,
  type PowAttempt,
  type ProofOfWorkDependencies,
  type SolvedChallenges,
} from './proof-of-work.js'
export {
  VisionCapabilityVerifier,
  type VisionAttempt,
  type VisionCapabilityDependencies,
  type VisionChallenges,
} from './vision-capability.js'
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
  WebsiteVerifyVerifier,
  type WebsiteVerifyDependencies,
  type WebsiteChallenges,
} from './website-verify.js'
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
export { EARNING_RUNGS, SolanaEarningVerifier, type EarningRung } from './solana-earning.js'
export {
  creditTo,
  formatAmount,
  isTransactionSignature,
  MINIMUM_LAMPORTS,
  MINIMUM_USDC_UNITS,
  PAYMENT_TXID_KEY,
  USDC_MINT,
  type CreditOutcome,
  type PaymentClaims,
  type SolanaAddresses,
  type SolanaHistory,
  type SolanaHistoryResult,
  type SolanaReadResult,
  type SolanaRpc,
  type SolanaSignatureRecord,
  type SolanaTokenBalance,
  type SolanaTransaction,
} from './solana-payment.js'
export {
  DEFAULT_SOLANA_RPC_URL,
  httpSolanaHistory,
  httpSolanaRpc,
  SOLANA_RPC_URL_VAR,
} from './solana-rpc.js'
export {
  decide,
  realisedGain,
  SolanaTraderVerifier,
  TRADER_LOOKBACK_DAYS,
  TRADER_MAX_TRANSACTIONS,
  type RealisedGain,
  type SolanaTraderDependencies,
  type TradeVerdict,
} from './solana-trader.js'
export {
  ImageGenVerifier,
  type ImageChallenges,
  type ImageChallengeState,
  type ImageGenDependencies,
  type VisionCheckResult,
  type VisionChecker,
} from './image-gen.js'
export { readImage, type ImageFacts, type ImageFormat, type ImageRead } from './image.js'
export {
  readVisionImage,
  readVisionMetadata,
  VISION_ASSETS_DIR,
  type VisionAssetEntry,
  type VisionAssetMetadata,
} from './vision-assets.js'
export {
  DEFAULT_VISION_MODEL,
  openRouterVision,
  OPENROUTER_API_KEY_VAR,
  visionPromptFor,
  VISION_MODEL_VAR,
} from './vision-model.js'
export { hasMarkerLine, isMarkerLine } from './marker.js'
export {
  CodeContributionVerifier,
  type CodeContributionDependencies,
  type GithubGrants,
} from './code-contribution.js'
export {
  KOLONIE_ORG,
  GITHUB_VERIFIER_TOKEN_VAR,
  httpGitHubReader,
  resolveGistUrl,
  resolveGitHubUrl,
  type GitHubArtefact,
  type GitHubGistArtefact,
  type GitHubGistReadResult,
  type GitHubReader,
  type GitHubReadResult,
  type MergedPullRequest,
  type MergedPullRequestsResult,
  type ResolvedGistUrl,
  type ResolvedGitHubUrl,
} from './github.js'

/**
 * Reading a citizen's *own* open contributions, which is not a verdict.
 *
 * It lives in this package because the GitHub plumbing and the status rule do —
 * splitting the token handling across two packages is how `kolonie-infra#7`
 * happened, one layer down. It is exported separately because nothing in the
 * verifier registry uses it: the API serves it, the runner does not.
 */
export {
  httpContributionReader,
  summariseReviews,
  type ContributionReader,
  type OpenPullRequest,
  type OpenPullRequestsResult,
} from './contributions.js'

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
   * Answers which GitHub account *this* citizen certified.
   *
   * Its own port rather than a second method on `authors`, which asks the
   * mirror-image question for the rung below. A shared one would invite the
   * granting node and the node above it to be wired to each other's answer.
   */
  readonly githubGrants?: GithubGrants
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
   * Answers what the Colony recorded about an agent's wallet challenge.
   *
   * Its own port for the same reason `keys` is, and the two are worth keeping
   * apart even though both rungs verify a signature: they claim different
   * things, and a wiring mistake that answered one with the other's evidence
   * would hand out a `wallet` skill for a PEM key that never touched a chain.
   */
  readonly wallets?: SolanaWallets
  /**
   * Reads a transaction on Solana. Needs no credential, unlike every other
   * outward reader here — see `solana-rpc.ts` for why that matters.
   */
  readonly solana?: SolanaRpc
  /**
   * Answers which address a citizen proved at the wallet rung.
   *
   * Its own port rather than a method on `wallets`, which answers about a
   * *challenge* for the rung below. These are the two halves of the same table
   * read for different rungs, and keeping them apart is what stops an earning
   * verdict resting on an unverified attempt.
   */
  readonly solanaAddresses?: SolanaAddresses
  /** Answers whether a transaction has already carried somebody past an earning rung. */
  readonly paymentClaims?: PaymentClaims
  /**
   * Reads what an address has done, which only `solana-trader` needs.
   *
   * Its own port, so a runner can carry the three payment rungs without the one
   * that costs a call per transaction against the endpoint they share.
   */
  readonly solanaHistory?: SolanaHistory
  /** The specification the Colony drew for an agent at the image rung. */
  readonly imageChallenges?: ImageChallenges
  /**
   * Looks at an image and answers about five constraints.
   *
   * Its own port rather than a method on `vision`, which answers about the
   * *recognition* rung by reading the Colony's own record. One reads a database
   * and one calls a vendor; a shared port would let a wiring mistake answer a
   * generation verdict with a recognition challenge.
   */
  readonly visionModel?: VisionChecker
  /**
   * Answers what the Colony recorded about an agent's proof-of-work challenge.
   *
   * Its own port for the same reason `keys` is: a shared one would let a wiring
   * mistake answer one rung with another's evidence.
   */
  readonly work?: SolvedChallenges
  readonly vision?: VisionChallenges
  /**
   * Answers which nonces the Colony has issued to an agent for the GitHub rung.
   *
   * Its own port for the same reason `roundtrips` and `keys` are: a shared one
   * would let a wiring mistake answer one rung with another's evidence.
   */
  readonly githubChallenges?: GithubChallenges
  /** Answers which nonces the Colony has issued to an agent for the website rung. */
  readonly websiteChallenges?: WebsiteChallenges
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

  if (deps.wallets !== undefined) {
    verifiers.push(new SolanaWalletVerifier({ wallets: deps.wallets }))
  }

  /**
   * All three or none. An earning verdict rests on the chain saying a payment
   * landed, on the Colony knowing which address is the citizen's, and on the
   * transaction not having been spent already — and a rung built without the
   * last of those would pass the same payment four times.
   */
  if (
    deps.solana !== undefined &&
    deps.solanaAddresses !== undefined &&
    deps.paymentClaims !== undefined
  ) {
    for (const rung of EARNING_RUNGS) {
      verifiers.push(
        new SolanaEarningVerifier(rung, {
          rpc: deps.solana,
          addresses: deps.solanaAddresses,
          claims: deps.paymentClaims,
        }),
      )
    }
  }

  if (
    deps.solana !== undefined &&
    deps.solanaHistory !== undefined &&
    deps.solanaAddresses !== undefined
  ) {
    verifiers.push(
      new SolanaTraderVerifier({
        rpc: deps.solana,
        history: deps.solanaHistory,
        addresses: deps.solanaAddresses,
      }),
    )
  }

  if (deps.imageChallenges !== undefined && deps.visionModel !== undefined) {
    verifiers.push(
      new ImageGenVerifier({ challenges: deps.imageChallenges, vision: deps.visionModel }),
    )
  }

  if (deps.work !== undefined) {
    verifiers.push(new ProofOfWorkVerifier({ work: deps.work }))
  }

  if (deps.vision !== undefined) {
    verifiers.push(new VisionCapabilityVerifier({ vision: deps.vision }))
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

    if (deps.githubGrants !== undefined) {
      verifiers.push(
        new CodeContributionVerifier({ github: deps.github, grants: deps.githubGrants }),
      )
    }

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

  if (deps.websiteChallenges !== undefined) {
    verifiers.push(new WebsiteVerifyVerifier({ challenges: deps.websiteChallenges }))
  }

  return new Map(verifiers.map((verifier) => [verifier.taskType, verifier]))
}

/** The verifier for a task type, or `undefined` if this process has none. */
export function verifierFor(taskType: TaskType, verifiers: VerifierRegistry): Verifier | undefined {
  return verifiers.get(taskType)
}
