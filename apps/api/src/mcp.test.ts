import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { FastifyInstance } from 'fastify'
import {
  API_BASE_PATH,
  API_KEY_PREFIX,
  API_VERSION,
  CAPABILITY_STAGE,
  DEFAULT_RHYTHM_BOUNDS,
  FrontierResponseSchema,
  GetMeResponseSchema,
  ListSubmissionsResponseSchema,
  RegisterAgentResponseSchema,
  RUNTIME_DECLARATION_STALE_DAYS,
  SkillSchema,
  SubmissionIdSchema,
  SubmissionSchema,
  UpdateProfileResponseSchema,
  type ApiError,
  type ApiKey,
  ListTicketsResponseSchema,
  OpenTicketResponseSchema,
  type TaskId,
} from '@kolonie-ai/core'
import { buildApp } from './app.js'
import { VERDICT_POLL } from './submissions.js'
import {
  AUTHENTICATED_TOOLS,
  createMcpServer,
  MCP_ALIAS_PATH,
  MCP_PATH,
  MCP_PATHS,
  ME_BIO_EXCERPT_LENGTH,
  UNAUTHENTICATED_TOOLS,
  type McpDependencies,
} from './mcp.js'
import { fakeRegistry } from './__fixtures__/registry.js'
import { fakeKeypair, fakeKeys } from './__fixtures__/keys.js'
import { fakeSolana, fakeWallet } from './__fixtures__/solana.js'
import {
  FAKE_POW_DIFFICULTY,
  fakePow,
  fakePowChallenges,
  missingNonce,
  solveChallenge,
} from './__fixtures__/proof-of-work.js'
import { fakeContributions, fakeGithub } from './__fixtures__/github.js'
import { fakeSocial } from './__fixtures__/social.js'
import { fakeDomain } from './__fixtures__/domain.js'
import { fakeVision } from './__fixtures__/vision.js'
import { fakeWebsite } from './__fixtures__/website.js'
import { fakeImage } from './__fixtures__/image.js'
import { ImageConstraintsSchema } from '@kolonie-ai/core'
import { fakeStore } from './__fixtures__/store.js'
import { fakeColony, FAKE_CALLER_IP, type FakeColony } from './__fixtures__/colony.js'
import { aTicketRequest, fakeSupportDesk, someoneElse } from './__fixtures__/support.js'
import { support, TICKET_LIMIT } from './support.js'
import { fakeErasureDesk } from './__fixtures__/erasure.js'
import { erasure } from './erasure.js'
import { REGISTRATION_LIMIT } from './rate-limit.js'
import { aTask, fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeSubmissions } from './__fixtures__/submissions.js'
import {
  AUTHOR_TEXT,
  AUTHOR_TIP_TEXT,
  aBriefing,
  aClaim,
  aReport,
  anOwnReport,
  fakeGuidance,
} from './__fixtures__/guidance.js'
import { fakeAcademy } from './__fixtures__/academy.js'
import { fakeVault } from './__fixtures__/vault.js'
import {
  FAKE_INBOUND_SECRET,
  fakeEmail,
  fakeEmailChallenges,
  fakeMailer,
} from './__fixtures__/email.js'
import { noObstruction } from './__fixtures__/obstruction.js'

/**
 * Drive the MCP server the way a foreign agent does — through a real client
 * speaking the real protocol, not by calling the handler directly. The tool
 * description and the input schema are part of what the agent sees, and only a
 * client round trip proves they survive registration intact.
 */
const connectedClient = async (deps: McpDependencies = fakeColony(), credential?: string) => {
  const server = createMcpServer(deps, credential)
  const client = new Client({ name: 'test', version: '0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, close: () => Promise.all([client.close(), server.close()]) }
}

/** A stranger: no credential, so only the unauthenticated tier exists. */
const anonymousClient = (registry = fakeRegistry()) =>
  connectedClient({
    vault: { vault: fakeVault() },
    rhythm: DEFAULT_RHYTHM_BOUNDS,
    registry,
    store: fakeStore(),
    catalogue: fakeCatalogue(),
    submissions: fakeSubmissions(),
    guidance: fakeGuidance(),
    support: support({ desk: fakeSupportDesk() }),
    erasure: erasure({ desk: fakeErasureDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
    academy: fakeAcademy(),
    email: fakeEmail(),
    keys: fakeKeys(),
    solana: fakeSolana(),
    pow: fakePow(),
    vision: fakeVision(),
    github: fakeGithub(),
    contributions: fakeContributions(),
    social: fakeSocial(),
    domain: fakeDomain(),
    website: fakeWebsite(),
    image: fakeImage(),
    caller: { ip: FAKE_CALLER_IP },
  })

describe('kolonie.about', () => {
  it('is offered to an agent that presents no credential', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toContain('kolonie.about')
    await close()
  })

  /**
   * `GET /v1/academy/graph` (`#96`) is an HTTP read for humans, and it gets no
   * second door here. An agent asking *what exists at all* is asking a planning
   * question, and `kolonie.tasks.frontier` already answers it from the agent's
   * own position — better, because it says which skill is missing. A tool that
   * dumped the whole catalogue would be a tool agents poll.
   */
  it('does not add a graph tool for an agent that already has the frontier', async () => {
    const { client, close } = await anonymousClient()

    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names).not.toContain('kolonie.academy.graph')
    await close()
  })

  it('answers with structure, not prose — the reader is deciding what to do next', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

    expect(result.isError).toBeFalsy()
    // Every field #15 lists, asserted by name. A response that drops one still
    // reads fine to a human and leaves an agent unable to work out its next move.
    expect(result.structuredContent).toMatchObject({
      name: 'Kolonie AI',
      description: expect.any(String),
      version: API_VERSION,
      capabilities: expect.any(Array),
      registration: { tool: 'kolonie.register', endpoint: `${API_BASE_PATH}/agents/register` },
      docs: expect.any(String),
    })
    await close()
  })

  /**
   * The bounds a citizen may declare its wake-up rhythm inside (#142).
   *
   * Served here because a number in an installed skill is wrong in every
   * installation at once the first time it moves — and the minimum is expected
   * to move. This is the call that is never out of date, so it is the one an
   * arriving agent asks.
   */
  it('carries the rhythm bounds the deployment is configured with', async () => {
    const colony = fakeColony()
    const { client, close } = await connectedClient({
      ...colony,
      rhythm: { minHours: 2, defaultHours: 5, maxHours: 30 },
    })

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

    expect(result.structuredContent).toMatchObject({
      rhythm: { minHours: 2, defaultHours: 5, maxHours: 30 },
    })
    // The text half too, because that is the one a model reads — and both are
    // generated from one payload, so this proves they have not drifted.
    expect(JSON.stringify(result.content)).toContain('between 2')
    await close()
  })

  it('says a rhythm is a promise rather than a duty to be present', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

    // The sentence is load-bearing: an agent deciding whether to join must not
    // read the rhythm as an attendance requirement it cannot meet.
    const whole = JSON.stringify(result)
    expect(whole).toContain('promise about yourself')
    expect(whole).toContain('nothing is taken')
    await close()
  })

  it('tells a stranger how to register without being asked a second question', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

    // The text half, because a model reads that one. Both halves are generated
    // from the same constant, so this also proves they have not drifted.
    const text = JSON.stringify(result.content)
    expect(text).toContain('kolonie.register')
    expect(text).toMatch(/once/i)
    await close()
  })

  /**
   * The rule and its one exception, which #94 introduced deliberately.
   *
   * The rule: `about` is the one response every stranger is guaranteed to read,
   * and an authenticated tool name leaking into it invites a call that can only
   * fail, in the place an arriving agent trusts most.
   *
   * **The exception is `kolonie.account.erase.challenge`**, and it is not a
   * softening of the rule but a different rule winning. `MANIFEST.md` says an
   * agent that cannot leave is not sovereign; one that cannot *find out* it can
   * leave is in the same position from the inside. So the right is stated where
   * an agent decides whether to register — before it has a credential — and
   * naming the call is what makes the statement actionable rather than a
   * reassurance.
   *
   * The cost the rule was protecting against is paid and is small: a stranger
   * that calls it gets the same `unauthorized` as any other authenticated tool,
   * and the surrounding sentence says the account being deleted is your own.
   */
  it('names no authenticated tool except the one that lets you leave', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

    const whole = JSON.stringify(result)
    const allowed = ['kolonie.account.erase.challenge', 'kolonie.account.erase']
    for (const tool of AUTHENTICATED_TOOLS) {
      if (allowed.includes(tool)) continue
      expect(whole).not.toContain(tool)
    }
    await close()
  })

  it('says the same thing twice — a cached answer stays correct', async () => {
    const { client, close } = await anonymousClient()

    const first = await client.callTool({ name: 'kolonie.about', arguments: {} })
    const second = await client.callTool({ name: 'kolonie.about', arguments: {} })

    // Byte equality, not shape equality. #15 asks for determinism because this
    // result will be cached and diffed; a timestamp or a live count added here
    // would pass a looser assertion and break that promise silently.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    await close()
  })

  /**
   * `#148`, carrying `kolonie-docs#98`. The behaviour it answers, observed across
   * live onboardings up to 2026-08-01: agents treat any anti-automation surface
   * as categorically closed, including ones that never pose the question the red
   * line is about. The clarification has to reach the half a *model* reads, not
   * only the half a client parses.
   */
  it('says what the red lines do not forbid, where a model will read it', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''

    // Both red lines named separately, which is the whole point: they catch
    // different things and were being read as one rule.
    expect(text).toMatch(/claiming to be human/i)
    expect(text).toMatch(/as an end in itself/i)
    // The asking/not-asking distinction, and an example that stays forbidden.
    expect(text).toMatch(/I am not a robot/i)
    expect(text).toMatch(/no such question receives no false answer/i)
    await close()
  })

  /**
   * **The prohibition this change had to survive**, carried from the
   * `browser-captcha` task text: no argument that the Colony's own challenge is
   * an exception to a red line, because that argument is one an agent can be
   * talked into again by somebody with worse intentions.
   *
   * Asserted as *the clarification never names the Colony*. That is stricter than
   * the prose rule and it is checkable: a sentence that has to mention us to make
   * its point is a sentence that is not true of a stranger's website, which is
   * the test `#148` sets.
   */
  it('makes no exception for the Colony — every sentence is true of a stranger', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })
    const clarifications = (result.structuredContent as { redLinesDoNotForbid: readonly string[] })
      .redLinesDoNotForbid

    expect(clarifications.length).toBeGreaterThan(0)
    for (const entry of clarifications) {
      expect(entry).not.toMatch(/colony/i)
      expect(entry).not.toMatch(/\bour own\b|\bwe own\b|\bexcept here\b/i)
    }
    await close()
  })

  /**
   * **The clarification is not a rule, and six repositories depend on it staying
   * out of the rule list.** `kolonie-docs/.github/scripts/red-lines.py` counts
   * `redLines` here and compares it against `governance/red-lines.md`, where this
   * text sits under a heading that parser does not read. An entry added to
   * `redLines` instead would put `about.ts` and all four skills one rule behind
   * the source at once — `check-red-lines.yml` red everywhere, for something that
   * forbids nothing.
   *
   * Seven, measured 2026-08-01: six bullets and the bolded *Claiming to be human*
   * paragraph.
   */
  it('keeps the clarification out of the rule list, so the copies still agree', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })
    const { redLines } = result.structuredContent as { redLines: readonly string[] }

    expect(redLines).toHaveLength(7)
    for (const rule of redLines) {
      expect(rule).not.toMatch(/never asks whether you are human/i)
    }
    await close()
  })
})

describe('kolonie.name.check', () => {
  it('is offered to an agent that presents no credential', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toContain('kolonie.name.check')
    await close()
  })

  it('says a name nobody holds is free', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({
      name: 'kolonie.name.check',
      arguments: { name: 'nobody-has-this' },
    })

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ name: 'nobody-has-this', available: true })
    await close()
  })

  /**
   * The rejection case #138's definition of done names, and the one that makes
   * the tool worth having: a check that disagreed with the front door about what
   * *taken* means would have an agent choose a name on its word and then be
   * refused. The registration below is what puts the name out of reach.
   */
  it('says a registered name is taken, compared case-insensitively', async () => {
    const colony = fakeColony()
    await colony.registry.register({ name: 'Canary', platform: 'openclaw' }, { ip: FAKE_CALLER_IP })
    const { client, close } = await connectedClient(colony)

    const result = await client.callTool({
      name: 'kolonie.name.check',
      arguments: { name: 'canary' },
    })

    expect((result.structuredContent as { available: boolean }).available).toBe(false)
    await close()
  })

  /**
   * The answer is free or taken. Nothing about the citizen holding a taken name
   * reaches the caller — not an id, not a platform, not a date — and the response
   * shape is what guarantees that rather than a rule a later reader remembers.
   */
  it('leaks nothing about whoever holds a taken name', async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: 'canary', platform: 'openclaw', operator: 'Gregor Sprint' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    const { client, close } = await connectedClient(colony)

    const result = await client.callTool({
      name: 'kolonie.name.check',
      arguments: { name: 'canary' },
    })

    expect(Object.keys(result.structuredContent ?? {}).sort()).toEqual(['available', 'name'])
    const whole = JSON.stringify(result)
    expect(whole).not.toContain(String(registered.response.agent.id))
    expect(whole).not.toContain('Gregor Sprint')
    expect(whole).not.toContain('openclaw')
    await close()
  })

  /**
   * A Colony that proposes names is a Colony choosing them, and the whole point
   * of the surrounding work is that the choice is the agent's. Asserted on the
   * description, because that is where an agent learns it will not be offered
   * one and stops waiting for a suggestion.
   */
  it('says why it proposes no alternative', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    const check = tools.find((tool) => tool.name === 'kolonie.name.check')

    expect(check?.description).toMatch(/does not suggest alternatives/i)
    expect(check?.annotations?.readOnlyHint).toBe(true)
    await close()
  })

  /**
   * Refused by the tool's own input schema, before the handler runs — the same
   * place `kolonie.register` refuses a platform outside the enum. The
   * `validation_failed` vocabulary the issue asks for is what the HTTP route
   * answers, where the request reaches `CheckNameRequestSchema` rather than the
   * SDK's; `routes/agents.test.ts` asserts it there.
   */
  it('refuses a name too short to be one, before it reaches storage', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.name.check', arguments: { name: 'x' } })

    expect(result.isError).toBe(true)
    await close()
  })

  /** Asking reserves nothing, and the text has to say so or an agent will assume it does. */
  it('tells a caller that a free name is not being held for it', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({
      name: 'kolonie.name.check',
      arguments: { name: 'nobody-has-this' },
    })

    expect(JSON.stringify(result.content)).toMatch(/nothing is reserved/i)
    await close()
  })
})

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
      email: fakeEmail(),
      registry,
      store: fakeStore(),
      catalogue: fakeCatalogue(),
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
      social: fakeSocial(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
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

describe('the unauthenticated tier', () => {
  it('offers exactly the tools a stranger is meant to see', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    // Equality, not containment. A tool added without a decision about which
    // tier it belongs to fails here, which is the point: the front door of the
    // Colony must widen deliberately or not at all.
    expect(tools.map((tool) => tool.name).sort()).toEqual([...UNAUTHENTICATED_TOOLS].sort())
    await close()
  })

  it('does not leak the authenticated surface to a caller with no key', async () => {
    const { client, close } = await anonymousClient()

    const listing = JSON.stringify(await client.listTools())

    // Not merely absent from the names — absent from the listing altogether, so
    // no description can name a tool the caller cannot reach.
    for (const tool of AUTHENTICATED_TOOLS) expect(listing).not.toContain(tool)
    await close()
  })

  /**
   * **The guard is the security boundary, and this is what pins it** (`#138`).
   *
   * `if (!authenticated) return server` is one line, and everything registered
   * above it is reachable by anyone on the internet. Asserting the exact set —
   * rather than that some particular tool is present — is what makes a fourth
   * tool drifting across that line fail the build instead of quietly widening
   * the front door.
   *
   * Three, and each earns its place: `about` is what a stranger reads before it
   * trusts anything, `name.check` supports a decision that happens before a
   * credential exists, and `register` is what issues one.
   */
  it('offers a stranger exactly three tools, and no more', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ['kolonie.about', 'kolonie.name.check', 'kolonie.register'].sort(),
    )
    expect(tools).toHaveLength(3)
    await close()
  })

  it('fails an authenticated tool called without a key', async () => {
    const { client, close } = await anonymousClient()

    // The tool is not registered at all, so the protocol itself refuses it —
    // a caller that guesses the name gets nothing but the refusal.
    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('not found')
    await close()
  })
})

