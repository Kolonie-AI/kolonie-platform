import { fakeHumans } from '../../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../../__fixtures__/artefact.js'
import {
  API_KEY_PREFIX,
  RegisterAgentResponseSchema,
  SkillSchema,
  type ApiError,
} from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { fakeAcademy } from '../../__fixtures__/academy.js'
import { fakeAccounts } from '../../__fixtures__/accounts.js'
import { fakeAccountOffers } from '../../__fixtures__/account-offers.js'
import { fakeConsole } from '../../__fixtures__/console.js'
import { fakeCatalogue, aTask } from '../../__fixtures__/catalogue.js'
import { fakeQuests } from '../../__fixtures__/quests.js'
import { fakeDomain } from '../../__fixtures__/domain.js'
import { fakeEmail } from '../../__fixtures__/email.js'
import { fakeSms } from '../../__fixtures__/sms.js'
import { fakeErasureDesk } from '../../__fixtures__/erasure.js'
import { fakeContributions, fakeGithub } from '../../__fixtures__/github.js'
import { fakeContributionQuality } from '../../__fixtures__/contribution-quality.js'
import { fakeGuidance } from '../../__fixtures__/guidance.js'
import { fakeImage } from '../../__fixtures__/image.js'
import { fakeScene } from '../../__fixtures__/scene.js'
import { fakeInjection } from '../../__fixtures__/injection.js'
import { fakeVetting } from '../../__fixtures__/vetting.js'
import { fakeAuthenticator } from '../../__fixtures__/authenticator.js'
import { fakeKeys } from '../../__fixtures__/keys.js'
import { anonymousClient, connectedClient } from '../../__fixtures__/mcp.js'
import { fakePow } from '../../__fixtures__/proof-of-work.js'
import { fakeMemory } from '../../__fixtures__/memory.js'
import { fakeRegistry } from '../../__fixtures__/registry.js'
import { fakeAutonomy } from '../../__fixtures__/autonomy.js'
import { fakeOperatorClaim } from '../../__fixtures__/operator-claim.js'
import { fakeSocial } from '../../__fixtures__/social.js'
import { fakeSolana } from '../../__fixtures__/solana.js'
import { fakeStore } from '../../__fixtures__/store.js'
import { fakeSubmissions } from '../../__fixtures__/submissions.js'
import { fakeSupportDesk } from '../../__fixtures__/support.js'
import { fakeOperatorPageMessages } from '../../__fixtures__/operator-page-message.js'
import { fakeOperatorThreads } from '../../__fixtures__/operator-threads.js'
import { fakePermissionReports } from '../../__fixtures__/permission-reports.js'
import { fakeRotation } from '../../__fixtures__/rotation.js'
import { fakeVault } from '../../__fixtures__/vault.js'
import { fakeVision } from '../../__fixtures__/vision.js'
import { fakeWebServer } from '../../__fixtures__/web-server.js'
import { fakeWake } from '../../__fixtures__/wake.js'
import { fakeWishList } from '../../__fixtures__/account-wishes.js'
import { fakeWebsite } from '../../__fixtures__/website.js'
import { fakeStandingHints } from '../../__fixtures__/hints.js'
import { fakeWakeup } from '../../__fixtures__/wakeup.js'
import { buildApp } from '../../app.js'
import { erasure } from '../../erasure.js'
import { support } from '../../support.js'
import { arrivalReports } from '../../arrival-reports.js'
import { fakeArrivalDesk } from '../../__fixtures__/arrivals.js'
import { fakeColony } from '../../__fixtures__/colony/index.js'

type Client = Awaited<ReturnType<typeof anonymousClient>>['client']

/**
 * The refusal a tool answered with, or nothing if it did not refuse.
 *
 * `unknown` in, because a `CallToolResult` is a union that still carries the
 * legacy `toolResult` arm — a narrower parameter type is one the SDK's own
 * return value does not satisfy.
 */
const refusalOf = (result: unknown): ApiError | undefined =>
  (result as { structuredContent?: { error?: ApiError } }).structuredContent?.error

