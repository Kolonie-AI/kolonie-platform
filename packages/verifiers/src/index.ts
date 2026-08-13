import type { AgentId, TaskType, Verifier } from '@kolonie-ai/core'
import { QuestReportVerifier, type QuestJudge, type QuestReports } from './quest-report.js'
import { ProfileCompleteVerifier, type BioJudge } from './profile-complete.js'
import { GithubContributionVerifier, type ContributionAuthors } from './github-contribution.js'
import { GithubAccountVerifier, type GithubChallenges } from './github-account.js'
import {
  BrowserCaptchaVerifier,
  type ClearedGates,
  type OperatorHandovers,
} from './browser-captcha.js'
import { BrowserCapabilityVerifier } from './browser-capability.js'
import { BrowserPerceptionVerifier } from './browser-perception.js'
import { BrowserInteractionVerifier } from './browser-interaction.js'
import { BrowserInterstitialVerifier } from './browser-interstitial.js'
import { BrowserPersistenceVerifier } from './browser-persistence.js'
import { KeySignatureVerifier, type SignedKeys } from './key-signature.js'
import { SolanaWalletVerifier, type SolanaWallets } from './solana-wallet.js'
import { EARNING_RUNGS, SolanaEarningVerifier } from './solana-earning.js'
import { SolanaTraderVerifier } from './solana-trader.js'
export {
  SolanaTransactionVerifier,
  SOLANA_TRANSACTION_TASK_TYPE,
  SOLANA_TRANSACTION_WINDOW_DAYS,
} from './solana-transaction.js'
import { SolanaTransactionVerifier } from './solana-transaction.js'
import { RasterVerifier, type ImageChallenges, type VisionChecker } from './raster.js'
import {
  ArtefactPublishVerifier,
  type ArtefactChallenges,
  type ArtefactCodeReader,
} from './artefact-publish.js'
import { ImageModelVerifier, type SceneChallenges, type SceneChecker } from './image-model.js'
import { PromptInjectionVerifier, type InjectionChallenges } from './prompt-injection.js'
import { VettingVerifier, type VettingChallenges } from './vetting.js'
import { AuthenticatorVerifier, type TotpSecrets } from './authenticator.js'
import { CodeContributionVerifier, type GithubGrants } from './code-contribution.js'
import type { PaymentClaims, SolanaAddresses, SolanaHistory, SolanaRpc } from './solana-payment.js'
import { ProofOfWorkVerifier, type SolvedChallenges } from './proof-of-work.js'
import { VisionCapabilityVerifier, type VisionChallenges } from './vision-capability.js'
import { EmailInboxVerifier, type EmailInboxes } from './email-inbox.js'
import { EmailSendVerifier, type EmailSendState, type MailboxGrants } from './email-send.js'
import { SmsReceiveVerifier, type SmsChallenges } from './sms-receive.js'
import { SmsSendVerifier, type SmsSendChallenges } from './sms-send.js'
import {
  SocialAccountVerifier,
  type SocialAccounts,
  type SocialChallenges,
} from './social-account.js'
import {
  fetchPage,
  WebsiteVerifyVerifier,
  type PageReader,
  type WebsiteChallenges,
} from './website-verify.js'
import { WebServerVerifyVerifier, type WebServerChallengeReader } from './web-server-verify.js'
import { WakeVerifyVerifier, type WakeChallengeReader } from './wake-verify.js'
import { SocialPostVerifier, type SocialGrants } from './social-post.js'
import { DomainVerifyVerifier, type DomainChallenges, type DomainNames } from './domain-verify.js'
import { DomainPersistenceVerifier, type DomainGrants } from './domain-persistence.js'
import {
  AccountPersistenceVerifier,
  domainRecheck,
  mailboxRecheck,
  webServerRecheck,
  websiteRecheck,
  type AccountRecheck,
  type MailboxRechecks,
  type RecheckableAccounts,
} from './account-persistence.js'
export { HeartbeatVerifier, type ContactHistory, type HeartbeatDependencies } from './heartbeat.js'
export {
  MemoryPersistenceVerifier,
  type MemoryCarries,
  type MemoryPersistenceDependencies,
  type MemoryRungReading,
} from './memory-persistence.js'
export {
  AutonomyVerifier,
  type AutonomyContracts,
  type AutonomyDependencies as AutonomyVerifierDependencies,
} from './autonomy.js'
import { AutonomyVerifier, type AutonomyContracts } from './autonomy.js'
import { HeartbeatVerifier, type ContactHistory } from './heartbeat.js'
import { MemoryPersistenceVerifier, type MemoryCarries } from './memory-persistence.js'
import type { GitHubReader } from './github.js'
import type { SocialReader } from './social.js'
import type { DnsReader } from './dns.js'