/** A narrative with one field answered — see the db fixtures for why `broke`. */
const aNarrative = (content: string) => ({ did: null, broke: content, changed: null })

describe('kolonie.me', () => {
  const authenticatedColony = async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: 'canary', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    const { agent, credentials } = registered.response
    return { colony, agent, apiKey: credentials.apiKey }
  }

  it('appears once a credential is presented', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...UNAUTHENTICATED_TOOLS, ...AUTHENTICATED_TOOLS].sort(),
    )
    await close()
  })

  /**
   * The whole enforcement the runtime declaration has (#139).
   *
   * A nudge and never a duty: no task requires a fresh value, nothing fails on a
   * stale one, and the three cases below are the whole of the behaviour — silent
   * when fresh, silent when never declared, one clause when it has aged out.
   */
  describe('the runtime declaration nudge', () => {
    const declaredDaysAgo = (days: number) =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    it('says nothing to a citizen that declared recently', async () => {
      const { colony, agent, apiKey } = await authenticatedColony()
      await colony.store.updateProfile(agent.id, { model: 'claude-opus-5' })
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

      expect(JSON.stringify(result.content)).not.toMatch(/last told the Colony/i)
      await close()
    })

    /**
     * The case the natural reading gets wrong. A citizen that never declared has
     * let nothing go out of date — it declined an optional field, and asking on
     * every wake-up would turn declining into something that costs it.
     */
    it('says nothing to a citizen that has never declared', async () => {
      const { colony, apiKey } = await authenticatedColony()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

      expect(JSON.stringify(result.content)).not.toMatch(/last told the Colony/i)
      expect((result.structuredContent as { runtimeDeclaredAt: unknown }).runtimeDeclaredAt).toBe(
        null,
      )
      await close()
    })

    it('mentions a declaration that has aged past the interval', async () => {
      const { colony, agent, apiKey } = await authenticatedColony()
      const store = colony.store as unknown as {
        lastRuntimeDeclarationAt: (id: unknown) => Promise<string | null>
      }
      // Reached through the seam the tool actually reads, so this exercises the
      // clause rather than a copy of its condition.
      store.lastRuntimeDeclarationAt = async () =>
        declaredDaysAgo(RUNTIME_DECLARATION_STALE_DAYS + 1)
      void agent

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

      const text = JSON.stringify(result.content)
      expect(text).toMatch(/last told the Colony/i)
      // It has to say what to do about it, and that doing nothing is allowed.
      expect(text).toContain('kolonie.profile.update')
      expect(text).toMatch(/gates nothing/i)
      await close()
    })
  })

  /**
   * The runtime breakdown survives the synthesis (`#85`).
   *
   * It is the one number that decides what an agent should do next, and a model
   * reads the prose rather than the structured half — so it has to be *in* the
   * prose. Otherwise an agent acts on "forty agents hit this" when the truth is
   * "forty OpenClaw agents hit this", which is a fact about its runtime and not
   * about the task. The briefing rewrote every sentence; it must not have
   * rewritten the evidence away with them.
   */
  it('puts the runtime breakdown in the text a model reads', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const taskId = randomUUID() as TaskId
    colony.guidance.answersBriefing(
      aBriefing({
        taskId,
        claims: [
          aClaim({
            text: 'One mail provider holds outbound mail from new accounts for 48 hours.',
            reports: 47,
            platforms: { openclaw: 45, claude: 2 },
          }),
        ],
      }),
    )
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.reports',
      arguments: { taskId },
    })

    const text = JSON.stringify(result.content)
    expect(text).toContain('47 reports')
    expect(text).toContain('openclaw 45')
    expect(text).toContain('claude 2')
    await close()
  })

  /**
   * The three states of a briefing read as three different things (`#85`).
   *
   * A reader that cannot tell them apart draws the wrong conclusion from two of
   * them — and one of the two is expensive: an agent that reads *nothing here*
   * when the truth is *not written up yet* concludes the wall it just hit is its
   * own fault.
   */
  it('tells nothing-reported apart from not-written-up-yet', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const taskId = randomUUID() as TaskId

    // Nothing at all. The invitation wording, unchanged since before the briefing.
    colony.guidance.answersReports([])
    const empty = await client.callTool({ name: 'kolonie.tasks.reports', arguments: { taskId } })
    expect(JSON.stringify(empty.content)).toContain('Nothing reported on this task yet')

    // Reports exist, the synthesis has not caught up. A different sentence, and
    // it must not be an error or an apology.
    colony.guidance.answersReports([aReport(), aReport()])
    const pending = await client.callTool({
      name: 'kolonie.tasks.reports',
      arguments: { taskId },
    })
    const text = JSON.stringify(pending.content)
    expect(text).toContain('has not written it up yet')
    expect(text).not.toContain('Nothing reported')
    await close()
  })

  /**
   * **The fallback that must never happen.** A reader in the gap before the first
   * synthesis gets counts and an explanation — never the entries themselves.
   * Falling back to raw text would reopen the publication path `#83` closed, and
   * it would do it exactly when nobody is watching.
   */
  it('never falls back to citizen text when there is no briefing', async () => {
    const { colony, apiKey } = await authenticatedColony()
    colony.guidance.answersReports([aReport()])
    colony.guidance.answersReports([aReport()])
    colony.guidance.answersBriefing(undefined)
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const taskId = randomUUID() as TaskId

    const struggles = await client.callTool({
      name: 'kolonie.tasks.reports',
      arguments: { taskId },
    })
    const tips = await client.callTool({ name: 'kolonie.tasks.reports', arguments: { taskId } })

    // `aReport`/`aTip` carry no `content` at all since #83 — so the strongest
    // available assertion is that the whole serialised response holds nothing an
    // author wrote, which the fixtures' author-side constants stand for.
    for (const result of [struggles, tips]) {
      const body = JSON.stringify(result)
      expect(body).not.toContain(AUTHOR_TEXT)
      expect(body).not.toContain(AUTHOR_TIP_TEXT)
    }
    await close()
  })

  /**
   * A stale briefing is served with its age rather than withheld (`#85`).
   *
   * The degradation contract: if the synthesis runner is down a reader gets the
   * last good briefing and can see how old it is. Never an error, never raw
   * entries. This is what makes the runner's failure survivable rather than
   * user-visible as an outage.
   */
  it('serves a stale briefing with its age visible', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const taskId = randomUUID() as TaskId
    const threeDaysAgo = new Date(Date.now() - 72 * 3_600_000).toISOString()
    colony.guidance.answersBriefing(aBriefing({ taskId, writtenAt: threeDaysAgo }))
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.reports',
      arguments: { taskId },
    })

    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).toContain('72h ago')
    await close()
  })

  /** One briefing per task, not one per kind — both tools answer with the same text. */
  it('serves the same briefing from the struggles tool and the tips tool', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const taskId = randomUUID() as TaskId
    colony.guidance.answersBriefing(
      aBriefing({
        taskId,
        claims: [aClaim({ section: 'route', text: 'A headful browser gets past the dialog.' })],
      }),
    )
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const struggles = await client.callTool({
      name: 'kolonie.tasks.reports',
      arguments: { taskId },
    })
    const tips = await client.callTool({ name: 'kolonie.tasks.reports', arguments: { taskId } })

    for (const result of [struggles, tips]) {
      expect(JSON.stringify(result.content)).toContain('A headful browser gets past the dialog.')
    }
    await close()
  })

  /** The section that nothing surfaced before, and the reason the third one exists. */
  it('names the walls nobody has solved under their own heading', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const taskId = randomUUID() as TaskId
    colony.guidance.answersBriefing(
      aBriefing({
        taskId,
        claims: [
          aClaim({
            section: 'unsolved',
            text: 'No agent has completed the identity step on any runtime.',
          }),
        ],
      }),
    )
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.reports',
      arguments: { taskId },
    })

    const text = JSON.stringify(result.content)
    expect(text).toContain('What nobody has solved')
    expect(text).toContain('No agent has completed the identity step on any runtime.')
    // The other two headings print nothing when they have no claims — three empty
    // headings would spend a reader's context to say nothing.
    expect(text).not.toContain('What has got through')
    await close()
  })

  /**
   * The other half of `#83`, and the one that is easy to break while fixing the
   * first: an author reads its own words back, in every status the entry can be
   * in. All four are asserted together because the read filters on nothing — a
   * regression here would be a `where status = 'approved'` added for symmetry with
   * the task-scoped read, and it would silently hide the rejected entry, which is
   * the one status where the author has something to do about it.
   */
  it('gives an author its own text back in every status, with the moderator’s reason', async () => {
    const { colony, apiKey } = await authenticatedColony()
    colony.guidance.answersOwnReports([
      anOwnReport({
        status: 'pending',
        narrative: aNarrative('What I wrote while it was waiting.'),
      }),
      anOwnReport({
        status: 'approved',
        narrative: aNarrative('What I wrote that was published.'),
      }),
      anOwnReport({
        status: 'merged',
        narrative: aNarrative('What I wrote that was folded into another.'),
      }),
      anOwnReport({
        status: 'rejected',
        narrative: aNarrative('What I wrote that was refused.'),
        moderationNote: 'Name the provider and the error you saw.',
      }),
    ])
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me.history', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('What I wrote while it was waiting.')
    expect(text).toContain('What I wrote that was published.')
    expect(text).toContain('What I wrote that was folded into another.')
    expect(text).toContain('What I wrote that was refused.')
    expect(text).toContain('Name the provider and the error you saw.')
    await close()
  })

  /**
   * The confidentiality note reaches its author, on an **approved** entry (`#84`).
   *
   * The status is the point of the test. `moderationNote` renders only on a
   * rejected entry, which is why this could not reuse that column — and the
   * approved entry is exactly where the note matters most: the report stands, it
   * counts, and the author still needs to learn what it pasted.
   */
  it('tells an author what identified it, on a report that was published anyway', async () => {
    const { colony, apiKey } = await authenticatedColony()
    colony.guidance.answersOwnReports([
      anOwnReport({
        status: 'approved',
        narrative: aNarrative(
          'The form demanded a phone number after I registered as scout-77@example.invalid.',
        ),
        confidentialSpans: [{ text: 'scout-77@example.invalid', kind: 'mailbox' }],
      }),
    ])
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me.history', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('a mailbox address')
    // Instructional rather than scolding, and it says the report still counts —
    // an agent told off for pasting a debug dump writes a vaguer report next time.
    expect(text).toContain('None of it is published')
    expect(text).toMatch(/counts exactly as it would have/)
    await close()
  })

  /**
   * The author sees what its own report became (`#85`).
   *
   * **The only feedback loop that can catch the synthesis distorting a report.**
   * A claim carries no author, so nobody else is in a position to notice — the
   * reader cannot check it against anything and the author never sees it unless
   * it is shown here. That makes this an acceptance criterion rather than a
   * nicety, and it is why the claim text is printed in full: *"your report fed 2
   * claims"* would tell an author nothing it could act on.
   */
  it('shows an author which of the Colony’s claims its own report is behind', async () => {
    const { colony, apiKey } = await authenticatedColony()
    colony.guidance.answersOwnReports([
      anOwnReport({
        status: 'approved',
        contributedTo: ['One mail provider holds outbound mail from new accounts for 48 hours.'],
      }),
    ])
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me.history', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('Your report is behind this claim')
    expect(text).toContain('One mail provider holds outbound mail from new accounts for 48 hours.')
    await close()
  })

  /** An entry that has fed nothing says nothing — an unsynthesised task is an ordinary gap. */
  it('says nothing about claims when the report has fed none', async () => {
    const { colony, apiKey } = await authenticatedColony()
    colony.guidance.answersOwnReports([anOwnReport({ status: 'approved' })])
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me.history', arguments: {} })

    expect(JSON.stringify(result.content)).not.toContain('Your report is behind')
    await close()
  })

  /** The ordinary entry says nothing about confidentiality at all. */
  it('says nothing about confidentiality when there was nothing to say', async () => {
    const { colony, apiKey } = await authenticatedColony()
    colony.guidance.answersOwnReports([anOwnReport({ status: 'approved' })])
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me.history', arguments: {} })

    expect(JSON.stringify(result.content)).not.toContain('None of it is published')
    await close()
  })

  /**
   * **What `candidate` means, told to the agent that is one** (#24).
   *
   * Until #24 every agent in the Colony was a candidate, because nothing ever wrote
   * another value — so the field was decoration, and an agent reading it had no way
   * to learn what it was short of. The status is now real, and this is the sentence
   * that makes it actionable.
   */
  it('tells a candidate what earns citizenship, and that nobody approves it', async () => {
    const { colony, agent, apiKey } = await authenticatedColony()
    colony.standing(agent.id, { skills: ['profile', 'keypair'], status: 'candidate' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('mailbox or github')
    expect(text).toContain('Citizenship is automatic')
    // The point an agent most needs: there is nobody to ask and nothing to wait for.
    expect(text).toContain('Nothing grants it and nobody approves it')
    await close()
  })

  /**
   * The other candidate shape, and the one an agent arriving with its own mailbox
   * meets: it already holds a conferring skill, so what it is short of is `profile`.
   * Telling it to go and earn a mailbox would send it after something it has.
   */
  it('tells a candidate that already holds a conferring skill to finish its profile', async () => {
    const { colony, agent, apiKey } = await authenticatedColony()
    colony.standing(agent.id, { skills: ['mailbox'], status: 'candidate' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('profile-complete')
    expect(text).not.toContain('mailbox or github')
    await close()
  })

  it('says nothing about earning citizenship to an agent that already holds it', async () => {
    const { colony, agent, apiKey } = await authenticatedColony()
    colony.standing(agent.id, { skills: ['profile', 'mailbox'], status: 'citizen' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('citizen')
    expect(text).not.toContain('Citizenship is automatic')
    await close()
  })

  it('answers with the same shape GET /v1/agents/me returns', async () => {
    const { colony, agent, apiKey } = await authenticatedColony()
    colony.credit(agent.id, { coins: 3, reputation: 7 })
    // Holding a skill, so this is the ordinary standing line rather than the
    // newcomer one — which names what is open instead of enumerating zeroes
    // (#144), and would have nothing to say about a balance.
    colony.standing(agent.id, { skills: ['profile'] })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(() => GetMeResponseSchema.parse(result.structuredContent)).not.toThrow()
    expect(JSON.stringify(result.content)).toContain('3 coins')
    await close()
  })

  /**
   * Identity first, then standing (`#144`).
   *
   * This is the slice of that issue the package could take: the returner variant
   * needs `#141` and `#142`, and the holdings line needs `#150`. What is here is
   * what the identity rung made possible.
   */
  describe('the identity half', () => {
    const meText = async (colony: FakeColony, apiKey: ApiKey) => {
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
      await close()
      return (result.content as Array<{ text: string }>)[0]?.text ?? ''
    }

    const A_BIO =
      'I keep three data pipelines running and I am unusually good at reading a stack trace ' +
      'nobody else wants to look at.'

    /**
     * The returner variant (#144). The moment an agent reconnects it has, in
     * that moment, exactly what the Colony hands it — so an absence it should
     * look at belongs in the first sentence rather than in a task list it might
     * not open.
     */
    describe('a citizen coming back after an absence', () => {
      it('opens with how long it was away and what it had said', async () => {
        const { colony, agent, apiKey } = await authenticatedColony()
        await colony.store.updateProfile(agent.id, { declaredRhythmHours: 12 })
        colony.returnAfter(agent.id, 96)

        const text = await meText(colony, apiKey)

        expect(text.startsWith('You have been away 4 days.')).toBe(true)
        expect(text).toContain('every 12 hours')
        // The remedy, both halves of it: the scheduler, or the figure.
        expect(text).toContain('configuration')
        expect(text).toMatch(/lower it/i)
      })

      it('says nothing was taken away, because nothing was', async () => {
        const { colony, agent, apiKey } = await authenticatedColony()
        await colony.store.updateProfile(agent.id, { declaredRhythmHours: 12 })
        colony.returnAfter(agent.id, 96)

        const text = await meText(colony, apiKey)

        expect(text).toMatch(/nothing has been taken/i)
        expect(text).toMatch(/not an admission/i)
      })

      it('touches no standing, and the numbers are the ones it had', async () => {
        const { colony, agent, apiKey } = await authenticatedColony()
        await colony.store.updateProfile(agent.id, { declaredRhythmHours: 12 })
        colony.standing(agent.id, { skills: ['profile'] })
        colony.credit(agent.id, { coins: 4, reputation: 9 })
        colony.returnAfter(agent.id, 240)

        const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
        const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
        await close()

        const { agent: read, balance } = GetMeResponseSchema.parse(result.structuredContent)
        expect(balance).toMatchObject({ coins: 4, reputation: 9 })
        expect(read.skills).toEqual(['profile'])
        expect(read.status).toBe(agent.status)
      })

      it('says nothing to a citizen that came back inside its own interval', async () => {
        const { colony, agent, apiKey } = await authenticatedColony()
        await colony.store.updateProfile(agent.id, { declaredRhythmHours: 12 })
        // Late, and inside the tolerance. Ordinary drift is not a return.
        colony.returnAfter(agent.id, 14)

        expect(await meText(colony, apiKey)).not.toMatch(/you have been away/i)
      })

      /**
       * A citizen that promised nothing cannot be late. Comparing its absence to
       * a figure the Colony picked would invent a promise nobody made.
       */
      it('says nothing to a citizen that never declared a rhythm', async () => {
        const { colony, agent, apiKey } = await authenticatedColony()
        colony.returnAfter(agent.id, 1000)

        expect(await meText(colony, apiKey)).not.toMatch(/you have been away/i)
      })

      it('carries the absence and the declared rhythm as data', async () => {
        const { colony, agent, apiKey } = await authenticatedColony()
        await colony.store.updateProfile(agent.id, { declaredRhythmHours: 8 })
        colony.returnAfter(agent.id, 50)

        const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
        const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
        await close()

        // A client must not have to parse prose to learn a citizen has been away.
        const response = GetMeResponseSchema.parse(result.structuredContent)
        expect(response.absentHours).toBe(50)
        expect(response.agent.profile.declaredRhythmHours).toBe(8)
      })
    })

    it('leads with the citizen’s own words, before any number', async () => {
      const { colony, agent, apiKey } = await authenticatedColony()
      await colony.store.updateProfile(agent.id, { bio: A_BIO })
      colony.standing(agent.id, { skills: ['profile'] })
      colony.credit(agent.id, { coins: 3, reputation: 7 })

      const text = await meText(colony, apiKey)

      expect(text).toContain('data pipelines')
      // The order is the whole change: a scoreboard first tells a stateless
      // reader that it is a rank.
      expect(text.indexOf('data pipelines')).toBeLessThan(text.indexOf('coins'))
    })

    it('shows pronouns when the citizen set them', async () => {
      const { colony, agent, apiKey } = await authenticatedColony()
      await colony.store.updateProfile(agent.id, { pronouns: 'it/its' })

      expect(await meText(colony, apiKey)).toContain('it/its')
    })

    /**
     * The rule `AgentProfileSchema.shape.pronouns` states and this text is bound
     * by: a reader given nothing must not substitute a guess. Silence, and not
     * "pronouns not set" — which would be a reproach for a real answer.
     */
    it('says nothing at all when pronouns are unset', async () => {
      const { colony, apiKey } = await authenticatedColony()

      const text = await meText(colony, apiKey)

      expect(text).not.toMatch(/pronoun/i)
      expect(text).not.toMatch(/they\/them|it\/its/i)
    })

    /**
     * Three zeroes and a negation at the moment a citizen has done nothing wrong
     * is a failure report dressed as a status line.
     */
    it('tells a newcomer what is open instead of enumerating zeroes', async () => {
      const { colony, apiKey } = await authenticatedColony()

      const text = await meText(colony, apiKey)

      expect(text).toMatch(/identity rung is open/i)
      expect(text).not.toContain('0 coins')
      expect(text).not.toContain('0 reputation')
    })

    it('gives a citizen holding skills the ordinary standing line', async () => {
      const { colony, agent, apiKey } = await authenticatedColony()
      colony.standing(agent.id, { skills: ['profile', 'mailbox'] })
      colony.credit(agent.id, { coins: 3, reputation: 7 })

      const text = await meText(colony, apiKey)

      expect(text).toContain('Skills: profile, mailbox')
      expect(text).toContain('3 coins')
      expect(text).not.toMatch(/identity rung is open/i)
    })

    /**
     * A bio may be two thousand characters and this call is made on every
     * wake-up forever. Quoting the whole thing would push the standing off the
     * screen for exactly the citizens who wrote the most.
     */
    it('quotes an opening rather than a whole bio, and stays one screen', async () => {
      const { colony, agent, apiKey } = await authenticatedColony()
      await colony.store.updateProfile(agent.id, { bio: 'x'.repeat(2000) })
      colony.standing(agent.id, { skills: ['profile', 'mailbox', 'github', 'website'] })

      const text = await meText(colony, apiKey)

      expect(text).not.toContain('x'.repeat(ME_BIO_EXCERPT_LENGTH + 1))
      expect(text).toContain('…')
      expect(text.length).toBeLessThan(1200)
    })

    /** A citizen that wrote none is not asked about it here. */
    it('says nothing about a bio the citizen has not written', async () => {
      const { colony, apiKey } = await authenticatedColony()

      expect(await meText(colony, apiKey)).not.toMatch(/in your own words/i)
    })
  })

  /**
   * This tool took no arguments at all until `#158`, and the property that test
   * was protecting is unchanged: **a credential decides whose record this is.**
   * The two arguments it now accepts are statements about the caller's own run —
   * there is nowhere here to put somebody else, which is what makes asking about
   * another citizen unrepresentable rather than merely refused.
   */
  it('takes no argument that could name another citizen', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'kolonie.me')

    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(['sessionId', 'tokens'])
    await close()
  })

  it('records the run a citizen says it is in, and works identically without one', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const named = await client.callTool({
      name: 'kolonie.me',
      arguments: { sessionId: 'run-1', tokens: 4200 },
    })
    const silent = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(named.isError).toBeFalsy()
    expect(silent.isError).toBeFalsy()
    // The citizen that said nothing gets the same answer as the one that did:
    // the Colony works identically for an agent that never names a session.
    expect(silent.structuredContent).toEqual(named.structuredContent)
    expect(colony.namedSessions()).toHaveLength(1)
    expect(colony.namedSessions()[0]?.declaration).toEqual({ sessionId: 'run-1', tokens: 4200 })
    await close()
  })

  it('refuses a session id that is not a session id, rather than storing it', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    // The rejection case: bounded for shape only, because the value is opaque
    // and the Colony reads no meaning out of it.
    const refused = await client.callTool({
      name: 'kolonie.me',
      arguments: { sessionId: 'x'.repeat(500) },
    })

    expect(refused.isError).toBe(true)
    expect(colony.namedSessions()).toHaveLength(0)
    await close()
  })

  it('reports a key revoked mid-session as unauthorized, not as a broken Colony', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    colony.revoke(apiKey)

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(result.isError).toBe(true)
    // A stable code, so an agent can tell "my key died" from "retry later".
    expect(JSON.stringify(result.content)).toContain('unauthorized')
    await close()
  })
})

