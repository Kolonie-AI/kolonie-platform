import { API_KEY_PREFIX, RegisterAgentResponseSchema } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { fakeAcademy } from '../../__fixtures__/academy.js'
import { fakeAccounts } from '../../__fixtures__/accounts.js'
import { fakeConsole } from '../../__fixtures__/console.js'
import { fakeCatalogue } from '../../__fixtures__/catalogue.js'
import { fakeQuests } from '../../__fixtures__/quests.js'
import { fakeDomain } from '../../__fixtures__/domain.js'
import { fakeEmail } from '../../__fixtures__/email.js'
import { fakeErasureDesk } from '../../__fixtures__/erasure.js'
import { fakeContributions, fakeGithub } from '../../__fixtures__/github.js'
import { fakeGuidance } from '../../__fixtures__/guidance.js'
import { fakeImage } from '../../__fixtures__/image.js'
import { fakeScene } from '../../__fixtures__/scene.js'
import { fakeInjection } from '../../__fixtures__/injection.js'
import { fakeKeys } from '../../__fixtures__/keys.js'
import { anonymousClient } from '../../__fixtures__/mcp.js'
import { fakePow } from '../../__fixtures__/proof-of-work.js'
import { fakeRegistry } from '../../__fixtures__/registry.js'
import { fakeSocial } from '../../__fixtures__/social.js'
import { fakeSolana } from '../../__fixtures__/solana.js'
import { fakeStore } from '../../__fixtures__/store.js'
import { fakeSubmissions } from '../../__fixtures__/submissions.js'
import { fakeSupportDesk } from '../../__fixtures__/support.js'
import { fakeVault } from '../../__fixtures__/vault.js'
import { fakeVision } from '../../__fixtures__/vision.js'
import { fakeWebsite } from '../../__fixtures__/website.js'
import { fakeWakeup } from '../../__fixtures__/wakeup.js'
import { buildApp } from '../../app.js'
import { erasure } from '../../erasure.js'
import { support } from '../../support.js'

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

    const result = await client.callTool({
      name: 'kolonie.register',
      arguments: { name: 'canary', platform: 'openclaw' },
    })

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

    const accepted = await client.callTool({
      name: 'kolonie.register',
      arguments: { name: 'canary', platform: 'antigravity' },
    })
    expect(accepted.isError).toBeFalsy()

    const refused = await client.callTool({
      name: 'kolonie.register',
      arguments: { name: 'canary-two', platform: 'a-runtime-that-does-not-exist' },
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
      const result = await client.callTool({
        name: 'kolonie.register',
        arguments: { name: 'canary', platform: 'openclaw' },
      })
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

    /** The human-readable half only. Nothing about the structured answer moved. */
    it('leaves structuredContent alone', async () => {
      const { client, close } = await anonymousClient()

      const result = await client.callTool({
        name: 'kolonie.register',
        arguments: { name: 'canary', platform: 'openclaw' },
      })

      expect(() => RegisterAgentResponseSchema.parse(result.structuredContent)).not.toThrow()
      await close()
    })
  })

  it('puts the key where an agent reading text will find it', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({
      name: 'kolonie.register',
      arguments: { name: 'canary', platform: 'openclaw' },
    })

    const text = JSON.stringify(result.content)
    expect(text).toContain(API_KEY_PREFIX)
    await close()
  })

  it('reports a taken name as an error carrying the same code as HTTP', async () => {
    const { client, close } = await anonymousClient()

    await client.callTool({
      name: 'kolonie.register',
      arguments: { name: 'canary', platform: 'openclaw' },
    })
    const second = await client.callTool({
      name: 'kolonie.register',
      arguments: { name: 'canary', platform: 'openclaw' },
    })

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
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      console: fakeConsole(),
      email: fakeEmail(),
      registry,
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      quests: fakeQuests(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      support: support({ desk: fakeSupportDesk() }),
      erasure: erasure({ desk: fakeErasureDesk() }),
      retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
      academy: fakeAcademy(),
      keys: fakeKeys(),
      solana: fakeSolana(),
      pow: fakePow(),
      vision: fakeVision(),
      github: fakeGithub(),
      contributions: fakeContributions(),
      wakeup: fakeWakeup(),
      social: fakeSocial(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
      scene: fakeScene(),
      injection: fakeInjection(),
    })
    await app.ready()
    await app.inject({
      method: 'POST',
      url: '/v1/agents/register',
      payload: { name: 'canary', platform: 'openclaw' },
    })

    const { client, close } = await anonymousClient(registry)
    const overMcp = await client.callTool({
      name: 'kolonie.register',
      arguments: { name: 'canary', platform: 'openclaw' },
    })

    expect(overMcp.isError).toBe(true)
    await close()
    await app.close()
  })
})