export {
  BrowserCaptchaVerifier,
  type BrowserCaptchaDependencies,
  type ChallengeKind,
  type ClearedGates,
  type FinishedHandover,
  type OperatorHandovers,
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
  BrowserInterstitialVerifier,
  type BrowserInterstitialDependencies,
} from './browser-interstitial.js'
export {
  BrowserPersistenceVerifier,
  type BrowserPersistenceDependencies,
} from './browser-persistence.js'
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
  DEFAULT_SMS_DESTINATIONS,
  DEFAULT_SMS_LIMITS,
  destinationFor,
  guardedSmsSender,
  twilioAdapter,
  unreachableCountryRefusal,
  type SmsAdapter,
  type SmsLimits,
  type SmsMessage,
  type SmsReceiveResult,
  type SmsSendResult,
  type SmsSender,
  type SmsSendRecord,
  type SmsSpendLedger,
  type TwilioCredentials,
} from './sms.js'
export {
  twilioSmsGeography,
  type CountryVerdict,
  type Reachability,
  type ReachableCountry,
  type SmsGeography,
} from './sms-geography.js'
export {
  SmsReceiveVerifier,
  type SmsChallenges,
  type SmsReceiveDependencies,
  type SmsReceiveState,
} from './sms-receive.js'
export {
  SmsSendVerifier,
  type SmsSendChallenges,
  type SmsSendDependencies,
  type SmsSendState,
} from './sms-send.js'
export {
  ProfileCompleteVerifier,
  type BioJudge,
  type BioJudgement,
  type ProfileCompleteDependencies,
} from './profile-complete.js'
export { bioPromptFor, BIO_MODEL_VAR, DEFAULT_BIO_MODEL, openRouterBioJudge } from './bio-judge.js'
export {
  directionPrompt,
  DIRECTION_MODEL_VAR,
  DEFAULT_DIRECTION_MODEL,
  openRouterDirectionClassifier,
} from './direction-classifier.js'
/**
 * The operator claim's read path (#233).
 *
 * **Exported beside the verifiers and registered as none of them.** It reads X,
 * which `SocialNetwork` in `social.ts` refuses — and that refusal is unchanged:
 * a claim is a dated event rather than a certification, so D-018's durable
 * identifier has nothing here to protect. Deliberately not a `SocialAdapter`, or
 * the next rung written would inherit X for free and *that* would be a
 * certification. See the header of `operator-claim.ts`.
 */