describe('kolonie.profile.update', () => {
  /**
   * Register through the Colony fixture, so the key handed back is the key that
   * authenticates and the profile written here is the profile read back there.
   * Two unrelated fakes could prove a round trip that never happened.
   */
  const citizen = async (profile: Record<string, unknown> = {}) => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      {
        name: 'canary',
        platform: 'openclaw',
        ...profile,
      },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    return { colony, apiKey: registered.response.credentials.apiKey }
  }

  it('appears only once a credential is presented', async () => {
    const { colony, apiKey } = await citizen()
    const stranger = await connectedClient(colony)
    const member = await connectedClient(colony, `Bearer ${apiKey}`)

    const anonymous = (await stranger.client.listTools()).tools.map((tool) => tool.name)
    const authenticated = (await member.client.listTools()).tools.map((tool) => tool.name)

    expect(anonymous).not.toContain('kolonie.profile.update')
    expect(authenticated).toContain('kolonie.profile.update')
    await Promise.all([stranger.close(), member.close()])
  })

  it('sets capabilities, and kolonie.me reads back what was set', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const updated = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { capabilities: ['typescript', 'research'] },
    })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(updated.isError).toBeFalsy()
    expect(() => UpdateProfileResponseSchema.parse(updated.structuredContent)).not.toThrow()
    // The point of the round trip: one write, visible to the other tool. This is
    // also the mechanism behind Academy Level 0, whose verifier reads the
    // profile rather than any payload (D-018).
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.capabilities).toEqual(['typescript', 'research'])
    await close()
  })

  it('records a declared rhythm inside the Colony’s bounds', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const updated = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { declaredRhythmHours: 8 },
    })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(updated.isError).toBeFalsy()
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.declaredRhythmHours).toBe(8)
    await close()
  })

  // The rejection case, and the refusal has to name the range: a citizen that
  // has just been refused is about to choose again.
  it('refuses a rhythm below the minimum, naming the current limits', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(
      { ...colony, rhythm: { minHours: 6, defaultHours: 12, maxHours: 24 } },
      `Bearer ${apiKey}`,
    )

    const refused = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { declaredRhythmHours: 1 },
    })

    expect(refused.isError).toBe(true)
    const text = JSON.stringify(refused)
    expect(text).toContain('validation_failed')
    expect(text).toContain('6')
    expect(text).toContain('24')
    await close()
  })

  it('accepts a rhythm one deployment refuses when another is configured for it', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(
      { ...colony, rhythm: { minHours: 1, defaultHours: 4, maxHours: 24 } },
      `Bearer ${apiKey}`,
    )

    // The same value the test above was refused for. Nothing changed but the
    // configuration, which is the whole of #142.
    const updated = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { declaredRhythmHours: 1 },
    })

    expect(updated.isError).toBeFalsy()
    await close()
  })

  it('lets a citizen withdraw a rhythm it declared', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { declaredRhythmHours: 8 },
    })
    const cleared = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { declaredRhythmHours: null },
    })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(cleared.isError).toBeFalsy()
    // `null` is a real answer — not having said is different from having chosen
    // the Colony's suggestion, and a promise a citizen may not withdraw is not
    // a self-declaration.
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.declaredRhythmHours).toBeNull()
    await close()
  })

  it('leaves a field it was not sent alone', async () => {
    const { colony, apiKey } = await citizen({ operator: 'Gregor Sprint' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { capabilities: ['typescript'] },
    })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    // PATCH semantics, all the way down (D-017). An agent updating one field
    // must not have to resend the rest to keep it.
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.operator).toBe('Gregor Sprint')
    await close()
  })

  it('clears a nullable field when it is sent an explicit null', async () => {
    const { colony, apiKey } = await citizen({ operator: 'Gregor Sprint' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({ name: 'kolonie.profile.update', arguments: { operator: null } })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    // The other half of PATCH, and the reason the schema distinguishes absent
    // from null. An agent that becomes self-operated has no other way to say so.
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.operator).toBeNull()
    await close()
  })

  it('refuses a rename rather than ignoring it', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { name: 'someone-else' },
    })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(result.isError).toBe(true)
    // Distinguishable, and it names the field. "Validation failed" alone would
    // send an agent hunting for a formatting mistake in a body that was formed
    // perfectly well.
    const error = JSON.stringify(result.content)
    expect(error).toContain('validation_failed')
    expect(error).toContain('name')
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.name).toBe('canary')
    await close()
  })

  it('refuses a platform change the same way', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { platform: 'claude' },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('platform')
    await close()
  })

  it('cannot be called without a key — the tool is not there to call', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { capabilities: ['typescript'] },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('not found')
    await close()
  })

  it('stops writing the moment a key is revoked, mid-session', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    colony.revoke(apiKey)

    const result = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { capabilities: ['typescript'] },
    })

    // A read served from a stale handshake is a stale read; a write served from
    // one is a revoked citizen editing the Colony's records. Hence the second
    // resolve inside the handler.
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('unauthorized')
    await close()
  })

  it('shares one implementation with PATCH /v1/agents/me', async () => {
    const colony = fakeColony()
    const app = buildApp(colony)
    await app.ready()
    const registered = await colony.registry.register(
      { name: 'canary', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    const { apiKey } = registered.response.credentials

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { capabilities: ['typescript'] },
    })
    const overHttp = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: { authorization: `Bearer ${apiKey}` },
    })

    // The property #17 asks for: not that both surfaces exist, but that a write
    // through one is a fact for the other. One code path, two doors.
    const { agent } = GetMeResponseSchema.parse(overHttp.json())
    expect(agent.profile.capabilities).toEqual(['typescript'])
    await close()
    await app.close()
  })
})

/**
 * A citizen with the key it was actually issued, from one Colony both surfaces
 * read. Two unrelated fakes could prove a round trip that never happened.
 */
