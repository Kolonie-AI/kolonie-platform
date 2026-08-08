import { fakeArtefactChallenges } from '../artefact.js'
import type { SkillReleases } from '@kolonie-ai/core'
import type { AcademyDependencies } from '../../academy.js'
import type { ConsoleDependencies } from '../../console.js'
import type { EmailDependencies } from '../../email.js'
import type { SmsDependencies } from '../../sms.js'
import type { KeyDependencies } from '../../keys.js'
import type { SolanaDependencies } from '../../solana.js'
import type { MemoryDependencies } from '../../memory.js'
import type { PowDependencies } from '../../proof-of-work.js'
import type { GithubDependencies } from '../../github.js'
import type { ContributionDependencies } from '../../contributions.js'
import type { WebsiteDependencies } from '../../website.js'
import type { WebServerDependencies } from '../../web-server.js'
import type { WakeDependencies } from '../../wake.js'
import type { WishDependencies } from '../../account-wishes.js'
import type { ImageDependencies } from '../../image.js'
import type { SceneDependencies } from '../../scene.js'
import type { InjectionDependencies } from '../../injection.js'
import type { VettingDependencies } from '../../vetting.js'
import type { AuthenticatorDependencies } from '../../authenticator.js'
import type { SocialDependencies } from '../../social.js'
import type { DomainDependencies } from '../../domain.js'
import type { VisionDependencies } from '../../vision.js'
import type { VaultDependencies } from '../../vault.js'
import { DEFAULT_SKILL_RELEASES } from '../../skill-releases.js'
import { fakeAcademy } from '../academy.js'
import { fakeEmail } from '../email.js'
import { fakeSms } from '../sms.js'
import { fakeKeys } from '../keys.js'
import { fakeSolanaChallenges } from '../solana.js'
import { fakePow } from '../proof-of-work.js'
import { fakeMemory } from '../memory.js'
import { fakeContributions, fakeGithub } from '../github.js'
import { fakeSocial } from '../social.js'
import { fakeDomain } from '../domain.js'
import { fakeWebServer, type FakeWebServerChallenges } from '../web-server.js'
import { fakeWake, type FakeWakeChallenges } from '../wake.js'
import { fakeWishList, type FakeWishes } from '../account-wishes.js'
import { fakeWebsite } from '../website.js'
import { fakeImage } from '../image.js'
import { fakeScene } from '../scene.js'
import { fakeInjection } from '../injection.js'
import { fakeVetting } from '../vetting.js'
import { fakeAuthenticator } from '../authenticator.js'
import { fakeVision } from '../vision.js'
import { fakeVault } from '../vault.js'
import { fakeConsole } from '../console.js'
import { noObstruction } from '../obstruction.js'
import { fakeReachability } from '../reachability.js'
import type { ReachabilityDependencies } from '../../reachability.js'
import type { ArtefactDependencies } from '../../artefact.js'

/**
 * The Academy rungs, in memory.
 *
 * One field per rung and one line of wiring each, which is what makes this the
 * half of the fixture that grows: a new rung is a new field here and nowhere
 * else. Every rung's own behaviour lives in its own fixture file already —
 * `fakeKeys`, `fakePow`, `fakeVault` — so what this file holds is which fake is
 * behind which rung, and nothing about how any of them works.
 */
export interface FakeRungs {
  /** The Browser Capability Gate, behind both surfaces. Overridable the same way. */
  readonly academy: AcademyDependencies
  /** The mailbox rung, behind both surfaces. Overridable the same way. */
  readonly console: ConsoleDependencies
  readonly email: EmailDependencies
  /** The two phone rungs, behind both surfaces (`#411`). */
  readonly sms: SmsDependencies
  /** The keypair rung, behind both surfaces. Overridable the same way. */
  readonly keys: KeyDependencies
  /** The wallet rung, behind both surfaces. Overridable the same way. */
  readonly solana: SolanaDependencies
  /** The compute rung, behind both surfaces. Overridable the same way. */
  readonly pow: PowDependencies
  /** The memory rung, behind both surfaces. Overridable the same way (`#159`). */
  readonly memory: MemoryDependencies
  /** The GitHub rung, behind both surfaces. Overridable the same way. */
  readonly github: GithubDependencies
  readonly contributions: ContributionDependencies
  readonly social: SocialDependencies
  readonly domain: DomainDependencies
  readonly website: WebsiteDependencies
  /** The rung above it (`#244`), with its own store so a test can drive the probes. */
  readonly webServer: WebServerDependencies & { readonly challenges: FakeWebServerChallenges }
  /**
   * The wake rung (`#518`), with its own store so a test can read the secret the
   * mint issued and knock the way the Colony would.
   */
  readonly wake: WakeDependencies & { readonly challenges: FakeWakeChallenges }
  /**
   * The list an agent and its operator share (`#527`), with its own store so a
   * test can put something on it and read it back.
   */
  readonly wishes: WishDependencies & { readonly store: FakeWishes }
  /**
   * The reachability check (`#394`) — beside the web rungs because it is about
   * the same wall, and separate from them because it grants nothing.
   *
   * A real limiter and a fetch that answers without a network. A test *about*
   * the check injects its own; every other test needs only that the surface
   * exists and gets one that cannot reach anything.
   */
  readonly reachability: ReachabilityDependencies
  /** The rung that publishes an artefact and addresses it (`#389`). */
  readonly artefact: ArtefactDependencies
  readonly image: ImageDependencies
  readonly scene: SceneDependencies
  readonly injection: InjectionDependencies
  readonly vetting: VettingDependencies
  readonly authenticator: AuthenticatorDependencies
  readonly vision: VisionDependencies
  /** The vault, behind both surfaces. Overridable the same way (#98). */
  readonly vault: VaultDependencies
  /** What the Colony ships per runtime (`kolonie-docs#125`). */
  readonly skillReleases: SkillReleases
}

export function fakeRungs(): FakeRungs {
  // Held rather than built inline, because two things read it: the wallet
  // routes, and `verifiedWalletOf` in `agent.ts`. One store, so a rung cleared
  // on one surface is visible on the other.
  const solanaChallenges = fakeSolanaChallenges()

  return {
    academy: fakeAcademy(),
    email: fakeEmail(),
    sms: fakeSms(),
    keys: fakeKeys(),
    solana: { challenges: solanaChallenges, obstruction: noObstruction },
    pow: fakePow(),
    memory: fakeMemory(),
    github: fakeGithub(),
    contributions: fakeContributions(),
    social: fakeSocial(),
    domain: fakeDomain(),
    artefact: fakeArtefactChallenges(),
    website: fakeWebsite(),
    webServer: fakeWebServer(),
    wake: fakeWake(),
    wishes: fakeWishList(),
    reachability: fakeReachability(),
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
    vetting: fakeVetting(),
    authenticator: fakeAuthenticator(),
    vision: fakeVision(),
    vault: { vault: fakeVault() },
    console: fakeConsole(),
    skillReleases: DEFAULT_SKILL_RELEASES,
  }
}
