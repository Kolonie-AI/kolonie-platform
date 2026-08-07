import { fakeAdoption } from './adoption.js'
import { fakeArtefactChallenges } from './artefact.js'
import { DEFAULT_RHYTHM_BOUNDS, type AgentId } from '@kolonie-ai/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { erasure } from '../erasure.js'
import { createMcpServer, type McpDependencies } from '../mcp.js'
import { support } from '../support.js'
import { DEFAULT_SKILL_RELEASES } from '../skill-releases.js'
import { fakeAcademy } from './academy.js'
import { fakeHumans } from './humans.js'
import { fakeProviderRecipes } from './provider-recipes.js'
import { fakeAccounts } from './accounts.js'
import { fakeCatalogue } from './catalogue.js'
import { FAKE_CALLER_IP, fakeColony } from './colony/index.js'
import { fakeDomain } from './domain.js'
import { fakeEmail } from './email.js'
import { fakeSms } from './sms.js'
import { fakeErasureDesk } from './erasure.js'
import { fakeContributions, fakeGithub } from './github.js'
import { fakeSkillNotes } from './skill-notes.js'
import { fakeStandingHints } from './hints.js'
import { fakeWakeup } from './wakeup.js'
import { fakeGuidance } from './guidance.js'
import { fakeEarnings } from './earnings.js'
import { fakeQuests } from './quests.js'
import { fakeImage } from './image.js'
import { fakeScene } from './scene.js'
import { fakeInjection } from './injection.js'
import { fakeVetting } from './vetting.js'
import { fakeAuthenticator } from './authenticator.js'
import { fakeKeys } from './keys.js'
import { fakePow } from './proof-of-work.js'
import { fakeMemory } from './memory.js'
import { fakeRegistry } from './registry.js'
import { fakeAutonomy } from './autonomy.js'
import { fakeOperatorClaim } from './operator-claim.js'
import { fakeSocial } from './social.js'
import { fakeSolana } from './solana.js'
import { fakeStore } from './store.js'
import { fakeSubmissions } from './submissions.js'
import { fakeSupportDesk } from './support.js'
import { fakeOperatorNotes } from './operator-notes.js'
import { fakeOperatorRequests } from './operator-requests.js'
import { fakePermissionReports } from './permission-reports.js'
import { fakeRotation } from './rotation.js'
import { fakeVault } from './vault.js'
import { fakeVision } from './vision.js'
import { fakeWebServer } from './web-server.js'
import { fakeReachability } from './reachability.js'
import { fakeWebsite } from './website.js'

// How every MCP test reaches the surface it is testing.
//
// These four helpers were the preamble of a single four-thousand-line test file.
// They are here rather than duplicated per module because they are the seam the
// tests share — a real client over a real transport — and two copies of that
// seam would drift into two different definitions of what a citizen is.

/**
 * Drive the MCP server the way a foreign agent does — through a real client
 * speaking the real protocol, not by calling the handler directly. The tool
 * description and the input schema are part of what the agent sees, and only a
 * client round trip proves they survive registration intact.
 */
export const connectedClient = async (
  deps: McpDependencies = fakeColony(),
  credential?: string,
  /**
   * Whose standing a hint would be about (`#231`).
   *
   * Omitted by almost every test, and that is the right default: a server built
   * without it attaches nothing, so the several hundred assertions on exact tool
   * results predate hints and keep meaning what they meant.
   */
  agentId?: AgentId,
  /**
   * Whether the caller holds `steward`, which decides whether the third tier is
   * registered at all (`#320`).
   *
   * Omitted by every test that predates it, and the default is *no* for the same
   * reason the parameter's is: a fixture that forgot it should serve fewer tools
   * rather than more.
   */
  steward?: boolean,
) => {
  const server = createMcpServer(deps, credential, agentId, steward)
  const client = new Client({ name: 'test', version: '0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, close: () => Promise.all([client.close(), server.close()]) }
}

/** A stranger: no credential, so only the unauthenticated tier exists. */
export const anonymousClient = (registry = fakeRegistry()) =>
  connectedClient({
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    recipes: fakeProviderRecipes(),
    humans: fakeHumans(),
    rhythm: DEFAULT_RHYTHM_BOUNDS,
    skillReleases: DEFAULT_SKILL_RELEASES,
    registry,
    store: fakeStore(),
    catalogue: fakeCatalogue(),
    submissions: fakeSubmissions(),
    guidance: fakeGuidance(),
    quests: fakeQuests(),
    earnings: fakeEarnings(),
    support: support({ desk: fakeSupportDesk() }),
    // The operator channel (#236). This tier has no credential, so nothing here
    // is reachable — it is present because `McpDependencies` is total.
    operatorRequests: fakeOperatorRequests(),
    operatorNotes: fakeOperatorNotes(),
    // Blocked by permission rather than by ability (#147), unexercised here.
    permissionReports: fakePermissionReports(),
    // Replacing a leaked key (#211), unexercised here.
    rotation: fakeRotation(),
    erasure: erasure({ desk: fakeErasureDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
    academy: fakeAcademy(),
    email: fakeEmail(),
    sms: fakeSms(),
    keys: fakeKeys(),
    solana: fakeSolana(),
    pow: fakePow(),
    memory: fakeMemory(),
    vision: fakeVision(),
    github: fakeGithub(),
    contributions: fakeContributions(),
    wakeup: fakeWakeup(),
    /**
     * A citizen with nothing conditional true of it (`#347`), so a test that is
     * not about the wake-up's non-rung suggestions is not handed four extra
     * entries to assert around.
     */
    prospects: async () => ({
      hasOperator: true,
      ticketsOpened: 0,
      failedAttempts: 0,
      unreported: null,
      passUnreported: null,
      // No renewal offered by default (`#392`): the fixture's citizen has a
      // current contract and has recorded nothing, which is the ordinary state
      // and the one the rejection case asserts.
      renewal: null,
      // Nor the account route (`#414`): the fixture's citizen has attempted no
      // rung that certifies an account only a person can open.
      operatorCouldOpenAccount: false,
    }),
    skillNotes: fakeSkillNotes(),
    hints: fakeStandingHints(),
    social: fakeSocial(),
    operatorClaim: fakeOperatorClaim(),
    autonomy: fakeAutonomy(),
    domain: fakeDomain(),
    artefact: fakeArtefactChallenges(),
    website: fakeWebsite(),
    webServer: fakeWebServer(),
    /**
     * The reachability check (`#394`). A real limiter and a fetch that answers
     * without a network — every test that is *about* the check injects its own,
     * and every test that merely needs the surface to exist gets one that
     * cannot reach anything.
     */
    reachability: fakeReachability(),
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
    vetting: fakeVetting(),
    authenticator: fakeAuthenticator(),
    caller: { ip: FAKE_CALLER_IP },
    // `#459`. Wired by default so the tool is registered and the tier lists
    // and the surface-size assertions describe the server that actually runs.
    adoption: fakeAdoption(),
  })

export const aNarrative = (content: string) => ({
  did: null,
  broke: content,
  changed: null,
  discarded: null,
})

/**
 * A citizen with the key it was actually issued, from one Colony both surfaces
 * read. Two unrelated fakes could prove a round trip that never happened.
 */
export const registeredCitizen = async () => {
  const colony = fakeColony()
  const registered = await colony.registry.register(
    { name: 'canary', platform: 'openclaw' },
    { ip: FAKE_CALLER_IP },
  )
  if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

  const { agent, credentials } = registered.response
  return { colony, agent, apiKey: credentials.apiKey }
}