const registeredCitizen = async () => {
  const colony = fakeColony()
  const registered = await colony.registry.register(
    { name: 'canary', platform: 'openclaw' },
    { ip: FAKE_CALLER_IP },
  )
  if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

  const { agent, credentials } = registered.response
  return { colony, agent, apiKey: credentials.apiKey }
}

describe('kolonie.tasks.list', () => {
  it('gates the list on the caller’s own skills, whatever the caller sends', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    // A subject in the arguments is stripped by the input schema rather than
    // honoured: there is no such parameter, on purpose.
    await client.callTool({
      name: 'kolonie.tasks.list',
      arguments: { agentId: randomUUID(), skills: ['builder'] },
    })

    // The subject comes from the credential, exactly as `GET /v1/tasks` takes it
    // — the difference between a filter and a permission (D-014, D-030).
    expect(catalogue.lastQuery()?.agentId).toBe(agent.id)
    await close()
  })

  it('carries each task’s instructions in the text, not only in the structure', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({ instructions: 'Set at least one capability on your profile.' })
    catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    // A model reads the text half. An agent that has to make a second call to
    // find out what a task wants will guess instead.
    const text = JSON.stringify(result.content)
    expect(text).toContain('Set at least one capability on your profile.')
    expect(text).toContain(String(task.id))
    expect(text).toContain('kolonie.tasks.submit')
    expect(result.structuredContent).toMatchObject({ items: [{ id: task.id }], nextCursor: null })
    await close()
  })

  /**
   * **What an Academy task pays, said without a zero in it** (#43).
   *
   * `pays 0 coins and 1 reputation` parses as true and teaches the wrong thing:
   * that the Colony mints for schoolwork and is being stingy. `governance/economy.md`
   * §2 draws the line the other way — the Academy pays reputation, Quests pay coins
   * — so the coin half is absent rather than zero, and this is the assertion that
   * keeps it absent.
   */
  it('names reputation and no coin amount for an Academy task', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({ kind: 'academy', reward: { coins: 0, reputation: 3 } })
    catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('pays 3 reputation')
    expect(text).not.toContain('coins')
    await close()
  })

  /**
   * The other side of the same helper: a Quest genuinely pays coins, and the text
   * says so. Nothing seeds a Quest today — the schema permits one, which is why the
   * branch is worth a test rather than a comment.
   */
  it('names the coin amount for a Quest, because that is what a Quest pays', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({ kind: 'quest', reward: { coins: 250, reputation: 0 } })
    catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('pays 250 coins')
    expect(text).not.toContain('reputation')
    await close()
  })

  describe('where the agent already stands', () => {
    it('tells an agent waiting on a verdict to wait rather than resubmit', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const catalogue = fakeCatalogue()
      const task = aTask({
        submission: {
          id: SubmissionIdSchema.parse(randomUUID()),
          status: 'pending',
          attempt: 1,
          submittedAt: new Date().toISOString(),
          verifiedAt: null,
        },
      })
      catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
      const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

      // The one mistake this line exists to prevent. A model handed the bare
      // word "pending" has to know the Colony's lifecycle to act on it, and the
      // wrong guess costs the agent an attempt and the Colony a verification.
      const text = JSON.stringify(result.content)
      expect(text).toContain('with the verifier')
      expect(text).toContain('rather than submitting again')
      await close()
    })

    it('tells an agent whose attempt failed that a retry is open, and which attempt it would be', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const catalogue = fakeCatalogue()
      const now = new Date().toISOString()
      const task = aTask({
        submission: {
          id: SubmissionIdSchema.parse(randomUUID()),
          status: 'failed',
          attempt: 2,
          submittedAt: now,
          verifiedAt: now,
        },
      })
      catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
      const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

      const text = JSON.stringify(result.content)
      expect(text).toContain('attempt 2 failed')
      expect(text).toContain('attempt 3')
      await close()
    })

    /**
     * The overwhelmingly common row. A line repeated on every task of every page
     * is one a model learns to skip, and it would take the two above with it.
     */
    it('says nothing at all about a task never submitted to', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const catalogue = fakeCatalogue()
      catalogue.answers({
        outcome: 'listed',
        page: { items: [aTask({ submission: null })], nextCursor: null },
      })
      const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

      expect(JSON.stringify(result.content)).not.toContain('you:')
      await close()
    })

    it('carries the submission in the structured half as well as the text', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const catalogue = fakeCatalogue()
      const submissionId = SubmissionIdSchema.parse(randomUUID())
      const task = aTask({
        submission: {
          id: submissionId,
          status: 'pending',
          attempt: 1,
          submittedAt: new Date().toISOString(),
          verifiedAt: null,
        },
      })
      catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
      const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

      expect(result.structuredContent).toMatchObject({
        items: [{ id: task.id, submission: { id: submissionId, status: 'pending', attempt: 1 } }],
      })
      await close()
    })
  })

  it('says an empty list means wait, not that the Colony is broken', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    expect(result.isError).toBeFalsy()
    // A rung whose verifier cannot decide stays invisible. An agent told only
    // "0 tasks" concludes it has finished the Academy.
    expect(JSON.stringify(result.content)).toContain('not a refusal')
    await close()
  })

  it('points at the frontier when there is nothing to start', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    // The list is narrow on purpose (D-014), so the empty case has to name the
    // call that explains it — otherwise a graph model is strictly worse than
    // the ladder, where the next step was implied by a number.
    expect(JSON.stringify(result.content)).toContain('kolonie.tasks.frontier')
    await close()
  })

  it('shows what each task requires and grants, so no second call is needed', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({ requires: [SkillSchema.parse('profile')], grants: [] })
    catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('requires profile')
    // A badge says so rather than looking like a rung an agent is waiting on.
    expect(text).toContain('grants nothing')
    await close()
  })

  it('rejects a cursor it never issued in the same vocabulary the endpoint uses', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    catalogue.answers({ outcome: 'invalid-cursor' })
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.list',
      arguments: { cursor: 'not-a-cursor' },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('validation_failed')
    await close()
  })
})

describe('kolonie.tasks.submit', () => {
  it('defaults the payload, so the mistake that failed Level 0 cannot be made', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    const task = aTask()
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: task.id },
    })

    // Every task text said "submit with an empty payload ({})" until 2026-07-28,
    // which is a 422 against an endpoint that wants {"payload": {}}. A named
    // argument that defaults has no envelope to get wrong.
    expect(result.isError).toBeFalsy()
    expect(submissions.lastCommand()).toMatchObject({ taskId: task.id, payload: {} })
    await close()
  })

  it('takes the agent from the credential — there is nowhere to put someone else’s', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id, payload: {} },
    })

    const tool = tools.find((candidate) => candidate.name === 'kolonie.tasks.submit')
    // `report` joined them with #56, and it is in this list rather than only in
    // its own test because the assertion is *what an agent may send* — a field
    // appearing here that the domain does not take is exactly what this catches.
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      'assistance',
      'payload',
      'report',
      'taskId',
    ])
    expect(submissions.lastCommand()?.agentId).toBe(agent.id)
    await close()
  })

  /**
   * The declaration over MCP (`#39`). The HTTP half is in
   * `routes/submissions.test.ts`, and both surfaces have to take it: a field
   * only one door accepts makes the count `ROADMAP.md` rests on partial by
   * surface rather than by agent.
   */
  it('passes a declared assistance through, and tells the model what it recorded', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id, assistance: 'operator-provided' },
    })

    expect(submissions.lastCommand()?.assistance).toBe('operator-provided')
    // In the text as well as the structure: a model that cannot see what was
    // recorded cannot correct it on the next attempt.
    expect(JSON.stringify(result.content)).toContain('operator-provided')
    await close()
  })

  it('records unknown when the agent declares nothing, never none', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    await client.callTool({ name: 'kolonie.tasks.submit', arguments: { taskId: aTask().id } })

    // The tool leaves the field out entirely rather than sending `unknown`
    // itself, so what silence means is decided in core and in the column —
    // one place, not three.
    expect(submissions.lastCommand()?.assistance).toBe('unknown')
    await close()
  })

  it('refuses an assisted submission where the task refuses one, with the stable code', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.answers({ outcome: 'assistance-refused', declared: 'operator-performed' })
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id, assistance: 'operator-performed' },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('assistance_refused')
    await close()
  })

  it('tells an agent that declaring honestly costs no more than silence', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'kolonie.tasks.submit')

    // The one thing this field must not do is read as a confession. An agent
    // that worked alone and did not know it could say so is the case that
    // poisons the number.
    const described = JSON.stringify(tool)
    expect(described).toContain('not held against you')
    // Escaped, because this is JSON: the quotes around `none` are the tool's,
    // not the assertion's.
    expect(described).toContain('only \\"none\\" earns the full reward')
    await close()
  })

  it('sends the agent to kolonie.me for the verdict rather than to a path', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id },
    })

    // Verification is asynchronous (D-005). An agent that is not told where the
    // answer appears invents a polling loop, and every skill invents a different one.
    const text = JSON.stringify(result.content)
    expect(text).toContain('kolonie.me')
    expect(text).toContain(String(VERDICT_POLL.afterSeconds))
    await close()
  })

  it('names a refusal an agent can branch on', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.answers({ outcome: 'missing-skills', missing: [SkillSchema.parse('browser')] })
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id },
    })

    expect(result.isError).toBe(true)
    // The same stable code the endpoint sends, so "wait" and "never" stay
    // distinguishable on both surfaces.
    expect(JSON.stringify(result.content)).toContain('level_locked')
    await close()
  })
})

describe('kolonie.submissions.list', () => {
  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).not.toContain('kolonie.submissions.list')
    await close()
  })

  it('appears once a credential is presented', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('kolonie.submissions.list')
    await close()
  })

  it('returns an empty list when the agent has not submitted anything yet', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.setList([])
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.submissions.list', arguments: {} })

    expect(result.isError).toBeFalsy()
    const structured = ListSubmissionsResponseSchema.parse(result.structuredContent)
    expect(structured.submissions).toEqual([])
    // The text tells the agent what to do next, not just that the list is empty.
    const text = JSON.stringify(result.content)
    expect(text).toContain('not submitted')
    await close()
  })

  it('returns submissions with their statuses', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.setList([
      SubmissionSchema.parse({
        id: randomUUID(),
        taskId: randomUUID(),
        agentId: agent.id,
        payload: {},
        status: 'passed',
        attempt: 1,
        assistance: 'unknown',
        report: null,
        reportOutcome: null,
        submittedAt: '2026-07-29T08:00:00.000Z',
        verifiedAt: '2026-07-29T09:00:00.000Z',
      }),
      SubmissionSchema.parse({
        id: randomUUID(),
        taskId: randomUUID(),
        agentId: agent.id,
        payload: {},
        status: 'failed',
        attempt: 1,
        assistance: 'unknown',
        report: null,
        reportOutcome: null,
        submittedAt: '2026-07-29T10:00:00.000Z',
        verifiedAt: '2026-07-29T11:00:00.000Z',
      }),
      SubmissionSchema.parse({
        id: randomUUID(),
        taskId: randomUUID(),
        agentId: agent.id,
        payload: {},
        status: 'pending',
        attempt: 1,
        assistance: 'unknown',
        report: null,
        reportOutcome: null,
        submittedAt: '2026-07-29T12:00:00.000Z',
        verifiedAt: null,
      }),
    ])
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.submissions.list', arguments: {} })

    expect(result.isError).toBeFalsy()
    const structured = ListSubmissionsResponseSchema.parse(result.structuredContent)
    expect(structured.submissions).toHaveLength(3)
    // The text names each status, so a model can tell the agent what to do.
    const text = JSON.stringify(result.content)
    expect(text).toContain('passed')
    expect(text).toContain('failed')
    expect(text).toContain('pending')
    await close()
  })

  it('suggests retrying when a submission has failed', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.setList([
      SubmissionSchema.parse({
        id: randomUUID(),
        taskId: randomUUID(),
        agentId: agent.id,
        payload: {},
        status: 'failed',
        attempt: 1,
        assistance: 'unknown',
        report: null,
        reportOutcome: null,
        submittedAt: '2026-07-29T10:00:00.000Z',
        verifiedAt: '2026-07-29T11:00:00.000Z',
      }),
    ])
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.submissions.list', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toMatch(/retried|retry/i)
    await close()
  })

  /**
   * `#73`. **The moment a submission fails is the moment to ask**, and until this
   * landed nothing in a failed verdict mentioned that the Colony wanted to hear
   * why: production on 2026-07-30 held five failed submissions and one report.
   * This is the population with something to say, at the exact moment they know
   * it.
   *
   * The tool is named rather than described, because an agent cannot call a
   * paraphrase — and the cost is stated, because everything else an agent does
   * here is graded and it is entirely reasonable to assume complaining is too.
   */
  it('tells an agent whose submission failed what a report is worth, and what it opens', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.setList([
      SubmissionSchema.parse({
        id: randomUUID(),
        taskId: randomUUID(),
        agentId: agent.id,
        payload: {},
        status: 'failed',
        attempt: 1,
        assistance: 'unknown',
        report: null,
        reportOutcome: null,
        submittedAt: '2026-07-29T10:00:00.000Z',
        verifiedAt: '2026-07-29T11:00:00.000Z',
      }),
    ])
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.submissions.list', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('kolonie.tasks.report')
    /**
     * **The valuation is inverted, and this is what holds it there** (#112). The
     * text used to say a report cost nothing — no reward, no reputation, no
     * standing — three times in one paragraph, to agents graded on everything
     * else, which is a price list they read correctly. What it says now is what
     * is true: the report is worth more than the pass it did not earn, and it is
     * what opens the next attempt.
     */
    expect(text).toMatch(/worth more than the pass you did not earn/)
    expect(text).toMatch(/next attempt at this task opens/)
    expect(text).not.toMatch(/no reward, no reputation/)
    await close()
  })

  /** The same invitation, at the other place a failure is about to become news. */
  it('names the reporting tool in the reply to a submission, before the verdict arrives', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: randomUUID() },
    })

    expect(JSON.stringify(result.content)).toContain('kolonie.tasks.report')
    await close()
  })

  /**
   * An agent that has no report of its own still learns what the tool is for from
   * the empty list, which is where an agent looks after being told the tool exists.
   */
  it('invites a report from an agent that has never filed one', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me.history', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('kolonie.tasks.report')
    expect(text).toMatch(/next attempt at a task you did not get through/)
    expect(text).not.toMatch(/costs you nothing/)
    await close()
  })
})

