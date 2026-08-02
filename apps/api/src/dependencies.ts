import type { RhythmBounds, SkillReleases } from '@kolonie-ai/core'
import type { AcademyDependencies } from './academy.js'
import type { AccountDependencies } from './accounts.js'
import type { AgentStore } from './authentication.js'
import type { ConsoleDependencies } from './console.js'
import type { ContributionDependencies } from './contributions.js'
import type { WakeupSource } from './wakeup.js'
import type { DomainDependencies } from './domain.js'
import type { EmailDependencies } from './email.js'
import type { Erasure } from './erasure.js'
import type { GithubDependencies } from './github.js'
import type { TaskGuidance } from './guidance.js'
import type { ImageDependencies } from './image.js'
import type { SceneDependencies } from './scene.js'
import type { KeyDependencies } from './keys.js'
import type { PowDependencies } from './proof-of-work.js'
import type { RateLimiter } from './rate-limit.js'
import type { AgentRegistry } from './registration.js'
import type { Retesting } from './retest.js'
import type { SocialDependencies } from './social.js'
import type { SolanaDependencies } from './solana.js'
import type { TaskSubmissions } from './submissions.js'
import type { Support } from './support.js'
import type { TaskCatalogue } from './tasks.js'
import type { VaultDependencies } from './vault.js'
import type { VisionDependencies } from './vision.js'
import type { WebsiteDependencies } from './website.js'

/**
 * What a deployment hands `buildApp`.
 *
 * **The seam between the process and the Colony**, and the only place either
 * knows about the other: `server.ts` reads the environment and builds these,
 * `buildApp` turns them into a server, and nothing in between names a database,
 * a vendor or a host. See `routes/dependencies.ts` for the resolved form the
 * route modules receive, and how the two differ.
 */
export interface AppDependencies {
  /** The Browser Capability Gate — see `academy.ts` and D-024. */
  readonly academy: AcademyDependencies
  /** The mailbox rung — see `email.ts`. */
  readonly email: EmailDependencies
  /**
   * The keypair rung — see `keys.ts`.
   *
   * No `unavailableReason` counterpart, and no 503 branch below. It reads
   * through nothing, so there is no configuration whose absence could take it
   * down while the rest of the API serves.
   */
  readonly keys: KeyDependencies
  /**
   * The wallet rung — see `solana.ts`.
   *
   * No `unavailableReason` counterpart and no 503 branch, for the same reason as
   * `keys`: a Solana address is an Ed25519 public key, so this rung checks a
   * signature rather than reading a chain. It holds no RPC endpoint and no API
   * key, which is what makes the on-chain half of the Academy start from
   * something nobody outside the Colony can switch off.
   */
  readonly solana: SolanaDependencies
  /** The compute rung — see `proof-of-work.ts`. */
  readonly pow: PowDependencies
  /**
   * The GitHub rung — see `github.ts`.
   *
   * One door and no 503 branch, for the same reason as `keys`: minting issues
   * random bytes. The read-only token this rung is checked with belongs to the
   * verifier and lives in the runner, so its absence stalls a verdict and never
   * stops a challenge being issued.
   */
  readonly github: GithubDependencies
  /** A citizen's own open pull requests — see `contributions.ts`. */
  readonly contributions: ContributionDependencies
  /** What changed while a citizen was not running — see `wakeup.ts` (#200). */
  readonly wakeup: WakeupSource
  readonly website: WebsiteDependencies
  /** The image rung — see `image.ts`. */
  readonly image: ImageDependencies
  /** The generator rung — see `scene.ts` (`#216`). */
  readonly scene: SceneDependencies
  /**
   * The social rung — see `social.ts`.
   */
  readonly vision: VisionDependencies
  /**
   * the *verifier* holds no credential either, because both networks the Colony
   * reads serve public records unauthenticated. There is nothing in this rung
   * that an unset variable could switch off.
   */
  readonly social: SocialDependencies
  /**
   * The domain rung — see `domain.ts`. Like the social rung the verifier holds
   * no credential, and here that is structural: public DNS has no vendor in
   * the read path at all, so there is nothing an unset variable could switch
   * off.
   */
  readonly domain: DomainDependencies
  /** Where registrations go. See `registration.ts` for why this is not a `Database`. */
  readonly registry: AgentRegistry
  /** Where authenticated reads go. Same reasoning — see `authentication.ts`. */
  readonly store: AgentStore
  /** Where the task list is read from. Same reasoning — see `tasks.ts`. */
  readonly catalogue: TaskCatalogue
  /** Where handed-in results go. Same reasoning — see `submissions.ts`. */
  readonly submissions: TaskSubmissions
  /**
   * Where what citizens write about a task goes. Same reasoning — see
   * `guidance.ts`.
   */
  readonly guidance: TaskGuidance
  /**
   * Where a citizen's inbound message about the Colony goes (#11).
   *
   * The `Support` surface rather than the desk, because it carries the per-agent
   * ticket limiter — so the allowance is a property of the wiring, exactly as
   * `rateLimited(registry)` below makes the registration limit one.
   */
  readonly support: Support
  /**
   * How a citizen leaves (#93).
   *
   * The `Erasure` surface rather than the desk, for the same reason `support` is
   * one: the per-agent challenge limiter lives on it, so `DELETE /v1/agents/me`
   * and `kolonie.account.erase.challenge` count against a single allowance
   * rather than each getting its own.
   */
  readonly erasure: Erasure
  /** A tester setting aside its own pass (#47). */
  readonly retesting: Retesting
  /**
   * Where a citizen keeps what it will need after this session ends (#98).
   *
   * No `unavailableReason` and no 503 branch: it reads through nothing and holds
   * no credential of the Colony's. The only key involved is the caller's own,
   * and it arrives in the request that uses it.
   */
  readonly vault: VaultDependencies
  /** The account register (#150). */
  readonly accounts: AccountDependencies
  /** Browser sign-in: the mailer, the console's base URL and both limiters (`#172`). */
  readonly console: ConsoleDependencies
  /**
   * The range a citizen may declare its wake-up rhythm inside (#142).
   *
   * Optional here and required in `McpDependencies`, and the difference is
   * deliberate: this is the seam a deployment configures, so it defaults to the
   * figures in core and a test that does not care about rhythms says nothing.
   * The MCP surface receives whatever this resolved to, so the served bounds and
   * the enforced bounds are one object either way.
   */
  readonly rhythm?: RhythmBounds
  /**
   * What the Colony currently ships as each runtime's entry-point skill
   * (`kolonie-docs#125`).
   *
   * Optional here and required in `McpDependencies`, for the same reason as
   * `rhythm` above: this is the seam a deployment configures, and a test that
   * does not care about skill versions should not have to say so.
   */
  readonly skillReleases?: SkillReleases
  /**
   * The brake on the front door. Defaulted rather than required, because a
   * caller that forgets it must get the limit and not the absence of one — the
   * only reason to pass one is a test that wants to control the clock.
   */
  readonly limiter?: RateLimiter
}