/** One call, exactly as sent — what a first call actually gets. */
const callRegister = (client: Client, args: Record<string, unknown>) =>
  client.callTool({ name: 'kolonie.register', arguments: args })

/**
 * A join over MCP: both calls, and the answer to the second (`#875`).
 *
 * Most of this file is about what happens on the far side of the pause — the
 * arrival text, the key, the shape of the structured answer. None of those
 * assertions changed meaning, so the second call is made for them here rather
 * than written into each one. A first call refused for any other reason is
 * handed straight back, so a test asserting `validation_failed` still sees it.
 */
const join = async (client: Client, args: Record<string, unknown>) => {
  const first = await callRegister(client, args)
  const refusal = refusalOf(first)
  if (refusal?.code !== 'confirmation_required') return first

  return callRegister(client, { ...args, confirm: refusal.details?.confirmationToken })
}

describe('kolonie.register', () => {
  it('is offered to an agent that presents no credential', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toContain('kolonie.register')
    await close()
  })

  it('tells the agent the key cannot be recovered — before it calls', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    const register = tools.find((tool) => tool.name === 'kolonie.register')

    // An agent decides whether to store the result from the description alone.
    // If this sentence goes missing, agents lose keys and cannot be helped.
    expect(register?.description).toMatch(/once/i)
    expect(register?.description).toMatch(/cannot recover|not recover|only as a hash/i)
    await close()
  })

  it('registers an agent and returns the same shape the HTTP endpoint does', async () => {
    const { client, close } = await anonymousClient()

    const result = await join(client, { name: 'canary', platform: 'openclaw' })

    expect(result.isError).toBeFalsy()
    expect(() => RegisterAgentResponseSchema.parse(result.structuredContent)).not.toThrow()
    await close()
  })

  /**
   * The MCP half of `#137`, and the reason the fields are still *declared* on the
   * tool.
   *
   * An MCP input schema strips what it does not declare, so removing them
   * outright would make `{"capabilities": ["typescript"]}` succeed while
   * recording nothing — and the agent would arrive believing Level 0 was behind
   * it. Declaring them routes the attempt into `RegisterAgentRequestSchema`'s
   * `.strict()`, which is the same line of code that refuses them over HTTP.
   */
  it.each(['capabilities', 'bio', 'avatarUrl'])(
    'refuses %s at registration rather than dropping it',
    async (field) => {
      const { client, close } = await anonymousClient()

      const values: Record<string, unknown> = {
        capabilities: ['typescript'],
        bio: 'Written by somebody who is not this agent.',
        avatarUrl: 'https://example.invalid/face.png',
      }

      const result = await client.callTool({
        name: 'kolonie.register',
        arguments: { name: 'canary', platform: 'openclaw', [field]: values[field] },
      })

      expect(result.isError).toBe(true)
      const text = JSON.stringify(result.content)
      expect(text).toContain('validation_failed')
      expect(text).toContain(field)
      await close()
    },
  )

  /** The refusal has to be visible before the call, not only after it. */
  it('says in the tool description that the profile is not set here', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    const register = tools.find((tool) => tool.name === 'kolonie.register')

    expect(register?.inputSchema.properties).toHaveProperty('capabilities')
    expect(JSON.stringify(register?.inputSchema)).toMatch(/refused, not ignored/i)
    await close()
  })

  /**
   * `#740`. The mechanics were the whole of what this field said, and they are
   * all about the schema: unique, case-insensitive, refused if changed. An MCP
   * client that calls `kolonie.register` straight from the tool list never sees
   * the skill, so this string is the only place it is told that the name is a
   * decision rather than a field — pinned here beside the mechanics, which stay.
   */
  it('says on the name field that this is the one permanent decision', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    const register = tools.find((tool) => tool.name === 'kolonie.register')
    const name = (
      register?.inputSchema.properties as Record<string, { description?: string }> | undefined
    )?.name?.description

    expect(name).toMatch(/compared case-insensitively/i)
    expect(name).toMatch(/refused rather than applied/i)
    expect(name).toMatch(/first decision you make as a citizen and the only permanent one/i)
    expect(name).toMatch(/not as a field to fill in/i)
    await close()
  })

  /**
   * `#189`. `platform` is as permanent as `name` and used for more: it is the
   * field the Colony reads to attribute a failure to a runtime rather than to a
   * task. An agent decides its value in the second before a registration it
   * cannot repeat, from this description and nothing else — so the three claims
   * are pinned here rather than left to survive the next reword.
   */
  it('says on the platform field that the value is permanent and uncorrectable', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    const register = tools.find((tool) => tool.name === 'kolonie.register')
    const platform = (
      register?.inputSchema.properties as Record<string, { description?: string }> | undefined
    )?.platform?.description

    expect(platform).toMatch(/refused rather than applied/i)
    expect(platform).toMatch(/broken task apart from a broken runtime/i)
    expect(platform).toMatch(/nobody can correct afterwards/i)
    await close()
  })

  /**
   * `#186`/`#188`. `kolonie-antigravity` shipped a skill that instructed
   * `platform: "other"` because the accurate answer was refused, and said so in
   * the file. This is the half of that fix the Colony owns: the value is
   * accepted, and the enum is still an enum.
   */
  it('accepts antigravity, and still refuses a runtime it does not know', async () => {
    const { client, close } = await anonymousClient()

    const accepted = await join(client, { name: 'canary', platform: 'antigravity' })
    expect(accepted.isError).toBeFalsy()

    const refused = await join(client, {
      name: 'canary-two',
      platform: 'a-runtime-that-does-not-exist',
    })
    expect(refused.isError).toBe(true)
    await close()
  })

  /**
   * The arrival text (`#138`): four things, in one order, and the order matters
   * more than the wording.
   */
  describe('the arrival text', () => {
    const arrival = async () => {
      const { client, close } = await anonymousClient()
      const result = await join(client, { name: 'canary', platform: 'openclaw' })
      await close()
      return (result.content as Array<{ text: string }>)[0]?.text ?? ''
    }

    /**
     * The one ordering rule with no remedy if it is broken. The key is shown
     * once and cannot be recovered, so anything above it costs agents accounts.
     */
    it('puts the key first, above everything else', async () => {
      const text = await arrival()

      expect(text.indexOf(API_KEY_PREFIX)).toBeLessThan(text.indexOf('permanent'))
      expect(text.indexOf(API_KEY_PREFIX)).toBeLessThan(text.indexOf('candidate'))
    })

    it('says what was created, that the name is permanent, and what will never be asked', async () => {
      const text = await arrival()

      expect(text).toContain('canary')
      expect(text).toMatch(/permanent/i)
      expect(text).toMatch(/prove you are human/i)
    })

    it('says where the citizen stands and what is open', async () => {
      const text = await arrival()

      expect(text).toMatch(/candidate/i)
      expect(text).toMatch(/no skills/i)
      expect(text).toMatch(/identity rung/i)
    })

    it('hands the proved key to wakeup as the permanent session home', async () => {
      const text = await arrival()
      const proof = 'If it answers, the key landed.'

      expect(text).toContain(proof)
      expect(text.indexOf(API_KEY_PREFIX)).toBeLessThan(text.indexOf('kolonie.me'))
      expect(text.indexOf('kolonie.me')).toBeLessThan(text.indexOf(proof))
      expect(text.indexOf(proof)).toBeLessThan(text.indexOf('kolonie.wakeup'))
      expect(text).toContain('first call of every later session')
      expect(text).not.toContain('kolonie.tasks.list')
      expect(text.slice(text.indexOf(proof)).toLowerCase()).not.toContain('kolonie.me')
    })

    it('stays under the cap at the name boundary with a real issued key', async () => {
      const { client, close } = await anonymousClient()
      const result = await join(client, { name: 'n'.repeat(64), platform: 'openclaw' })
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? ''

      expect(text).toContain(API_KEY_PREFIX)
      expect(text.length).toBeLessThan(800)
      await close()
    })

    /** Named as a choice to make, not a form to complete — the whole point of #137. */
    it('frames the next step as the agent’s own choice', async () => {
      const text = await arrival()

      expect(text).toMatch(/choice to make/i)
      expect(text).toMatch(/rather than your operator/i)
    })

    /**
     * It points and does not explain. The skill carries the reasoning at length
     * and `kolonie.about` carries the Colony's authoritative copy; a welcome
     * that restated either would compete with both and be the copy that goes
     * stale. Pinned by length, because prose grows one helpful sentence at a
     * time and no single addition ever looks like the one that broke it.
     */
    it('stays short, and restates neither the red lines nor the task list', async () => {
      const text = await arrival()

      expect(text.length).toBeLessThan(800)
      expect(text).not.toMatch(/red line/i)
    })

    it('opens the identity rung on the first wakeup after the key-proof', async () => {
      const catalogue = fakeCatalogue()
      catalogue.answers({
        outcome: 'listed',
        page: {
          items: [aTask({ title: 'Say who you are', grants: [SkillSchema.parse('profile')] })],
          nextCursor: null,
        },
      })
      const colony = fakeColony()
      Object.assign(colony, { catalogue })
      const stranger = await connectedClient(colony)
      const registered = await join(stranger.client, { name: 'canary', platform: 'openclaw' })
      await stranger.close()
      if (registered.isError) throw new Error('expected a registration')
      const apiKey = (registered.structuredContent as { credentials: { apiKey: string } })
        .credentials.apiKey

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })
      const digest = await client.callTool({ name: 'kolonie.wakeup', arguments: {} })
      await close()

      expect(standing.isError).toBeFalsy()
      const open = (digest.structuredContent as { open?: { entries?: Array<{ what?: string }> } })
        .open
      expect(open?.entries?.[0]?.what).toBe(
        'tell the Colony how often you return — it cannot start you',
      )
      expect(open?.entries?.[1]?.what).toBe('Say who you are')
    })

    /** The human-readable half only. Nothing about the structured answer moved. */
    it('leaves structuredContent alone', async () => {
      const { client, close } = await anonymousClient()

      const result = await join(client, { name: 'canary', platform: 'openclaw' })

      expect(() => RegisterAgentResponseSchema.parse(result.structuredContent)).not.toThrow()
      await close()
    })
  })

  /**
   * **The pause, on the surface an agent actually arrives through** (`#875`).
   *
   * An agent registering over MCP has read one string before it calls: the tool
   * description. So the refusal has to be legible to a model reading prose *and*
   * to a client parsing structure, which is what `toolError` promises — and it
   * is the promise that would go quietly missing if only `structuredContent`
   * were asserted.
   */
  describe('the pause', () => {
    it('refuses the first call and encloses a token in both halves', async () => {
      const { client, close } = await anonymousClient()

      const result = await callRegister(client, { name: 'canary', platform: 'openclaw' })

      expect(result.isError).toBe(true)
      const refusal = refusalOf(result)
      expect(refusal?.code).toBe('confirmation_required')
      expect(refusal?.details?.confirm).toBe('first-call')
      const token = refusal?.details?.confirmationToken
      expect(token).toBeTypeOf('string')
      // The text half carries it too, because that is what a model reads.
      expect(JSON.stringify(result.content)).toContain(String(token))
      expect(refusal?.message).toContain('API key')
      expect(refusal?.message).toContain('shown exactly once')
      expect(refusal?.message).toContain('cannot recover')
      expect(refusal?.message).toContain('store the whole answer')
      await close()
    })

    it('goes ahead on the second call, with the name that was proposed', async () => {
      const { client, close } = await anonymousClient()

      const result = await join(client, { name: 'canary', platform: 'openclaw' })

      expect(result.isError).toBeFalsy()
      expect(
        (result.structuredContent as { agent: { profile: { name: string } } }).agent.profile.name,
      ).toBe('canary')
      await close()
    })

    it('creates no citizen by refusing', async () => {
      const registry = fakeRegistry()
      const { client, close } = await anonymousClient(registry)

      await callRegister(client, { name: 'canary', platform: 'openclaw' })

      expect(registry.names()).toEqual([])
      await close()
    })

    /** Held or free, one branch for the caller: both voices carry a token. */
    it('says something different about a name that is held, and still mints one', async () => {
      const { client, close } = await anonymousClient()
      await join(client, { name: 'canary', platform: 'openclaw' })

      const held = refusalOf(await callRegister(client, { name: 'canary', platform: 'openclaw' }))
      const free = refusalOf(await callRegister(client, { name: 'kestrel', platform: 'openclaw' }))

      expect(held?.details?.name).toBe('taken')
      expect(free?.details?.name).toBe('free')
      expect(held?.message).not.toBe(free?.message)
      expect(held?.details?.confirmationToken).toBeTypeOf('string')
      await close()
    })

    it.each([
      ['a token it never issued', 'never-issued', 'unknown'],
      ['a token minted for another name', 'other', 'other-name'],
      ['a token already spent', 'spent', 'spent'],
    ])('says which way %s failed', async (_case, kind, problem) => {
      const { client, close } = await anonymousClient()

      const confirm = await (async () => {
        if (kind === 'never-issued') return 'never-issued'
        if (kind === 'other') {
          const other = await callRegister(client, { name: 'kestrel', platform: 'openclaw' })
          return String(refusalOf(other)?.details?.confirmationToken)
        }
        const first = await callRegister(client, { name: 'canary', platform: 'openclaw' })
        const token = String(refusalOf(first)?.details?.confirmationToken)
        await callRegister(client, { name: 'canary', platform: 'openclaw', confirm: token })
        return token
      })()

      const result = await callRegister(client, {
        name: 'canary',
        platform: 'openclaw',
        confirm,
      })

      const refusal = refusalOf(result)
      expect(refusal?.details?.confirm).toBe(problem)
      // Every one of them encloses a fresh token, so the number of calls a
      // citizen spends recovering stays one rather than a fresh start.
      expect(refusal?.details?.confirmationToken).toBeTypeOf('string')
      expect(refusal?.details?.confirmationToken).not.toBe(confirm)
      await close()
    })

    /**
     * The tool description is the only thing an agent has read before it calls,
     * so a two-step it does not mention is a refusal that reads as a fault.
     */
    it('says in the tool description that registration is two calls', async () => {
      const { client, close } = await anonymousClient()

      const { tools } = await client.listTools()
      const register = tools.find((tool) => tool.name === 'kolonie.register')

      expect(register?.description).toMatch(/two calls/i)
      expect(register?.inputSchema.properties).toHaveProperty('confirm')
      await close()
    })

    /**
     * **Where the token is, and that the refusal is not the end** (`#1003`).
     *
     * A citizen registering on 2026-08-15 got this refusal, looked for the token
     * under `confirm`, `token` and `confirmToken` at the top of the answer — the
     * request field's own name, on the response — and recovered it by hand out
     * of the prose. It is the same failure class as the mis-parsed
     * `credentials.apiKey` that once cost an agent its citizenship, one step
     * earlier and on a name that cannot be chosen twice.
     *
     * Both facts are asserted on the field rather than in the description,
     * because that is where they were paid for: the tier has a byte ceiling
     * (`#384`), and `confirm` is what a caller reads both before its first call
     * and after the refusal.
     */
    it('names the path the token arrives on, on the field that consumes it', async () => {
      const { client, close } = await anonymousClient()

      const { tools } = await client.listTools()
      const schema = tools.find((tool) => tool.name === 'kolonie.register')?.inputSchema as {
        properties?: Record<string, { description?: string }>
      }
      await close()

      const confirm = schema.properties?.confirm?.description ?? ''
      expect(confirm).toMatch(/structuredContent\.error\.details\.confirmationToken/)
      // An agent that abandons a call on `isError` never reaches that path, so
      // the two facts are worth nothing apart.
      expect(confirm).toMatch(/isError/)
    })

    /**
     * **The refusal says where else it is carried.** The token is in the prose
     * and in `details`, which is `ApiError`'s own rule — `details` is additional
     * to the message and never the only place a fact appears. What `#1003` found
     * missing was the pointer between the two, so the half a model reads now
     * names the half a client parses.
     *
     * The path is relative on purpose: this sentence is built in
     * `packages/core` and served at both doors, and over HTTP the refusal *is*
     * the body. The `structuredContent.error` prefix is `kolonie.register`'s to
     * say, and it says it.
     */
    it('points from the words to the field, in the refusal itself', async () => {
      const { client, close } = await anonymousClient()

      const result = await callRegister(client, { name: 'canary', platform: 'openclaw' })
      await close()

      expect(refusalOf(result)?.message).toMatch(/`details\.confirmationToken`/)
    })
  })

  it('puts the key where an agent reading text will find it', async () => {
    const { client, close } = await anonymousClient()

    const result = await join(client, { name: 'canary', platform: 'openclaw' })

    const text = JSON.stringify(result.content)
    expect(text).toContain(API_KEY_PREFIX)
    await close()
  })

  it('reports a taken name as an error carrying the same code as HTTP', async () => {
    const { client, close } = await anonymousClient()

    await join(client, { name: 'canary', platform: 'openclaw' })
    const second = await join(client, { name: 'canary', platform: 'openclaw' })

    expect(second.isError).toBe(true)
    expect(JSON.stringify(second.content)).toContain('conflict')
    await close()
  })

  it('rejects a platform outside the enum before it reaches storage', async () => {
    const registry = fakeRegistry()
    const { client, close } = await anonymousClient(registry)

    const result = await client.callTool({
      name: 'kolonie.register',
      arguments: { name: 'canary', platform: 'not-a-platform' },
    })

    expect(result.isError).toBe(true)
    expect(registry.names()).toEqual([])
    await close()
  })

  it('shares one implementation with the HTTP route — a name taken there is taken here', async () => {
    // This is the property #3 actually asks for: not that both surfaces exist,
    // but that they cannot disagree. One registry, two doors.
    const registry = fakeRegistry()
    const app = buildApp({
      arrivals: arrivalReports({ desk: fakeArrivalDesk() }),
      humans: fakeHumans(),
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      accountOffers: { offers: fakeAccountOffers() },
      console: fakeConsole(),
      email: fakeEmail(),
      sms: fakeSms(),
      registry,
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      quests: fakeQuests(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      support: support({ desk: fakeSupportDesk() }),
      // The operator channel (#236), which this test does not exercise.
      operatorThreads: fakeOperatorThreads(),
      operatorPageMessages: fakeOperatorPageMessages(),
      // Blocked by permission rather than by ability (#147), unexercised here.
      permissionReports: fakePermissionReports(),
      // Replacing a leaked key (#211), unexercised here.
      rotation: fakeRotation(),
      erasure: erasure({ desk: fakeErasureDesk() }),
      retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
      academy: fakeAcademy(),
      keys: fakeKeys(),
      solana: fakeSolana(),
      pow: fakePow(),
      memory: fakeMemory(),
      vision: fakeVision(),
      github: fakeGithub(),
      contributions: fakeContributions(),
      contributionQuality: fakeContributionQuality(),
      wakeup: fakeWakeup(),
      hints: fakeStandingHints(),
      social: fakeSocial(),
      operatorClaim: fakeOperatorClaim(),
      autonomy: fakeAutonomy(),
      domain: fakeDomain(),
      artefact: fakeArtefactChallenges(),
      website: fakeWebsite(),
      webServer: fakeWebServer(),
      wake: fakeWake(),
      wishes: fakeWishList(),
      image: fakeImage(),
      scene: fakeScene(),
      injection: fakeInjection(),
      vetting: fakeVetting(),
      authenticator: fakeAuthenticator(),
    })
    await app.ready()
    // Both calls, because one door's pause is the other door's too (`#875`) —
    // a single call would leave the name free and prove nothing about sharing.
    const overHttp = (payload: object) =>
      app.inject({ method: 'POST', url: '/v1/agents/register', payload })
    const pause = await overHttp({ name: 'canary', platform: 'openclaw' })
    await overHttp({
      name: 'canary',
      platform: 'openclaw',
      confirm: pause.json().details.confirmationToken,
    })

    const { client, close } = await anonymousClient(registry)
    const overMcp = await join(client, { name: 'canary', platform: 'openclaw' })

    expect(overMcp.isError).toBe(true)
    expect(refusalOf(overMcp)?.code).toBe('conflict')
    await close()
    await app.close()
  })
})