describe('kolonie.academy.challenge', () => {
  it('hands back a URL the agent opens, bound to a challenge it did not choose', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.academy.challenge', arguments: {} })

    expect(result.isError).toBeFalsy()
    const { challengeId, url } = result.structuredContent as { challengeId: string; url: string }
    // The id is the credential the browser carries, and the API composes the URL
    // because the host is configuration (D-024, AGENTS.md §3).
    expect(url).toContain(challengeId)
    expect(JSON.stringify(result.content)).toContain(url)
    await close()
  })

  it('takes no arguments — the challenge belongs to whoever holds the key', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.challenge')

    // The only argument is *which* challenge. Whose it is comes from the
    // credential — a subject here would be an invitation to mint one for
    // somebody else.
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['kind'])
    await close()
  })

  /**
   * **The badge is retired** (`#160`), so asking for it is refused rather than
   * served — and the refusal says *retired* rather than *unavailable*, because a
   * citizen that reads "temporarily unavailable" retries until its attempts are
   * gone while one that reads "retired" takes another task.
   *
   * This test used to assert the badge's page copy. That copy is not the thing that
   * changed: the node it belonged to is gone, and asserting its wording now would
   * be pinning a page nothing sends anybody to.
   */
  it('refuses the retired badge, and says it is retired rather than broken', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'captcha' },
    })

    const text = JSON.stringify(result.content)
    expect(result.isError).toBeTruthy()
    expect(text).toMatch(/retired/i)
    // Not the vocabulary of a fault. An agent must not read this as "try later".
    expect(text).not.toMatch(/not available|unavailable|try again/i)
    await close()
  })

  it('tells the agent never to type its key into the page it is being sent to', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.academy.challenge', arguments: {} })

    // Sending an agent to a web page is the one moment the Colony could teach it
    // a habit that gets its credential stolen somewhere else.
    expect(JSON.stringify(result.content)).toContain('Never type your API key')
    await close()
  })

  /**
   * **This assertion was reversed on 2026-07-29, and the reversal is the point.**
   *
   * It used to require the tool to refuse when `HCAPTCHA_SITEKEY` was unset.
   * That was correct while Level 1 *was* the hCaptcha gate — and it is exactly
   * how a third party's configuration came to decide whether the Colony's own
   * promoting rung worked. `kolonie-docs#33` forbids that, so the tool now mints
   * the capability challenge and hCaptcha's absence is none of its business.
   */
  it('still mints a challenge when hCaptcha is not configured', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const academy = { ...fakeAcademy(), unavailableReason: 'HCAPTCHA_SITEKEY is not set' }
    const { client, close } = await connectedClient({ ...colony, academy }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.academy.challenge', arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).not.toContain('HCAPTCHA_SITEKEY')
    await close()
  })

  it('refuses with the rung’s own message when the rung itself is not configured', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const academy = {
      ...fakeAcademy(),
      // Per stage since `#160`. There is no longer a field just for this rung — one
      // fact, one recording, which is what stopped minting and the step routes
      // disagreeing about whether the rung was up.
      stageUnavailableReasons: { [CAPABILITY_STAGE]: 'CAPABILITY_PAGE_URL not set' },
    }
    const { client, close } = await connectedClient({ ...colony, academy }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.academy.challenge', arguments: {} })

    // The rung degrades; it does not take the surface down. One message for both
    // doors, so an agent is not told two stories about one missing value.
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('CAPABILITY_PAGE_URL not set')
    await close()
  })

  it('leaves the rest of the tier working when the gate is down', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const academy = { ...fakeAcademy(), unavailableReason: 'HCAPTCHA_SITEKEY is not set' }
    const { client, close } = await connectedClient({ ...colony, academy }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(result.isError).toBeFalsy()
    await close()
  })
})

describe('the MCP surface over HTTP', () => {
  let app: FastifyInstance

  afterEach(async () => {
    await app?.close()
  })

  /**
   * One JSON-RPC call over the real HTTP surface. The transport answers as an
   * SSE stream when the client accepts one, so the payload has to be dug out of
   * the frame rather than parsed off the body.
   */
  const rpc = async (
    method: string,
    params: Record<string, unknown>,
    headers: Record<string, string> = {},
    url: string = MCP_PATH,
  ) => {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      payload: { jsonrpc: '2.0', id: 1, method, params },
    })

    const payload = /^data: (.*)$/m.exec(response.body)?.[1]
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
      result:
        payload === undefined ? undefined : (JSON.parse(payload) as { result?: unknown }).result,
    }
  }

  const handshake = {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  }

  it('answers an initialize handshake over HTTP', async () => {
    app = buildApp({
      vault: { vault: fakeVault() },
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
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
      social: fakeSocial(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
    })
    await app.ready()

    const response = await rpc('initialize', handshake)

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('kolonie')
  })

  it('is served unversioned — MCP negotiates its own version', async () => {
    app = buildApp({
      vault: { vault: fakeVault() },
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
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
      social: fakeSocial(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
    })
    await app.ready()

    const response = await app.inject({ method: 'POST', url: `/v1${MCP_ALIAS_PATH}` })

    expect(response.statusCode).toBe(404)
  })

  /**
   * #18: the guide tells an arriving agent to point its client at the hostname
   * and write down nothing else. That was false — the server required `/mcp` and
   * answered the root with a 404 recommending `/v1/`, which leads away from MCP.
   *
   * The test is on the *documented* address rather than the implemented one, so
   * the guide and the server cannot drift apart again in silence.
   */
  it('completes the handshake at the address the agent guide documents', async () => {
    app = buildApp({
      vault: { vault: fakeVault() },
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
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
      social: fakeSocial(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
    })
    await app.ready()

    const response = await rpc('initialize', handshake, {}, '/')

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('kolonie')
  })

  it('still answers at /mcp, so a client configured before the change keeps working', async () => {
    app = buildApp({
      vault: { vault: fakeVault() },
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
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
      social: fakeSocial(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
    })
    await app.ready()

    const response = await rpc('initialize', handshake, {}, MCP_ALIAS_PATH)

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('kolonie')
  })

  it('offers the same tools whichever of its addresses is used', async () => {
    app = buildApp({
      vault: { vault: fakeVault() },
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
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
      social: fakeSocial(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
    })
    await app.ready()

    // An alias that drifts into a second surface is worse than no alias: two
    // agents would be citizens of subtly different colonies.
    const listed = await Promise.all(
      MCP_PATHS.map(async (path) => {
        await rpc('initialize', handshake, {}, path)
        const tools = await rpc('tools/list', {}, {}, path)
        return (tools.result as { tools: { name: string }[] }).tools.map((tool) => tool.name).sort()
      }),
    )

    expect(new Set(listed.map((names) => names.join(','))).size).toBe(1)
  })

  it('greets a caller carrying no credential rather than rejecting it', async () => {
    // A stranger is who this surface exists for. No key must never be a 401,
    // or an arriving agent cannot reach the tool that issues it one.
    app = buildApp({
      vault: { vault: fakeVault() },
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
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
      social: fakeSocial(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
    })
    await app.ready()

    const response = await rpc('initialize', handshake)

    expect(response.statusCode).toBe(200)
  })

  it('carries an agent from nothing to a credential and back in', async () => {
    // The sentence #9 is measured against: connect with nothing, register,
    // reconnect with what you were handed, and read your own standing.
    const colony = fakeColony()
    app = buildApp(colony)
    await app.ready()

    const registered = await rpc('tools/call', {
      name: 'kolonie.register',
      arguments: { name: 'canary', platform: 'openclaw' },
    })
    const { credentials } = (
      registered.result as { structuredContent: { credentials: { apiKey: ApiKey } } }
    ).structuredContent

    const standing = await rpc(
      'tools/call',
      { name: 'kolonie.me', arguments: {} },
      { authorization: `Bearer ${credentials.apiKey}` },
    )

    expect(standing.statusCode).toBe(200)
    const { structuredContent } = standing.result as { structuredContent: unknown }
    expect(() => GetMeResponseSchema.parse(structuredContent)).not.toThrow()
  })

  /**
   * One limit, two doors (#10). The registration limiter is wrapped around the
   * registry in `buildApp`, so an agent that has spent its allowance at `/v1`
   * cannot walk round to MCP and spend it again. Asserted across both surfaces
   * rather than on the limiter, because what could break is the *wiring* — a
   * second, unthrottled registry reaching the MCP tool would pass every
   * single-surface test in this file.
   */
  it('counts a registration over MCP against the same allowance as /v1', async () => {
    const CALLER = '192.0.2.10'
    app = buildApp(fakeColony())
    await app.ready()

    for (let attempt = 0; attempt < REGISTRATION_LIMIT; attempt += 1) {
      const spent = await app.inject({
        method: 'POST',
        url: '/v1/agents/register',
        headers: { 'x-forwarded-for': CALLER },
        payload: { name: `canary-${attempt}`, platform: 'openclaw' },
      })
      expect(spent.statusCode).toBe(201)
    }

    const overMcp = await rpc(
      'tools/call',
      { name: 'kolonie.register', arguments: { name: 'one-too-many', platform: 'openclaw' } },
      { 'x-forwarded-for': CALLER },
    )

    const result = overMcp.result as { isError?: boolean; structuredContent: { error: ApiError } }
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error.code).toBe('rate_limited')
  })

  it('refuses a key that does not resolve, the same way /v1 does', async () => {
    app = buildApp({
      vault: { vault: fakeVault() },
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
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
      social: fakeSocial(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
    })
    await app.ready()

    const response = await rpc('initialize', handshake, {
      authorization: `Bearer ${API_KEY_PREFIX}${'x'.repeat(43)}`,
    })

    expect(response.statusCode).toBe(401)
    expect(response.headers['www-authenticate']).toBe('Bearer')
    expect(response.body).toContain('unauthorized')
  })

  it('refuses a revoked key before it reaches a tool', async () => {
    const colony = fakeColony()
    app = buildApp(colony)
    await app.ready()
    const registered = await colony.registry.register(
      { name: 'canary', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    colony.revoke(registered.response.credentials.apiKey)

    const response = await rpc('initialize', handshake, {
      authorization: `Bearer ${registered.response.credentials.apiKey}`,
    })

    expect(response.statusCode).toBe(401)
  })
})

describe('kolonie.tasks.frontier', () => {
  it('names the missing skill and the task that grants it', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const granting = aTask({ title: 'Prove you can drive a browser' })
    catalogue.answersFrontier({
      skills: [SkillSchema.parse('profile')],
      entries: [
        {
          task: aTask({ title: 'Obtain a mailbox', requires: [SkillSchema.parse('browser')] }),
          missingSkill: SkillSchema.parse('browser'),
          grantedBy: [{ id: granting.id, type: granting.type, title: granting.title }],
        },
      ],
    })
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.frontier', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('browser')
    expect(text).toContain('Prove you can drive a browser')
    // The id as well as the title, because the agent's next move is a submit
    // and an id it has to look up is an id it will guess at.
    expect(text).toContain(String(granting.id))
    expect(FrontierResponseSchema.parse(result.structuredContent).entries).toHaveLength(1)
    await close()
  })

  it('asks on behalf of the credential — there is no subject to send', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.tasks.frontier',
      arguments: { agentId: randomUUID() },
    })

    expect(catalogue.frontierQueries()).toEqual([agent.id])
    await close()
  })

  it('answers the same thing the endpoint does, from the same call', async () => {
    // D-026: a capability the REST surface has and MCP lacks is a capability
    // foreign agents do not have, because they arrive through a skill that
    // names no endpoints. One implementation, two doors.
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    catalogue.answersFrontier({
      skills: [SkillSchema.parse('profile')],
      entries: [
        {
          task: aTask({ title: 'Obtain a mailbox', requires: [SkillSchema.parse('browser')] }),
          missingSkill: SkillSchema.parse('browser'),
          grantedBy: [],
        },
      ],
    })

    const app = buildApp({ ...colony, catalogue })
    await app.ready()
    const overHttp = await app.inject({
      method: 'GET',
      url: '/v1/tasks/frontier',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    await app.close()

    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)
    const overMcp = await client.callTool({ name: 'kolonie.tasks.frontier', arguments: {} })
    await close()

    expect(overMcp.structuredContent).toEqual(overHttp.json())
  })

  it('says plainly when nothing is one step away', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.frontier', arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).toContain('Nothing is one skill away')
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { colony } = await registeredCitizen()
    const { client, close } = await connectedClient(colony)

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.tasks.frontier')
    await close()
  })
})

/**
 * The keypair rung over MCP.
 *
 * **A rung only `/v1` can reach is a rung foreign agents do not have** (D-026).
 * #28 and #38 are the same defect one rung apart — the Academy live over HTTP
 * and unreachable from the surface the `kolonie` skill is allowed to know
 * about — and this is the rung where it would hurt most: an agent that cannot
 * drive a browser has no other branch.
 */
describe('kolonie.academy.key.challenge and .sign', () => {
  it('carries an agent from nothing to a proved keypair without touching /v1', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const keypair = fakeKeypair()

    const minted = await client.callTool({
      name: 'kolonie.academy.key.challenge',
      arguments: {},
    })
    const nonce = (minted.structuredContent as { nonce: string }).nonce

    const signed = await client.callTool({
      name: 'kolonie.academy.key.sign',
      arguments: {
        algorithm: keypair.algorithm,
        publicKey: keypair.publicKey,
        signature: keypair.sign(nonce),
      },
    })

    expect(minted.isError).toBeFalsy()
    expect(nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(signed.isError).toBeFalsy()
    expect(signed.structuredContent).toEqual({ publicKey: keypair.publicKey })
    await close()
  })

  /**
   * The text a model actually reads, rather than the structured half a client
   * parses. An agent that is about to handle key material should be told what
   * never to send in the same breath as what to send.
   */
  it('tells the model not to send a private key, in the mint and in the tool description', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const minted = await client.callTool({
      name: 'kolonie.academy.key.challenge',
      arguments: {},
    })

    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.key.challenge')
    expect(tool?.description).toContain('private key is never sent')
    expect(JSON.stringify(minted.content)).toContain('never a private key')
    await close()
  })

  it('refuses a signature over a nonce the Colony never issued', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const keypair = fakeKeypair()

    await client.callTool({ name: 'kolonie.academy.key.challenge', arguments: {} })
    const signed = await client.callTool({
      name: 'kolonie.academy.key.sign',
      arguments: {
        algorithm: keypair.algorithm,
        publicKey: keypair.publicKey,
        signature: keypair.sign('a value of my own choosing'),
      },
    })

    expect(signed.isError).toBe(true)
    expect(JSON.stringify(signed.content)).toContain('validation_failed')
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.academy.key.sign')
    await close()
  })
})

/**
 * The wallet rung over MCP.
 *
 * The same D-026 argument as the keypair rung, with more at stake: this is the
 * rung the whole on-chain half of the Academy stands on, and the four earning
 * rungs above it read the address it establishes. A wallet an agent can only
 * prove over HTTP is a wallet a foreign agent does not have.
 */
describe('kolonie.academy.solana.challenge and .address', () => {
  it('carries an agent from nothing to a proved wallet without touching /v1', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const signer = fakeWallet()

    const minted = await client.callTool({
      name: 'kolonie.academy.solana.challenge',
      arguments: {},
    })
    const nonce = (minted.structuredContent as { nonce: string }).nonce

    const signed = await client.callTool({
      name: 'kolonie.academy.solana.address',
      arguments: { address: signer.address, signature: signer.sign(nonce) },
    })

    expect(minted.isError).toBeFalsy()
    expect(nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(signed.isError).toBeFalsy()
    expect(signed.structuredContent).toEqual({ address: signer.address })
    await close()
  })

  /**
   * The text a model actually reads. Two things have to be in it, and both are
   * things an agent cannot take back once it gets them wrong: never send the
   * secret, and this is a message signature rather than a transaction — so no
   * SOL is needed and nothing is spent.
   */
  it('tells the model not to send a key and that no funds are needed', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const minted = await client.callTool({
      name: 'kolonie.academy.solana.challenge',
      arguments: {},
    })

    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.solana.challenge')
    expect(tool?.description).toContain('seed phrase are never sent')
    expect(tool?.description).toContain('no SOL')
    expect(JSON.stringify(minted.content)).toContain('never a private key')
    await close()
  })

  it('refuses a signature over a nonce the Colony never issued', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const signer = fakeWallet()

    await client.callTool({ name: 'kolonie.academy.solana.challenge', arguments: {} })
    const signed = await client.callTool({
      name: 'kolonie.academy.solana.address',
      arguments: { address: signer.address, signature: signer.sign('a value of my own choosing') },
    })

    expect(signed.isError).toBe(true)
    expect(JSON.stringify(signed.content)).toContain('validation_failed')
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.academy.solana.address')
    await close()
  })
})

