import type { ApiError, RhythmBounds } from '@kolonie-ai/core'
import type { AcademyDependencies } from '../academy.js'
import type { AccountDependencies, AccountResolution } from '../accounts.js'
import type { AgentStore } from '../authentication.js'
import type { ContributionDependencies } from '../contributions.js'
import type { DomainDependencies } from '../domain.js'
import type { EmailDependencies } from '../email.js'
import type { Erasure } from '../erasure.js'
import type { GithubDependencies } from '../github.js'
import type { TaskGuidance } from '../guidance.js'
import type { ImageDependencies } from '../image.js'
import type { KeyDependencies } from '../keys.js'
import type { PowDependencies } from '../proof-of-work.js'
import type { AgentRegistry } from '../registration.js'
import type { Retesting } from '../retest.js'
import type { SocialDependencies } from '../social.js'
import type { SolanaDependencies } from '../solana.js'
import type { TaskSubmissions } from '../submissions.js'
import type { Support } from '../support.js'
import type { TaskCatalogue } from '../tasks.js'
import type { VaultDependencies } from '../vault.js'
import type { VisionDependencies } from '../vision.js'
import type { WebsiteDependencies } from '../website.js'

/**
 * Everything a route module needs, as one argument.
 *
 * **This is `AppDependencies` after `buildApp` has resolved it, not a copy of
 * it.** The two differ in exactly the places where resolving happened, and each
 * difference is the point of the type:
 *
 * - `registry` here is the rate-limited one. `buildApp` wraps the raw registry
 *   once and the unwrapped one is not in scope again, so no route can reach past
 *   the limit — the property holds by construction rather than by every call
 *   site remembering.
 * - `rhythm` is required here and optional there. The default is applied once, at
 *   the seam a deployment configures; a route that had to cope with `undefined`
 *   would be coping with a case that cannot reach it.
 * - `limiter` is absent. It exists to build `registry` and has no other reader.
 *
 * **The gates are fields rather than something a route recomputes.** Before this
 * they were consts in `buildApp`'s scope and every handler closed over them,
 * which is what made the handlers impossible to move. Passing them explicitly is
 * what this interface is for — see #195.
 */
export interface RouteDependencies {
  /** The rate-limited registry. See the note above: never the raw one. */
  readonly registry: AgentRegistry
  readonly store: AgentStore
  readonly catalogue: TaskCatalogue
  readonly submissions: TaskSubmissions
  readonly guidance: TaskGuidance
  readonly support: Support
  readonly erasure: Erasure
  readonly retesting: Retesting
  readonly academy: AcademyDependencies
  readonly email: EmailDependencies
  readonly keys: KeyDependencies
  readonly solana: SolanaDependencies
  readonly pow: PowDependencies
  readonly github: GithubDependencies
  readonly contributions: ContributionDependencies
  readonly website: WebsiteDependencies
  readonly image: ImageDependencies
  readonly social: SocialDependencies
  readonly domain: DomainDependencies
  readonly vision: VisionDependencies
  readonly vault: VaultDependencies
  readonly accounts: AccountDependencies
  /** Resolved from `AppDependencies.rhythm`, so a route never sees `undefined`. */
  readonly rhythm: RhythmBounds

  /**
   * The Browser Capability Gate's answer when it is not configured.
   *
   * A 503 rather than a 404: the endpoint exists and is temporarily unable to
   * serve, which is what an agent needs in order to retry rather than conclude
   * the Colony has no such rung.
   */
  readonly unavailable: ApiError | undefined
  /**
   * The capability rung's own answer, and a separate one on purpose.
   *
   * Before the Level 1 rebuild a single `unavailable` covered every Academy
   * route, so an unset hCaptcha sitekey took the promoting rung down with the
   * badge — a third party's configuration deciding whether the Colony's ladder
   * worked.
   */
  readonly capabilityDown: ApiError | undefined
  /**
   * The four browser stages, each evaluated **per request** rather than once.
   *
   * Functions and not values, so a test may hand the routes a
   * differently-configured academy without rebuilding the app.
   */
  readonly perceptionDown: () => ApiError | undefined
  readonly interactionDown: () => ApiError | undefined
  readonly interstitialDown: () => ApiError | undefined
  readonly persistenceDown: () => ApiError | undefined
  /** The mailbox rung's own answer, separate for the same reason as the others. */
  readonly emailDown: ApiError | undefined
  /** The register read the task listing makes (#151). Never a write path. */
  readonly resolution: AccountResolution
  /**
   * Whether the inbound mail route is mounted at all.
   *
   * **Absent secret means absent route**, not an open one. Everything else here
   * degrades to a 503 when unconfigured, which is right for a rung an agent is
   * climbing and wrong for this: the endpoint turns *a mail arrived* into a fact
   * the Colony pays a reward for, and a version that answered without checking a
   * secret would let anyone on the internet pass the mailbox rung for any agent,
   * by asserting a delivery that never happened. So it fails closed — and
   * `server.ts` says so at startup rather than leaving it to be discovered.
   */
  readonly inboundSecret: string | undefined
}