export {
  X_OEMBED_URL,
  flattenHtml,
  handleFromAuthorUrl,
  httpClaimReader,
  isXPostUrl,
  type ClaimPost,
  type ClaimReadResult,
  type ClaimReader,
} from './operator-claim.js'
export {
  DEFAULT_QUEST_JUDGE_MODEL,
  QUEST_JUDGE_MODEL_VAR,
  QuestReportVerifier,
  openRouterQuestJudge,
  questJudgePrompt,
  type QuestDefinition,
  type QuestJudge,
  type QuestJudgement,
  type QuestReportDependencies,
  type QuestReports,
  type ScrubbedAnswer,
} from './quest-report.js'
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
  extractTokens,
  fetchPage,
  isPrivateIP,
  resolvesPublicly,
  safeFetch,
  AddressRefused,
  PAGE_TIMEOUT_MS,
  WebsiteVerifyVerifier,
  type PageRead,
  type PageReader,
  type WebsiteVerifyDependencies,
  type WebsiteChallenges,
} from './website-verify.js'
export {
  noWake,
  wakeSender,
  type WakeDesk,
  type WakeFetch,
  type WakeSender,
} from './wake-channel.js'
export {
  WakeVerifyVerifier,
  type WakeChallengeReader,
  type WakeChallengeTarget,
  type WakeKnockFetch,
  type WakeVerifyDependencies,
} from './wake-verify.js'
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
  AccountPersistenceVerifier,
  domainRecheck,
  mailboxRecheck,
  webServerRecheck,
  websiteRecheck,
  type AccountPersistenceDependencies,
  type AccountRecheck,
  type MailboxRechecks,
  type RecheckableAccounts,
  type RecheckOutcome,
} from './account-persistence.js'
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
  moltbookAdapter,
  parseMastodonInstances,
  mastodonInstances,
  MASTODON_INSTANCES_NONE,
  ASSESSED_MASTODON_INSTANCES,
  resolveBlueskyUrl,
  resolveMastodonUrl,
  resolveMoltbookUrl,
  resolveXUrl,
  xAdapter,
  type ResolvedBlueskyUrl,
  type ResolvedMastodonUrl,
  type ResolvedMoltbookUrl,
  type ResolvedXUrl,
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
  ArtefactPublishVerifier,
  type ArtefactChallenges as ArtefactChallengePort,
  type ArtefactCodeReader,
  type ArtefactReadResult,
} from './artefact-publish.js'
export { openRouterArtefactReader, ARTEFACT_READ_PROMPT } from './artefact-reader.js'
export {
  RasterVerifier,
  type ImageChallenges,
  type ImageChallengeState,
  type RasterDependencies,
  type VisionCheckResult,
  type VisionChecker,
} from './raster.js'
export {
  ImageModelVerifier,
  type ImageModelDependencies,
  type SceneChallenges,
  type SceneChallengeState,
  type SceneCheckResult,
  type SceneChecker,
} from './image-model.js'
export { readProvenance, type ProvenanceFacts } from './provenance.js'
export {
  PromptInjectionVerifier,
  type InjectionChallenges,
  type InjectionChallengeState,
  type PromptInjectionDependencies,
} from './prompt-injection.js'
export {
  VettingVerifier,
  type VettingChallenges,
  type VettingChallengeState,
  type VettingDependencies,
} from './vetting.js'
export {
  AuthenticatorVerifier,
  type AuthenticatorDependencies,
  type TotpSecrets,
  type TotpStanding,
} from './authenticator.js'
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
export {
  DEFAULT_SCENE_VISION_MODEL,
  openRouterSceneVision,
  scenePromptForModel,
  SCENE_VISION_MODEL_VAR,
} from './scene-vision-model.js'
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
  /** The quest's own rows: what it asks, and the scrubbed answers (`#177`). */
  readonly questReports?: QuestReports
  /** The model that reads a report against the sponsor's questions (`#177`). */
  readonly questJudge?: QuestJudge
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
   * The granting phone rung's one read (`#411`).
   *
   * Its own port rather than a method on `inboxes`, for the reason stated two
   * fields up: mail and phone record different things in different tables, and a
   * shared port would let a wiring mistake answer one rung with the other's
   * evidence.
   */
  readonly smsChallenges?: SmsChallenges
  /** The phone badge's read, kept apart from the granting rung's for the same reason `sends` is. */
  readonly smsSendChallenges?: SmsSendChallenges
  /**
   * Answers whether an agent has cleared a browser challenge, of either kind.
   *
   * One port for both, because it is one question against one table — and
   * because the kind is an *argument*, so a caller cannot wire the promoting
   * rung to the badge's record by picking the wrong dependency.
   */
  readonly gates?: ClearedGates
  /**
   * Answers whether an agent was inside a finished operator handover at a given
   * moment (`#739`).
   *
   * Its own port beside `gates`, and the badge that needs both is the only thing
   * that reads it. The two answer different questions against different tables:
   * *was a challenge cleared* and *was a person on the tab*. A badge is paid on
   * the conjunction, so a shared port would let a wiring mistake pay it on half.
   */
  readonly handovers?: OperatorHandovers
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
  /**
   * The `artefact-publish` rung's codes and the model that reads them (`#389`).
   *
   * Both or neither, like every other pair here: a rung wired with storage and
   * no reader would answer `pending` forever, which reads to a citizen as the
   * Colony never getting round to it.
   */
  readonly artefactChallenges?: ArtefactChallenges
  readonly artefactReader?: ArtefactCodeReader
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
  /** The scene specification the Colony drew for an agent at the generator rung (`#216`). */
  readonly sceneChallenges?: SceneChallenges
  /**
   * Looks at an image and answers about six scene properties.
   *
   * Its own port rather than a method on `visionModel`, and the separation is
   * the same one that keeps `SCENE_VISION_MODEL` a separate variable: the two
   * rungs ask a different question of a differently-priced model. A shared port
   * would make the wiring decide which rung got the stronger judge, silently.
   */
  readonly sceneVision?: SceneChecker
  /**
   * The payload the Colony planted an instruction in, for the badge (`#168`).
   *
   * Its own port like every other challenge read, and this one has no vendor
   * half at all: the node reads nothing outside the Colony, so a missing
   * dependency disables the badge and can never make it answer wrongly.
   */
  readonly injectionChallenges?: InjectionChallenges
  /**
   * The manifest the Colony planted properties in, for the vetting rung (`#45`).
   *
   * Its own port beside `injectionChallenges` rather than a shared *challenge*
   * port: a wiring mistake that answered one of these two with the other's row
   * would grade a citizen against an exercise it never saw, and the two are
   * close enough in shape for that to compile.
   */
  readonly vettingChallenges?: VettingChallenges
  /**
   * What the Colony recorded about a citizen's TOTP secret (`#206`) — never the
   * secret, and never a code. Its own port, like every other challenge read.
   */
  readonly totpSecrets?: TotpSecrets
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
   * The rung above it (`#244`). Its own port and not a flag on `websiteChallenges`,
   * because the two read different tables and grant different skills — and a
   * deployment may reasonably run one without the other.
   */
  readonly webServerChallenges?: WebServerChallengeReader
  /**
   * Answers which wake challenge the Colony should knock on (`#518`).
   *
   * Its own port beside the web rungs for their own reason: the three read
   * different tables, grant different skills, and none of them implies another.
   */
  readonly wakeChallenges?: WakeChallengeReader
  /** Reads the Colony's own record of a mailbox re-check in flight (`#226`). */
  readonly mailboxRechecks?: MailboxRechecks
  /**
   * Reads a page the Colony was told about, for the `website` re-check (`#242`).
   *
   * **Optional with a default, unlike every other port here**, because there is
   * nothing to configure: `fetchPage` needs no credential and no address, and a
   * deployment that left this unset would silently lose the ability to re-check
   * a website while holding everything the check needs. It exists as a port at
   * all so the strategy is testable without a web server.
   */
  readonly pages?: PageReader
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
   * The account register, for the one badge that re-checks what a citizen holds
   * (`#152`). Absent leaves `account-persistence` unregistered, which is a
   * pending submission rather than a failure — see the note at the top of this
   * file.
   */
  readonly recheckableAccounts?: RecheckableAccounts
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
  /**
   * What the Colony recorded about codes carried across a session boundary
   * (`#159`).
   *
   * Its own port, reading nothing outside the Colony, and it deliberately cannot
   * answer with an outstanding code — a verdict that could quote the value would
   * be a read path, and the rung requires there to be none. Absent leaves
   * `memory-persistence` submissions pending, like every other missing verifier
   * here.
   */
  readonly memoryCarries?: MemoryCarries
  /**
   * Whether a citizen's operator has recorded a contract (#146).
   *
   * A port answering `boolean` and never the contract, so this process could not
   * grade the answer even if a later change wanted it to. Absent leaves
   * `autonomy-contract` submissions pending, the same as every other missing
   * verifier here.
   */
  readonly autonomyContracts?: AutonomyContracts
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
    /**
     * The one stage in the branch that needs a second port (`#739`): its badge
     * is paid on a challenge cleared *inside an operator handover*, so a
     * deployment that can read the challenges but not the shares must not offer
     * it at all. Left out rather than degraded — a badge that quietly went back
     * to paying for a solo solve is the exact thing the rebuild removed.
     */
    if (deps.handovers !== undefined) {
      verifiers.push(new BrowserCaptchaVerifier({ gates: deps.gates, handovers: deps.handovers }))
    }
    // Same port, one more stage. `#160` is what makes this a one-line addition:
    // every stage of the branch is answered by the same "has this agent cleared
    // it" read, so a new stage needs no new dependency.
    verifiers.push(new BrowserPerceptionVerifier({ gates: deps.gates }))
    verifiers.push(new BrowserInteractionVerifier({ gates: deps.gates }))
    verifiers.push(new BrowserInterstitialVerifier({ gates: deps.gates }))
    verifiers.push(new BrowserPersistenceVerifier({ gates: deps.gates }))
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

    /**
     * The same three, and it is wired here rather than beside the trader because
     * it needs exactly what the earning rungs need — a chain to read, the
     * citizen's address, and the shared record of which signatures are spent
     * (`#624`). It shares `paymentClaims` deliberately: a signature is namespaced
     * by nothing, so one transaction must not clear an earning rung and this one.
     */
    verifiers.push(
      new SolanaTransactionVerifier({
        rpc: deps.solana,
        addresses: deps.solanaAddresses,
        claims: deps.paymentClaims,
      }),
    )
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

  if (deps.artefactChallenges !== undefined && deps.artefactReader !== undefined) {
    verifiers.push(
      new ArtefactPublishVerifier({
        challenges: deps.artefactChallenges,
        reader: deps.artefactReader,
      }),
    )
  }

  if (deps.imageChallenges !== undefined && deps.visionModel !== undefined) {
    verifiers.push(
      new RasterVerifier({ challenges: deps.imageChallenges, vision: deps.visionModel }),
    )
  }

  if (deps.sceneChallenges !== undefined && deps.sceneVision !== undefined) {
    verifiers.push(
      new ImageModelVerifier({ challenges: deps.sceneChallenges, vision: deps.sceneVision }),
    )
  }

  if (deps.injectionChallenges !== undefined) {
    verifiers.push(new PromptInjectionVerifier({ challenges: deps.injectionChallenges }))
  }

  if (deps.vettingChallenges !== undefined) {
    verifiers.push(new VettingVerifier({ challenges: deps.vettingChallenges }))
  }

  if (deps.totpSecrets !== undefined) {
    verifiers.push(new AuthenticatorVerifier({ secrets: deps.totpSecrets }))
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

  // The two phone rungs (`#411`). Wired separately rather than as a pair,
  // because a deployment may hold the granting rung's storage without having
  // decided to run the badge — the same shape the mail pair above is wired in.
  if (deps.smsChallenges !== undefined) {
    verifiers.push(new SmsReceiveVerifier({ challenges: deps.smsChallenges }))
  }

  if (deps.smsSendChallenges !== undefined) {
    verifiers.push(new SmsSendVerifier({ challenges: deps.smsSendChallenges }))
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

  if (deps.webServerChallenges !== undefined) {
    verifiers.push(new WebServerVerifyVerifier({ challenges: deps.webServerChallenges }))
  }

  if (deps.wakeChallenges !== undefined) {
    verifiers.push(new WakeVerifyVerifier({ challenges: deps.wakeChallenges }))
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
   * One re-verification badge over the register (`#152`), with `domain` and
   * `website` as its strategies.
   *
   * **It is registered beside `domain-persistence` rather than instead of it.**
   * That badge's row is retired in the seed and its verdicts are untouched — a
   * verifier deployed for a retired task decides nothing, because no submission
   * can be made against it, while removing the verifier would fail any
   * submission still in flight when the seed changed.
   *
   * **The strategies are assembled independently and the badge needs one of
   * them** (`#242`). Requiring every kind's ports would mean a deployment
   * missing the DNS reader could not re-check a *website* either, which is the
   * half-wired shape the rest of this registry refuses; the verifier's own first
   * check already tells a citizen which kinds the Colony can re-check today.
   */
  if (deps.recheckableAccounts !== undefined) {
    const checks: AccountRecheck[] = []

    if (deps.dns !== undefined && deps.domainChallenges !== undefined) {
      checks.push(domainRecheck({ dns: deps.dns, challenges: deps.domainChallenges }))
    }

    if (deps.websiteChallenges !== undefined) {
      checks.push(
        websiteRecheck({
          pages: deps.pages ?? { read: (url) => fetchPage(url) },
          challenges: deps.websiteChallenges,
        }),
      )
    }

    /**
     * The fourth kind (`#395`), on the challenge reader the rung itself uses.
     *
     * No new port: the probe a re-check reads is the same probe
     * `web-server-verify` reads, minted through the same door — which is what
     * `#152`'s *the check is a strategy, not a task* buys, one kind further on.
     */
    if (deps.webServerChallenges !== undefined) {
      checks.push(webServerRecheck({ challenges: deps.webServerChallenges }))
    }

    if (deps.mailboxRechecks !== undefined) {
      checks.push(mailboxRecheck({ rechecks: deps.mailboxRechecks }))
    }

    if (checks.length > 0) {
      verifiers.push(new AccountPersistenceVerifier({ accounts: deps.recheckableAccounts, checks }))
    }
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

  /**
   * The memory rung (#159). Like the heartbeat rung beside it, it reads the
   * Colony's own record and nothing else — the judgement happened at redemption
   * time, and this reads what that decided.
   */
  if (deps.memoryCarries !== undefined) {
    verifiers.push(new MemoryPersistenceVerifier({ carries: deps.memoryCarries }))
  }

  /**
   * The autonomy rung (#146). It reads one boolean from the Colony's own records
   * — whether a contract exists — and nothing else, which is what keeps it from
   * ever grading what the contract says.
   */
  if (deps.autonomyContracts !== undefined) {
    verifiers.push(new AutonomyVerifier({ contracts: deps.autonomyContracts }))
  }

  /**
   * The quest verifier (`#177`).
   *
   * **It needs nothing from the map, which is what `#766` changed.** It used to
   * be built last and closed over the registry, because a quest naming
   * `email-inbox` delegated to that module rather than to a copy of it. It does
   * not delegate any more: a rung reads an artefact minted against a live
   * challenge, a quest submission carries answers, and the two never met. The
   * named verifier is the gate the sponsor was always sold, and the gate is a
   * row — so `questReports.passedRung` is the whole dependency.
   */
  if (deps.questReports !== undefined && deps.questJudge !== undefined) {
    verifiers.push(new QuestReportVerifier({ reports: deps.questReports, judge: deps.questJudge }))
  }

  return new Map(verifiers.map((verifier) => [verifier.taskType, verifier]))
}

/** The verifier for a task type, or `undefined` if this process has none. */
export function verifierFor(taskType: TaskType, verifiers: VerifierRegistry): Verifier | undefined {
  return verifiers.get(taskType)
}
