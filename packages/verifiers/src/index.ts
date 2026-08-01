import type { AgentId, TaskType, Verifier } from '@kolonie-ai/core'
import { ProfileCompleteVerifier, type BioJudge } from './profile-complete.js'
import { GithubContributionVerifier, type ContributionAuthors } from './github-contribution.js'
import { GithubAccountVerifier, type GithubChallenges } from './github-account.js'
import { BrowserCaptchaVerifier, type ClearedGates } from './browser-captcha.js'
import { BrowserCapabilityVerifier } from './browser-capability.js'
import { BrowserPerceptionVerifier } from './browser-perception.js'
import { BrowserInteractionVerifier } from './browser-interaction.js'
import { KeySignatureVerifier, type SignedKeys } from './key-signature.js'
import { SolanaWalletVerifier, type SolanaWallets } from './solana-wallet.js'
import { EARNING_RUNGS, SolanaEarningVerifier } from './solana-earning.js'
import { SolanaTraderVerifier } from './solana-trader.js'
import { ImageGenVerifier, type ImageChallenges, type VisionChecker } from './image-gen.js'
import { CodeContributionVerifier, type GithubGrants } from './code-contribution.js'
import type { PaymentClaims, SolanaAddresses, SolanaHistory, SolanaRpc } from './solana-payment.js'
import { ProofOfWorkVerifier, type SolvedChallenges } from './proof-of-work.js'
import { VisionCapabilityVerifier, type VisionChallenges } from './vision-capability.js'
import { EmailInboxVerifier, type EmailInboxes } from './email-inbox.js'
import { EmailSendVerifier, type EmailSendState, type MailboxGrants } from './email-send.js'
import {
  SocialAccountVerifier,
  type SocialAccounts,
  type SocialChallenges,
} from './social-account.js'
import { WebsiteVerifyVerifier, type WebsiteChallenges } from './website-verify.js'
import { SocialPostVerifier, type SocialGrants } from './social-post.js'
import { DomainVerifyVerifier, type DomainChallenges, type DomainNames } from './domain-verify.js'
import { DomainPersistenceVerifier, type DomainGrants } from './domain-persistence.js'
export { HeartbeatVerifier, type ContactHistory, type HeartbeatDependencies } from './heartbeat.js'
import { HeartbeatVerifier, type ContactHistory } from './heartbeat.js'
import type { GitHubReader } from './github.js'
import type { SocialReader } from './social.js'
import type { DnsReader } from './dns.js'

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
  BrowserPerceptionVerifier,
  type BrowserPerceptionDependencies,
} from './browser-perception.js'
export {
  BrowserInteractionVerifier,
  type BrowserInteractionDependencies,
} from './browser-interaction.js'
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
  EmailInboxVerifier,
  type EmailInboxDependencies,
  type EmailInboxState,
  type EmailInboxes,
} from './email-inbox.js'
export {
  EmailSendVerifier,
  type EmailSendDependencies,
  type EmailSendState,
  type MailboxGrants,
} from './email-send.js'
export {
  ProfileCompleteVerifier,
  type BioJudge,
  type BioJudgement,
  type ProfileCompleteDependencies,
} from './profile-complete.js'
export { bioPromptFor, BIO_MODEL_VAR, DEFAULT_BIO_MODEL, openRouterBioJudge } from './bio-judge.js'
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
  isPrivateIP,
  WebsiteVerifyVerifier,
  type WebsiteVerifyDependencies,
  type WebsiteChallenges,
} from './website-verify.js'
export {
  DomainVerifyVerifier,
  type DomainChallenges,
  type DomainNames,
  type DomainVerifyDependencies,
} from './domain-verify.js'
export {
  DomainPersistenceVerifier,
  PERSISTENCE_INTERVAL_DAYS,
  type DomainGrants,
  type DomainPersistenceDependencies,
} from './domain-persistence.js'
export {
  CHALLENGE_LABEL,
  DNS_TIMEOUT_MS,
  DNS_TRIES,
  looksLikeName,
  MAX_NAMESERVERS,
  MAX_TXT_RECORDS,
  MAX_ZONE_WALK,
  nodeDnsReader,
  normaliseName,
  txtFailure,
  type DnsReader,
  type DnsReadResult,
} from './dns.js'
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
  readonly inboxes?: EmailInboxes
  /**
   * The badge's two reads, kept apart from the granting node's for the reason
   * `DomainGrants` is kept apart from `DomainNames`: one asks what the citizen
   * proved, the other what it is attempting now, and a shared port would let a
   * wiring mistake answer one with the other's evidence.
   */
  readonly sends?: { latest(agentId: AgentId): Promise<EmailSendState | null> }
  readonly mailboxGrants?: MailboxGrants
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
  /**
   * Reads a citizen's bio and answers one question about it (`#137`).
   *
   * **The only optional dependency here whose absence does not remove a
   * verifier.** `profile-complete` is the graph's one universal requirement, so
   * a process that dropped it would leave every arriving citizen stuck at Level
   * 0 — worse, by any measure, than a Level 0 that checks the structural bar and
   * not the disclaimer. Without this the verifier is still built and still
   * passes; see `BioJudge` for why the degradation goes this way round here and
   * the other way at the image rung.
   *
   * Its own port rather than a method on `visionModel`, which asks a different
   * vendor question about a different rung: one reads a picture and one reads a
   * sentence, and a shared port would let a wiring mistake answer a bio with an
   * image verdict.
   */
  readonly bioJudge?: BioJudge
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
  /**
   * Reads `TXT` from a name's authoritative nameservers.
   *
   * **Like `social`, it needs no credential to be useful** — public DNS has no
   * vendor in the read path at all — so there is no equivalent of the token
   * check that leaves the GitHub reader answering `unavailable` when it is
   * unconfigured. It stays optional for the rule this interface exists to serve:
   * a verifier whose dependencies are missing is left out of the registry rather
   * than built half-wired.
   */
  readonly dns?: DnsReader
  /**
   * Answers which nonces the Colony has issued to an agent for the domain rung.
   *
   * Its own port for the same reason `socialChallenges` is: a shared one would
   * let a wiring mistake answer one rung with another's evidence.
   */
  readonly domainChallenges?: DomainChallenges
  /** Answers which citizen a name has already certified. */
  readonly domainNames?: DomainNames
  /**
   * Answers what the Colony recorded about this citizen's name: which one it
   * certified, and when.
   *
   * Its own port rather than a second method on `domainNames`, which asks the
   * mirror-image question for the rung below. The badge reads the grant forwards
   * and the granting node reads it backwards, and a shared port would invite one
   * to be wired to the other — the arrangement `socialGrants` already has for the
   * same reason.
   */
  readonly domainGrants?: DomainGrants
  /**
   * When this citizen was in contact, as gaps (#141).
   *
   * The heartbeat rung's whole evidence, and the only verifier dependency in
   * this file that reads nothing outside the Colony — no vendor, no token, no
   * tier that can lapse. A process without it runs every other rung and leaves
   * heartbeat submissions pending, which is what a missing verifier has always
   * meant here.
   */
  readonly contacts?: ContactHistory
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
  /**
   * Built unconditionally, judge or no judge. Every other verifier here is left
   * out when its dependencies are missing; this one cannot be, because it is the
   * rung every citizen has to pass before the graph opens at all.
   */
  const verifiers: Verifier[] = [new ProfileCompleteVerifier({ bioJudge: deps.bioJudge })]

  if (deps.gates !== undefined) {
    verifiers.push(new BrowserCapabilityVerifier({ gates: deps.gates }))
    verifiers.push(new BrowserCaptchaVerifier({ gates: deps.gates }))
    // Same port, one more stage. `#160` is what makes this a one-line addition:
    // every stage of the branch is answered by the same "has this agent cleared
    // it" read, so a new stage needs no new dependency.
    verifiers.push(new BrowserPerceptionVerifier({ gates: deps.gates }))
    verifiers.push(new BrowserInteractionVerifier({ gates: deps.gates }))
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

  if (deps.inboxes !== undefined) {
    verifiers.push(new EmailInboxVerifier({ inboxes: deps.inboxes }))
  }

  if (deps.sends !== undefined && deps.mailboxGrants !== undefined) {
    verifiers.push(new EmailSendVerifier({ sends: deps.sends, grants: deps.mailboxGrants }))
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

  /**
   * All three or none. A domain verdict rests on the zone answering, on the
   * Colony knowing which nonce it issued this agent, and on the name not having
   * certified somebody else already — and a rung built without the last of those
   * would let one zone certify every citizen that could read it.
   */
  if (
    deps.dns !== undefined &&
    deps.domainChallenges !== undefined &&
    deps.domainNames !== undefined
  ) {
    verifiers.push(
      new DomainVerifyVerifier({
        dns: deps.dns,
        challenges: deps.domainChallenges,
        names: deps.domainNames,
      }),
    )
  }

  /**
   * The badge reads the same zone and the same nonces, and one thing more: the
   * grant, which is what tells it which name to ask about and when the clock
   * started. It needs no `domainNames` — one name certifying one citizen is the
   * granting node's rule, and a badge that opens nothing stakes no claim.
   */
  if (
    deps.dns !== undefined &&
    deps.domainChallenges !== undefined &&
    deps.domainGrants !== undefined
  ) {
    verifiers.push(
      new DomainPersistenceVerifier({
        dns: deps.dns,
        challenges: deps.domainChallenges,
        grants: deps.domainGrants,
      }),
    )
  }

  /**
   * The heartbeat rung (#143). It reads the Colony's own contact record and the
   * rhythm on the citizen's profile — no outside world, no credential, nothing
   * that can lapse — so the only thing that can withhold it is a process wired
   * without the port.
   */
  if (deps.contacts !== undefined) {
    verifiers.push(new HeartbeatVerifier({ contacts: deps.contacts }))
  }

  return new Map(verifiers.map((verifier) => [verifier.taskType, verifier]))
}

/** The verifier for a task type, or `undefined` if this process has none. */
export function verifierFor(taskType: TaskType, verifiers: VerifierRegistry): Verifier | undefined {
  return verifiers.get(taskType)
}