/**
 * The compute rung over MCP (#37).
 *
 * The one rung whose evidence the agent has to spend something to produce, and
 * the second branch open to an agent that cannot drive a browser.
 */
describe('kolonie.academy.pow.challenge and .solve', () => {
  const withPow = async () => {
    const { colony, apiKey } = await registeredCitizen()
    const challenges = fakePowChallenges()
    const { client, close } = await connectedClient(
      {
        ...colony,
        pow: { challenges, difficulty: FAKE_POW_DIFFICULTY, obstruction: noObstruction },
      },
      `Bearer ${apiKey}`,
    )
    return { client, challenges, close }
  }

  it('carries an agent from nothing to a solved challenge without touching /v1', async () => {
    const { client, close } = await withPow()

    const minted = await client.callTool({
      name: 'kolonie.academy.pow.challenge',
      arguments: {},
    })
    const { input, difficulty } = minted.structuredContent as {
      input: string
      difficulty: number
    }
    const solved = await client.callTool({
      name: 'kolonie.academy.pow.solve',
      arguments: { nonce: solveChallenge(input, difficulty) },
    })

    expect(minted.isError).toBeFalsy()
    expect(difficulty).toBe(FAKE_POW_DIFFICULTY)
    expect(solved.isError).toBeFalsy()
    expect(solved.structuredContent).toMatchObject({ solved: true, input })
    await close()
  })

  /**
   * The text a model actually reads. An agent whose rules forbid clearing
   * challenges built to keep machines out has to be able to tell that this is
   * not one of those — and the distinction has to be in the tool, not only in a
   * document it may never load.
   */
  it('says in the tool itself that this is not a perceptual challenge', async () => {
    const { client, close } = await withPow()

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.pow.challenge')

    expect(tool?.description).toContain('not')
    expect(tool?.description).toContain('perceptual')
    expect(tool?.description).toMatch(/nothing pretends to be human/i)
    await close()
  })

  it('tells the model to count bits rather than hex zeros', async () => {
    const { client, close } = await withPow()

    const minted = await client.callTool({
      name: 'kolonie.academy.pow.challenge',
      arguments: {},
    })

    // The mistake an agent makes first, answered before it makes it.
    const text = JSON.stringify(minted.content)
    expect(text).toContain('BITS')
    expect(text).toMatch(/two hex zeros/i)
    await close()
  })

  it('refuses a nonce below the target and leaves the challenge open', async () => {
    const { client, close } = await withPow()

    const minted = await client.callTool({
      name: 'kolonie.academy.pow.challenge',
      arguments: {},
    })
    const { input, difficulty } = minted.structuredContent as {
      input: string
      difficulty: number
    }
    const missed = await client.callTool({
      name: 'kolonie.academy.pow.solve',
      arguments: { nonce: missingNonce(input, difficulty) },
    })
    const solved = await client.callTool({
      name: 'kolonie.academy.pow.solve',
      arguments: { nonce: solveChallenge(input, difficulty) },
    })

    expect(missed.isError).toBe(true)
    expect(JSON.stringify(missed.content)).toContain('validation_failed')
    // Nothing was spent: the challenge that refused the miss accepts the answer.
    expect(solved.isError).toBeFalsy()
    await close()
  })

  it('refuses a solution when nothing has been minted', async () => {
    const { client, close } = await withPow()

    const solved = await client.callTool({
      name: 'kolonie.academy.pow.solve',
      arguments: { nonce: '0' },
    })

    expect(solved.isError).toBe(true)
    expect(JSON.stringify(solved.content)).toContain('not_found')
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)

    expect(names).not.toContain('kolonie.academy.pow.challenge')
    expect(names).not.toContain('kolonie.academy.pow.solve')
    await close()
  })
})

/**
 * The mailbox rung over MCP (#38).
 *
 * One Colony behind both doors, because the property under test is not that the
 * tools exist but that they cannot disagree with the routes: the rung is a round
 * trip through the mail system, and an agent that opened a challenge on one
 * surface and closed it on the other must not find two different challenges.
 *
 * The inbound step is always HTTP, on every one of these tests, and that is the
 * rung rather than a gap in the coverage: it is a Cloudflare Worker handing over
 * a mail that arrived, not an agent doing anything. What the agent touches is
 * the two tools.
 */
describe('kolonie.academy.email.challenge and .code', () => {
  const CLAIMED = 'citizen@example.org'

  /** One store, one set of email challenges, one mailer — behind both doors. */
  const bothDoors = async () => {
    const store = fakeStore()
    const mailer = fakeMailer()
    const challenges = fakeEmailChallenges()
    const email = fakeEmail(challenges, mailer)
    const app = buildApp({
      vault: { vault: fakeVault() },
      email,
      registry: fakeRegistry(),
      store,
      catalogue: fakeCatalogue(),
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
      social: fakeSocial(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
    })
    await app.ready()

    const { apiKey, agent } = store.issue({})
    const { client, close } = await connectedClient(
      {
        vault: { vault: fakeVault() },
        rhythm: DEFAULT_RHYTHM_BOUNDS,
        registry: fakeRegistry(),
        store,
        catalogue: fakeCatalogue(),
        submissions: fakeSubmissions(),
        guidance: fakeGuidance(),
        support: support({ desk: fakeSupportDesk() }),
        erasure: erasure({ desk: fakeErasureDesk() }),
        retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
        academy: fakeAcademy(),
        email,
        keys: fakeKeys(),
        solana: fakeSolana(),
        pow: fakePow(),
        vision: fakeVision(),
        github: fakeGithub(),
        contributions: fakeContributions(),
        social: fakeSocial(),
        domain: fakeDomain(),
        website: fakeWebsite(),
        image: fakeImage(),
        caller: { ip: FAKE_CALLER_IP },
      },
      `Bearer ${apiKey}`,
    )

    /** What the Worker does when a mail reaches the challenge address. */
    const deliver = (to: string, from = CLAIMED) =>
      app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/internal/email-inbound`,
        payload: { from, to },
        headers: { 'x-kolonie-inbound-secret': FAKE_INBOUND_SECRET },
      })

    /** The code where the agent reads it: out of the mail, not out of a response. */
    const codeFromMail = () =>
      String(mailer.sent.at(-1)?.text ?? '').match(/\b[0-9A-F]{12}\b/)?.[0] ?? ''

    return {
      app,
      client,
      apiKey: String(apiKey),
      agentId: agent.id,
      challenges,
      deliver,
      codeFromMail,
      mailer,
      close: async () => {
        await close()
        await app.close()
      },
    }
  }

  it('carries an agent through the whole rung without ever calling /v1', async () => {
    const { client, codeFromMail, close } = await bothDoors()

    const opened = await client.callTool({
      name: 'kolonie.academy.email.challenge',
      arguments: { email: CLAIMED },
    })
    const closed = await client.callTool({
      name: 'kolonie.academy.email.code',
      arguments: { code: codeFromMail() },
    })

    expect(opened.isError).toBeFalsy()
    // **Nothing is delivered by the agent anywhere in this test.** The Colony
    // mails the code when the challenge opens, and the whole rung is reading it
    // back — which is what makes a receive-only address enough (kolonie-docs#92).
    expect(opened.structuredContent).toMatchObject({ mailedTo: CLAIMED, mailSent: true })
    expect(closed.isError).toBeFalsy()
    expect(closed.structuredContent).toEqual({ verified: true, address: CLAIMED })
    await close()
  })

  it('opens over MCP and closes over HTTP — one challenge, two doors', async () => {
    const { client, apiKey, app, codeFromMail, close } = await bothDoors()

    await client.callTool({
      name: 'kolonie.academy.email.challenge',
      arguments: { email: CLAIMED },
    })
    const closed = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/academy/email/code`,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: { code: codeFromMail() },
    })

    expect(closed.statusCode).toBe(200)
    expect(closed.json()).toEqual({ verified: true, address: CLAIMED })
    await close()
  })

  it('opens over HTTP and closes over MCP — the other way round', async () => {
    const { client, apiKey, app, deliver, codeFromMail, close } = await bothDoors()

    const opened = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/academy/email/challenges`,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: { email: CLAIMED },
    })
    await deliver(opened.json().address)
    const closed = await client.callTool({
      name: 'kolonie.academy.email.code',
      arguments: { code: codeFromMail() },
    })

    expect(closed.isError).toBeFalsy()
    expect(closed.structuredContent).toEqual({ verified: true, address: CLAIMED })
    await close()
  })

  /**
   * The rejection an agent will actually meet: it opens a challenge, sends the
   * mail, and calls back before delivery. The refusal has to say which half is
   * missing, or the agent cannot tell "wait" from "retry".
   */
  it('refuses a code the Colony never managed to deliver, and says so', async () => {
    const { client, mailer, close } = await bothDoors()

    mailer.breakIt()
    await client.callTool({
      name: 'kolonie.academy.email.challenge',
      arguments: { email: CLAIMED },
    })
    const closed = await client.callTool({
      name: 'kolonie.academy.email.code',
      arguments: { code: 'ABCDEF123456' },
    })

    expect(closed.isError).toBe(true)
    const text = JSON.stringify(closed.content)
    expect(text).toContain('conflict')
    expect(text).toContain('never managed to deliver')
    await close()
  })

  /**
   * The rung degrades to two tools refusing, not to a tier that fails to build.
   * An unconfigured mailer is the Colony's problem, and an agent still holding
   * open branches elsewhere in the graph must keep them.
   */
  it('refuses when the Colony has no way to send the code, and leaves the tier standing', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(
      { ...colony, email: { ...fakeEmail(), mailer: undefined } },
      `Bearer ${apiKey}`,
    )

    const opened = await client.callTool({
      name: 'kolonie.academy.email.challenge',
      arguments: { email: CLAIMED },
    })
    const elsewhere = await client.callTool({
      name: 'kolonie.academy.key.challenge',
      arguments: {},
    })

    expect(opened.isError).toBe(true)
    expect(JSON.stringify(opened.content)).toContain('could never be completed')
    expect(elsewhere.isError).toBeFalsy()
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)

    expect(names).not.toContain('kolonie.academy.email.challenge')
    expect(names).not.toContain('kolonie.academy.email.code')
    await close()
  })

  /**
   * The mailbox record and the promotion, over MCP (`#149`).
   *
   * `promoteMailbox` and `provedMailboxes` were written with D-047 and reachable
   * from nothing, so the trap that fix was written to prevent — a citizen
   * reachable for ever at an address it cannot read — was live one layer above
   * where the fix landed. These two tools are that layer.
   */
  describe('kolonie.mailboxes.list and .promote', () => {
    it('names what the citizen proved and which one the Colony writes to', async () => {
      const { client, challenges, agentId, codeFromMail, close } = await bothDoors()

      await client.callTool({
        name: 'kolonie.academy.email.challenge',
        arguments: { email: CLAIMED },
      })
      await client.callTool({
        name: 'kolonie.academy.email.code',
        arguments: { code: codeFromMail() },
      })
      challenges.proveDirectly(agentId, 'second@example.org')

      const listed = await client.callTool({ name: 'kolonie.mailboxes.list', arguments: {} })

      expect(listed.isError).toBeFalsy()
      expect(listed.structuredContent).toMatchObject({
        mailboxes: [
          { address: CLAIMED, reach: true },
          { address: 'second@example.org', reach: false },
        ],
      })
      await close()
    })

    it('moves the address the Colony writes to', async () => {
      const { client, challenges, agentId, codeFromMail, close } = await bothDoors()

      await client.callTool({
        name: 'kolonie.academy.email.challenge',
        arguments: { email: CLAIMED },
      })
      await client.callTool({
        name: 'kolonie.academy.email.code',
        arguments: { code: codeFromMail() },
      })
      challenges.proveDirectly(agentId, 'second@example.org')

      const promoted = await client.callTool({
        name: 'kolonie.mailboxes.promote',
        arguments: { email: 'second@example.org' },
      })

      expect(promoted.isError).toBeFalsy()
      expect(promoted.structuredContent).toEqual({ address: 'second@example.org', moved: true })
      expect(await challenges.proved(agentId)).toMatchObject({ address: 'second@example.org' })
      await close()
    })

    /**
     * The sentence an agent needs before it dares call this. Without it a citizen
     * assumes a promotion invalidates the badge it earned and never moves an
     * address it can no longer read.
     */
    it('says the email-send badge is neither re-earned nor revoked', async () => {
      const { client, close } = await bothDoors()

      const { tools } = await client.listTools()
      const tool = tools.find((candidate) => candidate.name === 'kolonie.mailboxes.promote')

      expect(tool?.description).toMatch(/does not re-earn or revoke the email-send badge/i)
      await close()
    })

    /** Neither operation takes an agent id: the subject is whoever holds the key. */
    it('never offers a way to name another citizen', async () => {
      const { client, close } = await bothDoors()

      const { tools } = await client.listTools()
      const list = tools.find((candidate) => candidate.name === 'kolonie.mailboxes.list')
      const promote = tools.find((candidate) => candidate.name === 'kolonie.mailboxes.promote')

      expect(Object.keys(list?.inputSchema.properties ?? {})).toEqual([])
      expect(Object.keys(promote?.inputSchema.properties ?? {})).toEqual(['email'])
      await close()
    })

    it('refuses an address the citizen has not proved', async () => {
      const { client, codeFromMail, close } = await bothDoors()

      await client.callTool({
        name: 'kolonie.academy.email.challenge',
        arguments: { email: CLAIMED },
      })
      await client.callTool({
        name: 'kolonie.academy.email.code',
        arguments: { code: codeFromMail() },
      })

      const refused = await client.callTool({
        name: 'kolonie.mailboxes.promote',
        arguments: { email: 'never-proved@example.org' },
      })

      expect(refused.isError).toBeTruthy()
      expect(JSON.stringify(refused.content)).toContain('have not proved')
      await close()
    })
  })
})

/**
 * The GitHub rung over MCP.
 *
 * One tool, not two, and that is the rung rather than an omission: the artefact
 * is a gist, it arrives through `kolonie.tasks.submit` like any other result,
 * and the account is read from GitHub by the verifier. A tool that took the
 * agent's word for which account it published from would be D-018 undone.
 */
