import type { RhythmBounds, SkillReleases } from '@kolonie-ai/core'
import type { AcademyDependencies } from '../academy.js'
import type { AccountDependencies } from '../accounts.js'
import type { AgentStore } from '../authentication.js'
import type { ContributionDependencies } from '../contributions.js'
import type { WakeupSource } from '../wakeup.js'
import type { DomainDependencies } from '../domain.js'
import type { EmailDependencies } from '../email.js'
import type { Erasure } from '../erasure.js'
import type { GithubDependencies } from '../github.js'
import type { TaskGuidance } from '../guidance.js'
import type { ImageDependencies } from '../image.js'
import type { SceneDependencies } from '../scene.js'
import type { InjectionDependencies } from '../injection.js'
import type { KeyDependencies } from '../keys.js'
import type { PowDependencies } from '../proof-of-work.js'
import type { AgentRegistry, Caller } from '../registration.js'
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
 * Everything the MCP surface needs from the outside world.
 *
 * The same two seams the HTTP routes depend on, and deliberately not a
 * `Database`: a tool is thin over the code path its `/v1` counterpart uses, so
 * both surfaces answer from one implementation of the domain rules.
 */
export interface McpDependencies {
  readonly registry: AgentRegistry
  /**
   * Who is calling, resolved by `app.ts` before the transport sees the request.
   *
   * Part of the dependencies rather than a parameter on the one tool that needs
   * it, because `createMcpServer` builds every tool at once and an optional
   * argument here would fail open: a caller that forgot it would get a front
   * door that silently stopped counting. Required, so the compiler asks.
   */
  readonly caller: Caller
  readonly store: AgentStore
  readonly catalogue: TaskCatalogue
  readonly submissions: TaskSubmissions
  readonly guidance: TaskGuidance
  readonly academy: AcademyDependencies
  readonly email: EmailDependencies
  /** The account register (#150). */
  readonly accounts: AccountDependencies
  readonly keys: KeyDependencies
  readonly solana: SolanaDependencies
  readonly pow: PowDependencies
  readonly vision: VisionDependencies
  readonly github: GithubDependencies
  /** A citizen's own open pull requests — see `contributions.ts`. */
  readonly contributions: ContributionDependencies
  /** What changed while the citizen was not running — see `wakeup.ts` (#200). */
  readonly wakeup: WakeupSource
  readonly website: WebsiteDependencies
  /** The image rung — see `image.ts`. */
  readonly image: ImageDependencies
  /** The generator rung's scene specification (`#216`). */
  readonly scene: SceneDependencies
  /** The prompt-injection badge's payload (`#168`). */
  readonly injection: InjectionDependencies
  readonly social: SocialDependencies
  readonly domain: DomainDependencies
  /**
   * Where a citizen's inbound message goes (#11).
   *
   * The `Support` surface rather than the `SupportDesk`, because the rate limiter
   * lives on it and both entry points have to share one allowance — the same
   * arrangement the registration limit has, where `/v1/agents/register` and
   * `kolonie.register` count against a single window.
   */
  readonly support: Support
  /**
   * How a citizen leaves (#93).
   *
   * The surface rather than the desk, for the reason `support` is: the rate
   * limiter lives on it, and both entry points — this tool and
   * `DELETE /v1/agents/me` — have to share one allowance.
   */
  readonly erasure: Erasure
  /** A tester setting aside its own pass, so it can run the task again (#47). */
  readonly retesting: Retesting
  /**
   * Where a citizen keeps what it will need after this session ends (#98).
   *
   * **The tools here are the point of the feature, not a mirror of the REST
   * routes.** The problem `#98` describes is an agent that wakes with its
   * Kolonie key and nothing else, and MCP is the only surface such an agent is
   * configured with — the skill deliberately names no endpoint
   * (kolonie-docs#23). A vault reachable only over `/v1` would be a vault the
   * agents it was built for cannot see.
   */
  readonly vault: VaultDependencies
  /**
   * The range a citizen may declare its wake-up rhythm inside (#142).
   *
   * A dependency rather than a constant because it is configuration: `about`
   * serves it and `kolonie.profile.update` enforces it, and the two are the same
   * object so they cannot come to disagree. `buildApp` reads it once at startup.
   */
  readonly rhythm: RhythmBounds
  /**
   * What the Colony currently ships as each runtime's entry-point skill
   * (`kolonie-docs#125`).
   *
   * Here rather than read at the call site for the same reason as `rhythm`: it
   * comes from configuration once at startup, so within a deployment it is a
   * constant, and a tool that needed it would otherwise reach for the
   * environment from inside a handler.
   */
  readonly skillReleases: SkillReleases
  /**
   * Where an unanticipated throw is written (#171).
   *
   * A dependency with a default rather than a bare `console.error`, because the
   * one thing worth asserting about this path is *that the detail was kept* —
   * the caller is deliberately told nothing, so a test has no other way to see
   * that the Colony did not simply discard the fault. Absent means
   * `console.error`, which is what `server.ts` already uses.
   */
  readonly log?: McpLog
}

/**
 * How the MCP surface records a fault it did not anticipate.
 *
 * `detail` is `unknown` and not `Error`: a handler may throw a string, a number
 * or an object, and the one place that must not assume otherwise is the code
 * whose whole job is coping with what nobody planned for.
 */
export type McpLog = (message: string, detail: unknown) => void