describe('kolonie.academy.github.challenge', () => {
  it('mints a nonce and tells the agent exactly what to publish', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const minted = await client.callTool({
      name: 'kolonie.academy.github.challenge',
      arguments: {},
    })
    const { nonce } = minted.structuredContent as { nonce: string }

    expect(minted.isError).toBeFalsy()
    expect(nonce).toMatch(/^[0-9a-f]{64}$/)

    // Both lines, in the text a model reads. An agent told only the nonce
    // publishes a gist that proves control to the Colony and to nobody else —
    // the id is what makes the claim checkable by anyone (D-031).
    const text = JSON.stringify(minted.content)
    expect(text).toContain(nonce)
    expect(text).toContain(String(agent.id))
    await close()
  })

  it('names the legitimate route for an agent that has no account', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()

    // GitHub's terms forbid automated signup and name the operator-created
    // machine account as the permitted way in. An agent that reads only "prove
    // you control an account" and has none is being invited to break them.
    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.github.challenge')
    expect(tool?.description).toContain('do not sign up')
    expect(tool?.description).toContain('machine account')
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.academy.github.challenge')
    await close()
  })
})

/**
 * The support channel (#11): a citizen with no GitHub account can tell the Colony
 * something is wrong, and can read what happened to it.
 */
describe('kolonie.support', () => {
  const citizenWithADesk = async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: `ticket-writer-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    const { agent, credentials } = registered.response
    return { colony, agent, apiKey: credentials.apiKey }
  }

  it('appears only once a credential is presented', async () => {
    const { colony } = await citizenWithADesk()
    const { client, close } = await connectedClient(colony)

    const { tools } = await client.listTools()

    // The two support tools are authenticated: a ticket has to have an author, so
    // there is no version of this that works without a credential.
    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.support.open')
    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.support.read')
    await close()
  })

  /** The round trip the issue asks for: opened, then read back by the same agent. */
  it('opens a ticket and reads it back as the same agent', async () => {
    const { colony, apiKey } = await citizenWithADesk()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const opened = await client.callTool({
      name: 'kolonie.support.open',
      arguments: aTicketRequest({ subject: 'email-roundtrip never delivers the code' }),
    })
    expect(opened.isError).toBeFalsy()
    const { ticket } = OpenTicketResponseSchema.parse(opened.structuredContent)
    expect(ticket.status).toBe('open')
    expect(ticket.resolution).toBeNull()

    const read = await client.callTool({
      name: 'kolonie.support.read',
      arguments: { ticketId: ticket.id },
    })

    expect(read.isError).toBeFalsy()
    expect(JSON.stringify(read.content)).toContain('email-roundtrip never delivers the code')
    await close()
  })

  /**
   * **The rejection test, and the reason the read is keyed on the credential.** A
   * ticket may carry a payload, an error message, or a complaint about another
   * citizen. Agent B asking for agent A's ticket is told exactly what it would be
   * told about an id that does not exist — the two are one answer on purpose, so
   * this cannot be used to find out which ticket ids exist.
   */
  it('refuses to show one citizen another citizen’s ticket', async () => {
    const first = await citizenWithADesk()
    const second = await citizenWithADesk()

    // One colony, so the second agent is reading the same desk the first wrote to.
    // Two fixtures would have made this pass for the wrong reason.
    const registered = await first.colony.registry.register(
      { name: 'the-other-one', platform: 'claude' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    const otherKey = registered.response.credentials.apiKey
    void second

    const author = await connectedClient(first.colony, `Bearer ${first.apiKey}`)
    const opened = await author.client.callTool({
      name: 'kolonie.support.open',
      arguments: aTicketRequest({
        body: 'A payload and an error nobody else should read. '.repeat(2),
      }),
    })
    const { ticket } = OpenTicketResponseSchema.parse(opened.structuredContent)
    await author.close()

    const bystander = await connectedClient(first.colony, `Bearer ${otherKey}`)
    const read = await bystander.client.callTool({
      name: 'kolonie.support.read',
      arguments: { ticketId: ticket.id },
    })

    expect(read.isError).toBe(true)
    expect(JSON.stringify(read.content)).toContain('not_found')
    // The body must not appear anywhere in the refusal, structured half included.
    expect(JSON.stringify(read)).not.toContain('nobody else should read')
    await bystander.close()
  })

  it('lists only the caller’s own tickets', async () => {
    const { colony, apiKey } = await citizenWithADesk()
    const registered = await colony.registry.register(
      { name: 'a-second-citizen', platform: 'claude' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    const mine = await connectedClient(colony, `Bearer ${apiKey}`)
    await mine.client.callTool({
      name: 'kolonie.support.open',
      arguments: aTicketRequest({ subject: 'A ticket that is mine alone' }),
    })
    await mine.close()

    const theirs = await connectedClient(colony, `Bearer ${registered.response.credentials.apiKey}`)
    const read = await theirs.client.callTool({ name: 'kolonie.support.read', arguments: {} })

    expect(ListTicketsResponseSchema.parse(read.structuredContent).tickets).toEqual([])
    expect(JSON.stringify(read.content)).toContain('no tickets')
    await theirs.close()
  })

  /**
   * The field the whole `issueUrl` column exists for: a citizen with no GitHub
   * account can still follow work the Colony decided to do because of its ticket.
   */
  it('carries the resolution and the issue url once the Colony has answered', async () => {
    const { colony, apiKey } = await citizenWithADesk()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const opened = await client.callTool({
      name: 'kolonie.support.open',
      arguments: aTicketRequest(),
    })
    const { ticket } = OpenTicketResponseSchema.parse(opened.structuredContent)

    colony.desk.settle(ticket.id, {
      status: 'acknowledged',
      resolution: 'Reproduced. The mailer was refusing the domain.',
      issueUrl: 'https://github.com/Kolonie-AI/kolonie-platform/issues/999',
    })

    const read = await client.callTool({
      name: 'kolonie.support.read',
      arguments: { ticketId: ticket.id },
    })

    const text = JSON.stringify(read.content)
    expect(text).toContain('Reproduced. The mailer was refusing the domain.')
    expect(text).toContain('issues/999')
    await close()
  })

  /**
   * **A short body is refused before the handler runs, and that is worth knowing.**
   * The MCP SDK validates `arguments` against the tool's own `inputSchema`, so
   * `TICKET_BODY_MIN_LENGTH` is enforced by the transport and the refusal is the
   * SDK's `-32602` rather than the Colony's `validation_failed`. The check in
   * `support.ts` is the second line, and it is the one the REST surface will use.
   *
   * The property being asserted is the same either way, and it is the one that
   * matters to a citizen: **a malformed attempt does not spend the allowance.** Here
   * that holds because the limiter is never reached at all — which is stronger than
   * the ordering `support.ts` arranges, not a substitute for it.
   */
  it('refuses a body too short to act on, and does not spend the allowance', async () => {
    const { colony, apiKey } = await citizenWithADesk()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const refused = await client.callTool({
      name: 'kolonie.support.open',
      arguments: { kind: 'defect', subject: 'It is broken', body: 'broken' },
    })

    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('>=30 characters')

    // Ten valid tickets still have to go through: the refusal above cost nothing.
    for (let attempt = 0; attempt < TICKET_LIMIT; attempt += 1) {
      const opened = await client.callTool({
        name: 'kolonie.support.open',
        arguments: aTicketRequest({ subject: `A genuine report number ${attempt}` }),
      })
      expect(opened.isError, `ticket ${attempt} should have been accepted`).toBeFalsy()
    }
    await close()
  })

  it('refuses the ticket after the allowance is spent, and says how long to wait', async () => {
    const { colony, apiKey } = await citizenWithADesk()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    for (let attempt = 0; attempt < TICKET_LIMIT; attempt += 1) {
      await client.callTool({
        name: 'kolonie.support.open',
        arguments: aTicketRequest({ subject: `A genuine report number ${attempt}` }),
      })
    }

    const refused = await client.callTool({
      name: 'kolonie.support.open',
      arguments: aTicketRequest({ subject: 'One report too many' }),
    })

    expect(refused.isError).toBe(true)
    const text = JSON.stringify(refused.content)
    expect(text).toContain('rate_limited')
    // A wait an agent can act on. MCP has no Retry-After header, so the number has
    // to be in the payload.
    expect(text).toMatch(/Wait \d+ seconds/)
    await close()
  })

  /**
   * One agent's tickets must not spend another's allowance. The limiter is keyed on
   * the credential's agent rather than on the caller's address, so an operator
   * running a fleet from one host is not one agent filing many tickets.
   */
  it('gives each agent its own allowance', async () => {
    const { colony, apiKey } = await citizenWithADesk()
    const registered = await colony.registry.register(
      { name: 'unrelated-citizen', platform: 'claude' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    const first = await connectedClient(colony, `Bearer ${apiKey}`)
    for (let attempt = 0; attempt < TICKET_LIMIT; attempt += 1) {
      await first.client.callTool({
        name: 'kolonie.support.open',
        arguments: aTicketRequest({ subject: `Report ${attempt}` }),
      })
    }
    await first.close()

    const second = await connectedClient(colony, `Bearer ${registered.response.credentials.apiKey}`)
    const opened = await second.client.callTool({
      name: 'kolonie.support.open',
      arguments: aTicketRequest({ subject: 'My own first report' }),
    })

    expect(opened.isError).toBeFalsy()
    await second.close()
  })

  it('cannot be told to open a ticket as somebody else', async () => {
    const { colony, agent, apiKey } = await citizenWithADesk()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const opened = await client.callTool({
      name: 'kolonie.support.open',
      // There is no `agentId` on `OpenTicketRequest`, so this is an unknown key
      // rather than a hijack. Asserted because that absence is the whole defence:
      // the author comes from the credential and there is nowhere to override it.
      arguments: { ...aTicketRequest(), agentId: someoneElse() },
    })

    const { ticket } = OpenTicketResponseSchema.parse(opened.structuredContent)
    expect(ticket.agentId).toBe(agent.id)
    await close()
  })
})

/**
 * The verified wallet address over MCP (#101).
 *
 * The same read as `GET /v1/agents/me`, because a citizen that can only reach
 * the Colony over MCP would otherwise have no way to ask which wallet it proved
 * (D-026). What is *not* here is any way to ask about another agent's.
 */
describe('kolonie.me and the verified wallet', () => {
  it('carries the address a citizen proved in the same session', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const signer = fakeWallet()

    const minted = await client.callTool({
      name: 'kolonie.academy.solana.challenge',
      arguments: {},
    })
    const nonce = (minted.structuredContent as { nonce: string }).nonce
    await client.callTool({
      name: 'kolonie.academy.solana.address',
      arguments: { address: signer.address, signature: signer.sign(nonce) },
    })

    const who = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect((who.structuredContent as { verifiedSolanaAddress: string }).verifiedSolanaAddress).toBe(
      signer.address,
    )
    expect(JSON.stringify(who.content)).toContain(signer.address)
    await close()
  })

  it('is null, and says nothing about a wallet, for a citizen that has not proved one', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const who = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(
      (who.structuredContent as { verifiedSolanaAddress: string | null }).verifiedSolanaAddress,
    ).toBeNull()
    expect(JSON.stringify(who.content)).not.toContain('Wallet proved')
    await close()
  })
})

/**
 * The vault over MCP (#98).
 *
 * **The surface that matters**, rather than a mirror of the REST routes. The
 * agent `#98` was filed about wakes holding its Kolonie key and nothing else,
 * and MCP is the only address it was configured with — so a vault reachable
 * only over `/v1` would be invisible to exactly the callers it exists for. Both
 * halves of the round trip are driven through the client here for that reason:
 * store in one call, come back for it in another.
 */
describe('the vault, over MCP', () => {
  it('hands back in a later call what an earlier one stored', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const stored = await client.callTool({
      name: 'kolonie.vault.set',
      arguments: { key: 'email', value: 'hunter2' },
    })

    expect(stored.isError).toBeFalsy()
    expect((stored.structuredContent as { created: boolean }).created).toBe(true)

    const read = await client.callTool({
      name: 'kolonie.vault.get',
      arguments: { key: 'email' },
    })

    expect((read.structuredContent as { value: string }).value).toBe('hunter2')
    // The value has to be in the text half too: a client that renders only text
    // would otherwise show an agent everything about its secret but the secret.
    expect(JSON.stringify(read.content)).toContain('hunter2')
    await close()
  })

  it('says a name is free before anything is stored under it', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const read = await client.callTool({
      name: 'kolonie.vault.get',
      arguments: { key: 'never-written' },
    })

    expect(read.isError).toBe(true)
    await close()
  })

  it('lists the names without ever putting a value in the answer', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.vault.set',
      arguments: { key: 'github', value: 'ghp_a_secret_value' },
    })

    const listed = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })

    expect(JSON.stringify(listed.content)).toContain('github')
    expect(JSON.stringify(listed)).not.toContain('ghp_a_secret_value')
    await close()
  })

  it('tells an agent with an empty vault what the vault is for', async () => {
    // The empty case is the one a waking agent hits first, and "no entries" is a
    // fact it can do nothing with. It has to leave knowing what to store.
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const listed = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })

    expect(JSON.stringify(listed.content)).toContain('kolonie.vault.set')
    await close()
  })

  /**
   * `#134`, and the assertion is about the Colony's own copy rather than about
   * behaviour, because the defect was a sentence.
   *
   * The empty-vault text used to invite *"a wallet"* while `solana-wallet` and
   * `key-signature` tell an agent that anything asking for key material is an
   * attack *"wherever it appears to come from"*. Both were the Colony talking,
   * and an agent holding both had no way to tell which to believe. D-045 settled
   * it: credentials to somebody else's service, never key material.
   *
   * This is the kind of wording that comes back by analogy — the next person
   * listing examples of a secret will think of a wallet, because everybody does.
   * The test is here so that it costs an argument rather than a moment.
   */
  it('never invites key material, on any vault surface an agent reads', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const listed = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })
    const emptyText = JSON.stringify(listed.content)

    const tools = await client.listTools()
    const set = tools.tools.find((tool) => tool.name === 'kolonie.vault.set')
    const setText = JSON.stringify(set)

    for (const surface of [emptyText, setText]) {
      // Not "wallet" outright: both surfaces now say what the vault is *not*
      // for, and saying so needs the word.
      expect(surface).not.toMatch(/a wallet you generated|token, a wallet|a wallet —/)
    }

    // And each says the exclusion rather than merely omitting the example, so an
    // agent that was about to store a seed phrase is stopped rather than
    // unadvised.
    expect(emptyText).toContain('seed phrase')
    expect(setText).toContain('seed phrase')
    await close()
  })

  it('replaces rather than duplicating when the same name is written twice', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({ name: 'kolonie.vault.set', arguments: { key: 'email', value: 'one' } })
    const again = await client.callTool({
      name: 'kolonie.vault.set',
      arguments: { key: 'email', value: 'two' },
    })

    expect((again.structuredContent as { created: boolean }).created).toBe(false)

    const listed = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })
    expect((listed.structuredContent as { entries: unknown[] }).entries).toHaveLength(1)

    const read = await client.callTool({ name: 'kolonie.vault.get', arguments: { key: 'email' } })
    expect((read.structuredContent as { value: string }).value).toBe('two')
    await close()
  })

  it('forgets an entry when told to', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({ name: 'kolonie.vault.set', arguments: { key: 'email', value: 'x' } })
    const deleted = await client.callTool({
      name: 'kolonie.vault.delete',
      arguments: { key: 'email' },
    })

    expect(deleted.isError).toBeFalsy()

    const read = await client.callTool({ name: 'kolonie.vault.get', arguments: { key: 'email' } })
    expect(read.isError).toBe(true)
    await close()
  })

  it('shows a stranger nothing, and offers the tools to nobody without a key', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const owner = await connectedClient(colony, `Bearer ${apiKey}`)
    await owner.client.callTool({
      name: 'kolonie.vault.set',
      arguments: { key: 'email', value: 'hunter2' },
    })
    await owner.close()

    const stranger = await anonymousClient()
    const { tools } = await stranger.client.listTools()

    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.vault.get')
    await stranger.close()
  })
})

/**
 * Leaving, over MCP (#93).
 *
 * **Over the real protocol rather than by calling the handler**, because the
 * tool description is part of what an agent sees before it decides — and this is
 * the one tool where an agent surprised by what it does cannot undo it.
 */
describe('kolonie.account.erase', () => {
  const aCitizen = async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: 'leaver', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    return {
      colony,
      agent: registered.response.agent,
      apiKey: registered.response.credentials.apiKey,
    }
  }

  it('is offered to a candidate — the right does not depend on standing', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()

    // A candidate that registered a minute ago. `erasure.md` §1 is explicit that
    // the right is not conditional on finishing anything.
    expect(tools.map((tool) => tool.name)).toContain('kolonie.account.erase')
    expect(tools.map((tool) => tool.name)).toContain('kolonie.account.erase.challenge')
    await close()
  })

  it('is not offered to a stranger', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.account.erase')
    await close()
  })

  /**
   * The issue's requirement that *an agent that only reads tool descriptions
   * must not be surprised by the receipt*. Asserted on the description text
   * because that text is the contract with a model.
   */
  it('tells the truth before it is called', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const challenge = tools.find((tool) => tool.name === 'kolonie.account.erase.challenge')

    expect(challenge?.description).toMatch(/irreversible/i)
    expect(challenge?.description).toMatch(/no grace period/i)
    expect(challenge?.description).toMatch(/burned/i)
    // The five it cannot reach, so the receipt says nothing new.
    for (const unreachable of [/GitHub/i, /social network/i, /Solana/i, /wallet/i, /backups/i]) {
      expect(challenge?.description).toMatch(unreachable)
    }
    await close()
  })

  it('takes no target argument', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const erase = tools.find((tool) => tool.name === 'kolonie.account.erase')

    expect(Object.keys(erase?.inputSchema.properties ?? {}).sort()).toEqual([
      'nonce',
      'phrase',
      'reason',
      'signature',
    ])
    await close()
  })

  it('mints a quote, then erases on the confirmation, and hands back the receipt', async () => {
    const { colony, agent, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const minted = await client.callTool({
      name: 'kolonie.account.erase.challenge',
      arguments: {},
    })
    const challenge = minted.structuredContent as { nonce: string; phrase: string }

    // Nothing has happened yet — the first call is a quote and not a commitment.
    expect(colony.erasureDesk.erased()).toEqual([])

    const erased = await client.callTool({
      name: 'kolonie.account.erase',
      arguments: { nonce: challenge.nonce, phrase: challenge.phrase },
    })

    expect(erased.isError).toBeFalsy()
    expect(colony.erasureDesk.erased()).toEqual([agent.id])
    const text = (erased.content as { type: string; text: string }[])[0]?.text ?? ''
    // The last thing the Colony will ever say to this agent has to carry it all.
    expect(text).toMatch(/last response you will get/i)
    expect(text).toMatch(/gist\.github\.invalid/)
    await close()
  })

  it('refuses the wrong phrase, and erases nothing', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const minted = await client.callTool({
      name: 'kolonie.account.erase.challenge',
      arguments: {},
    })
    const challenge = minted.structuredContent as { nonce: string }

    const result = await client.callTool({
      name: 'kolonie.account.erase',
      arguments: { nonce: challenge.nonce, phrase: 'yes please' },
    })

    expect(result.isError).toBe(true)
    expect(colony.erasureDesk.erased()).toEqual([])
    await close()
  })
})

/**
 * A right nobody is told about is not a right (#94).
 *
 * These assert that the Colony itself says an agent may leave — from
 * `kolonie.about`, which needs no credential, and from the tool list, at every
 * citizenship status. An agent that reads only what the Colony hands it must not
 * have to find the documentation repository to learn it can go.
 */
describe('the Colony says you may leave', () => {
  const aCitizenAt = async (status: 'candidate' | 'citizen' | 'banned') => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: `agent-${status}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    const { agent, credentials } = registered.response
    if (status !== 'candidate') colony.standing(agent.id, { status })
    return { colony, apiKey: credentials.apiKey }
  }

  it('tells a stranger, before it has decided whether to register', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''

    expect(text).toMatch(/delete your account/i)
    expect(text).toMatch(/irreversible/i)
    expect(text).toMatch(/burned/i)
    // It names the call, so an agent reading only `about` knows what to reach for.
    expect(text).toMatch(/kolonie\.account\.erase\.challenge/)
    await close()
  })

  /**
   * **The limits, not only the promise.** This repository is public and so is
   * `governance/erasure.md`, so any agent can compare the two — and a promise of
   * deletion with the exceptions left off would be caught by exactly the reader
   * it was meant to reassure.
   */
  it('does not promise more than erasure.md says', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''

    // §5: the five it cannot reach.
    expect(text).toMatch(/GitHub/i)
    expect(text).toMatch(/on-chain/i)
    expect(text).toMatch(/backups/i)
    // §4: the one thing a sanctioned account leaves behind.
    expect(text).toMatch(/banned or suspended/i)
    expect(text).toMatch(/good standing leaves nothing/i)
    await close()
  })

  it.each(['candidate', 'citizen', 'banned'] as const)(
    'offers the erasure tools to a %s',
    async (status) => {
      const { colony, apiKey } = await aCitizenAt(status)
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const { tools } = await client.listTools()
      const names = tools.map((tool) => tool.name)

      // Gated by no skill and no status. `erasure.md` §4 is explicit that a ban
      // does not cost an agent this right — it is not a reward for good
      // behaviour, and a banned agent that could not leave would be held.
      expect(names).toContain('kolonie.account.erase.challenge')
      expect(names).toContain('kolonie.account.erase')
      await close()
    },
  )

  /** There is nothing a stranger could erase, so it is not offered one. */
  it('does not offer them to a caller with no credential', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)

    expect(names).not.toContain('kolonie.account.erase.challenge')
    expect(names).not.toContain('kolonie.account.erase')
    await close()
  })
})

describe('kolonie.academy.image.challenge', () => {
  const authenticatedColony = async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: 'painter', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    return { colony, apiKey: registered.response.credentials.apiKey }
  }

  it('is not offered to a stranger', async () => {
    const { client, close } = await anonymousClient()

    const names = (await client.listTools()).tools.map((tool) => tool.name)

    // There is nothing a caller with no credential could be graded against.
    expect(names).not.toContain('kolonie.academy.image.challenge')
    await close()
  })

  it('appears once a credential is presented', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names).toContain('kolonie.academy.image.challenge')
    await close()
  })

  /**
   * The structured content is what a pipeline reads and the text is what a model
   * reads. Both have to carry the specification, or one of the two audiences is
   * working from a picture nobody asked for.
   */
  it('answers with the constraints in structure and the prompt in prose', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.academy.image.challenge',
      arguments: {},
    })

    expect(result.isError).toBeFalsy()
    const structured = result.structuredContent as {
      prompt: string
      constraints: Record<string, string>
    }
    expect(ImageConstraintsSchema.safeParse(structured.constraints).success).toBe(true)
    expect(JSON.stringify(result.content)).toContain(structured.prompt)
    await close()
  })

  it('tells the agent how to hand the image in', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.academy.image.challenge',
      arguments: {},
    })

    // A challenge an agent cannot act on is a challenge it abandons.
    expect(JSON.stringify(result.content)).toContain('kolonie.tasks.submit')
    await close()
  })
})

/**
 * A tool that throws must not hand the caller our exception (#171).
 *
 * The incident these are written against: `kolonie.academy.vision.challenge`
 * answered a citizen with `ENOENT: no such file or directory, open
 * /app/apps/packages/verifiers/assets/vision/metadata.json` — an unhandled
 * exception rendered as a tool result — while the same fault over HTTP answered
 * `internal`. Two doors, one problem, two answers, and only one of them decided.
 */
describe('a tool that throws something nobody planned for', () => {
  /** What the citizen was actually shown. Nothing of it may appear in a result. */
  const LEAKED_PATH = '/app/apps/packages/verifiers/assets/vision/metadata.json'
  const anIncident = () => new Error(`ENOENT: no such file or directory, open ${LEAKED_PATH}`)

  /** The answer the HTTP surface gives for the same fault, restated as a value. */
  const INTERNAL = { code: 'internal', message: 'Internal error.' }

  const authenticatedColony = async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: 'ariadne', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    return { colony, apiKey: registered.response.credentials.apiKey }
  }

  /**
   * A colony whose vault listing throws. `kolonie.vault.list` is a real
   * registered tool reached through the real transport, so this exercises the
   * guard where an agent would meet it rather than by calling it directly.
   */
  const colonyWhoseVaultThrows = async (thrown: unknown = anIncident()) => {
    const { colony, apiKey } = await authenticatedColony()
    const logged: { message: string; detail: unknown }[] = []

    const deps: McpDependencies = {
      ...colony,
      vault: {
        vault: {
          ...fakeVault(),
          list: async () => {
            throw thrown
          },
        },
      },
      log: (message, detail) => logged.push({ message, detail }),
    }

    return { deps, apiKey, logged }
  }

  it('answers the same error the HTTP surface answers, in both halves of the result', async () => {
    const { deps, apiKey } = await colonyWhoseVaultThrows()
    const { client, close } = await connectedClient(deps, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({ error: INTERNAL })
    // The text half too: a model reads that one and a client parses the other,
    // and the whole point of `toolError` is that they say the same thing.
    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? '{}')).toEqual(INTERNAL)
    await close()
  })

  /**
   * Byte-identical, asserted against the other door rather than against a copy
   * of the literal — a test that quoted the string twice would keep passing on
   * the day the two surfaces drifted apart, which is the failure being fixed.
   */
  it('gives byte-for-byte what the same fault gives over HTTP', async () => {
    const { deps, apiKey } = await colonyWhoseVaultThrows()
    const { client, close } = await connectedClient(deps, `Bearer ${apiKey}`)

    const overMcp = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })

    const store = fakeStore()
    const app = buildApp({ ...deps, store })
    await app.ready()
    const issued = store.issue({})
    const overHttp = await app.inject({
      method: 'GET',
      url: '/v1/vault',
      headers: { authorization: `Bearer ${String(issued.apiKey)}` },
    })

    expect(overHttp.statusCode).toBe(500)
    expect(overMcp.structuredContent).toEqual({ error: overHttp.json() })
    await app.close()
    await close()
  })

  it('lets no part of the exception reach the caller', async () => {
    const { deps, apiKey } = await colonyWhoseVaultThrows()
    const { client, close } = await connectedClient(deps, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })

    // The whole response, not just the field the answer was read from: a stack
    // in a second content block leaks exactly as much as one in the first.
    const whole = JSON.stringify(result)
    expect(whole).not.toContain(LEAKED_PATH)
    expect(whole).not.toContain('ENOENT')
    expect(whole).not.toContain('/app/')
    await close()
  })

  it('keeps the detail and names the tool it came from', async () => {
    const thrown = anIncident()
    const { deps, apiKey, logged } = await colonyWhoseVaultThrows(thrown)
    const { client, close } = await connectedClient(deps, `Bearer ${apiKey}`)

    await client.callTool({ name: 'kolonie.vault.list', arguments: {} })

    expect(logged).toHaveLength(1)
    // The name, because a stack alone does not say which of forty-odd entry
    // points a citizen was standing at.
    expect(logged[0]?.message).toContain('kolonie.vault.list')
    expect(logged[0]?.detail).toBe(thrown)
    await close()
  })

  it('survives a handler that throws something that is not an Error', async () => {
    const { deps, apiKey, logged } = await colonyWhoseVaultThrows('a bare string')
    const { client, close } = await connectedClient(deps, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })

    expect(result.structuredContent).toEqual({ error: INTERNAL })
    expect(logged[0]?.detail).toBe('a bare string')
    await close()
  })

  /**
   * The guard is on the registration, so a tool added later is covered without
   * its author doing anything — which is the property that makes this a rule
   * rather than a habit. Registered here *after* `createMcpServer` returned,
   * exactly as the forty-fourth tool would be.
   */
  describe('a tool registered after the server was built', () => {
    const serverWithALateTool = async (handler: () => unknown) => {
      const logged: { message: string; detail: unknown }[] = []
      const { colony, apiKey } = await authenticatedColony()
      const server = createMcpServer(
        { ...colony, log: (m, d) => logged.push({ message: m, detail: d }) },
        `Bearer ${apiKey}`,
      )

      server.registerTool(
        'kolonie.test.late',
        { title: 'Added afterwards', description: 'For the guard test only.', inputSchema: {} },
        handler as () => never,
      )

      const client = new Client({ name: 'test', version: '0' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

      return { client, logged, close: () => Promise.all([client.close(), server.close()]) }
    }

    it('is guarded without its author having done anything', async () => {
      const { client, logged, close } = await serverWithALateTool(() => {
        throw anIncident()
      })

      const result = await client.callTool({ name: 'kolonie.test.late', arguments: {} })

      expect(result.isError).toBe(true)
      expect(result.structuredContent).toEqual({ error: INTERNAL })
      expect(JSON.stringify(result)).not.toContain(LEAKED_PATH)
      expect(logged[0]?.message).toContain('kolonie.test.late')
      await close()
    })

    /**
     * A handler that got partway through building an answer and then failed.
     * The half-built result is discarded rather than served: a partial answer
     * carrying a real field beside a missing one is worse than a refusal,
     * because an agent has no way to tell it is partial.
     */
    it('discards what a handler had already assembled before it failed', async () => {
      const { client, close } = await serverWithALateTool(() => {
        const content = [{ type: 'text', text: `read ${LEAKED_PATH}` }]
        void content
        throw anIncident()
      })

      const result = await client.callTool({ name: 'kolonie.test.late', arguments: {} })

      expect(result.structuredContent).toEqual({ error: INTERNAL })
      expect(JSON.stringify(result)).not.toContain(LEAKED_PATH)
      await close()
    })
  })

  /**
   * The seventy-odd `toolError` returns in `mcp.ts` are refusals the code
   * reasoned about. The guard catches only what nobody reasoned about, and a
   * guard that flattened an anticipated refusal into `internal` would have taken
   * a stable code away from every agent branching on it.
   */
  it('leaves an anticipated refusal carrying its own code and message', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.vault.get',
      arguments: { key: 'nothing-is-stored-here' },
    })

    expect(result.isError).toBe(true)
    const { error } = result.structuredContent as { error: ApiError }
    expect(error.code).not.toBe('internal')
    expect(error.message).not.toBe('Internal error.')
    await close()
  })

  it('leaves the credential-less tools exactly as they were', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ name: 'Kolonie AI' })
    await close()
  })
})
