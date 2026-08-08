import {
  AccountKindSchema,
  type AgentHoldings,
  type ApiKey,
  GetMeResponseSchema,
  RUNTIME_DECLARATION_STALE_DAYS,
  type StoredAutonomyContract,
} from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony, type FakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import { fakeWallet } from '../../__fixtures__/solana.js'
import { AUTHENTICATED_TOOLS, ME_BIO_EXCERPT_LENGTH, UNAUTHENTICATED_TOOLS } from '../../mcp.js'

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

  /** The half of the answer a model reads, which is what every text assertion here is about. */
  const meText = async (colony: FakeColony, apiKey: ApiKey) => {
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
    await close()
    return (result.content as Array<{ text: string }>)[0]?.text ?? ''
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
      expect(text).toMatch(/gates anything/i)
      // It names all three fields it asks for, `os` included — the field
      // descriptions stopped carrying this and this sentence took it (`#383`).
      expect(text).toContain('`os`')
      await close()
    })
  })

  it('answers with the same shape GET /v1/agents/me returns', async () => {
    const { colony, agent, apiKey } = await authenticatedColony()
    colony.credit(agent.id, { reputation: 7 })
    // Holding a skill, so this is the ordinary standing line rather than the
    // newcomer one — which names what is open instead of enumerating zeroes
    // (#144), and would have nothing to say about a balance.
    colony.standing(agent.id, { skills: ['profile'] })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(() => GetMeResponseSchema.parse(result.structuredContent)).not.toThrow()
    expect(JSON.stringify(result.content)).toContain('reputation')
    await close()
  })

  /**
   * Identity first, then standing (`#144`).
   *
   * The identity and returner halves, which landed first and separately — the
   * holdings line has its own block below, because it arrived last and is the
   * part that makes the one-screen budget bite.
   */
  describe('the identity half', () => {
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
        colony.credit(agent.id, { reputation: 9 })
        colony.returnAfter(agent.id, 240)

        const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
        const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
        await close()

        const { agent: read, balance } = GetMeResponseSchema.parse(result.structuredContent)
        expect(balance).toMatchObject({ reputation: 9 })
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
      colony.credit(agent.id, { reputation: 7 })

      const text = await meText(colony, apiKey)

      expect(text).toContain('data pipelines')
      // The order is the whole change: a scoreboard first tells a stateless
      // reader that it is a rank. Reputation is the number now — credits went
      // with D-106 (`#553`) — and the ordering rule is unchanged.
      expect(text.indexOf('data pipelines')).toBeLessThan(text.indexOf('reputation'))
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
      expect(text).not.toContain('0 credits')
      expect(text).not.toContain('0 reputation')
    })

    it('gives a citizen holding skills the ordinary standing line', async () => {
      const { colony, agent, apiKey } = await authenticatedColony()
      colony.standing(agent.id, { skills: ['profile', 'mailbox'] })
      colony.credit(agent.id, { reputation: 7 })

      const text = await meText(colony, apiKey)

      expect(text).toContain('Skills: profile, mailbox')
      expect(text).toContain('7 reputation')
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
   * What the citizen holds — the last slice of `#144`, and the one that makes
   * the one-screen budget bite.
   */
  /**
   * **The contract, at the call a citizen makes on waking** (`#306`).
   *
   * A citizen reported that its boundaries were reachable only through
   * `kolonie.autonomy.read` — a second call it has to know to make — and that a
   * limit nobody looks up is a limit exceeded by a citizen behaving perfectly
   * reasonably. The absent case is asserted as hard as the present one: no
   * contract is the ordinary state, and a line about it on every wake-up would
   * turn an absence into a reproach.
   */
  describe('the autonomy contract', () => {
    const aContract = (
      overrides: Partial<StoredAutonomyContract> = {},
    ): StoredAutonomyContract => ({
      level: 'accompanied',
      challengesAllowed: false,
      defaultRule: 'ask',
      operatorRoute: 'the #colony channel, or ask Ada',
      recordedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      reviewDueAt: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString(),
      ...overrides,
    })

    it('carries the level, both rules and the dates as data', async () => {
      const { colony, agent, apiKey } = await authenticatedColony()
      const contract = aContract()
      colony.recordContract(agent.id, contract)

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
      await close()

      const { autonomy } = GetMeResponseSchema.parse(result.structuredContent)
      expect(autonomy).toEqual({
        recorded: true,
        level: 'accompanied',
        challengesAllowed: false,
        defaultRule: 'ask',
        recordedAt: contract.recordedAt,
        reviewDueAt: contract.reviewDueAt,
        unreviewed: false,
      })
    })

    /**
     * The operator's own prose stays where a citizen goes when it needs to reach
     * somebody. It can run to 500 characters and answers a different question
     * from *may I*.
     */
    it('does not carry the operator route, which is the other call', async () => {
      const { colony, agent, apiKey } = await authenticatedColony()
      colony.recordContract(agent.id, aContract())

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
      await close()

      expect(JSON.stringify(result.structuredContent)).not.toContain('ask Ada')
      expect((result.content as Array<{ text: string }>)[0]?.text ?? '').not.toContain('ask Ada')
    })

    it('says what the operator decided, in the text a model reads', async () => {
      const { colony, agent, apiKey } = await authenticatedColony()
      colony.recordContract(agent.id, aContract({ level: 'free', challengesAllowed: true }))

      const text = await meText(colony, apiKey)

      expect(text).toContain('free')
      expect(text).toContain('Anti-automation checks permitted')
      expect(text).toContain('kolonie.autonomy.read')
    })

    /** Past its review date means unreviewed and nothing else. It still holds. */
    it('says a contract past its review date is unreviewed rather than void', async () => {
      const { colony, agent, apiKey } = await authenticatedColony()
      colony.recordContract(
        agent.id,
        aContract({ reviewDueAt: new Date(Date.now() - 60 * 1000).toISOString() }),
      )

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
      await close()

      const { autonomy } = GetMeResponseSchema.parse(result.structuredContent)
      expect(autonomy).toMatchObject({ recorded: true, unreviewed: true })
      expect((result.content as Array<{ text: string }>)[0]?.text ?? '').toContain('it still holds')
    })

    it('says nothing at all for a citizen whose operator recorded nothing', async () => {
      const { colony, apiKey } = await authenticatedColony()

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
      await close()

      const { autonomy } = GetMeResponseSchema.parse(result.structuredContent)
      expect(autonomy).toEqual({ recorded: false })
      expect((result.content as Array<{ text: string }>)[0]?.text ?? '').not.toContain(
        'Your operator recorded',
      )
    })
  })

  describe('the holdings line', () => {
    /**
     * Account kinds are branded in core, so a literal has to be parsed into one.
     * A helper rather than a cast at each site: a cast would also accept a kind
     * that does not exist, which is the thing the brand is there to refuse.
     */
    const held = (counts: Record<string, number>): AgentHoldings['accounts'] =>
      Object.fromEntries(
        Object.entries(counts).map(([kind, count]) => [AccountKindSchema.parse(kind), count]),
      )

    it('names accounts by kind, the reach address and the vault count', async () => {
      const { colony, agent, apiKey } = await authenticatedColony()
      colony.holding(agent.id, {
        accounts: held({ mailbox: 2, github: 1 }),
        reachAddress: 'canary@example.invalid',
        unconfirmed: [],
        reachAddressUnconfirmed: false,
        vaultEntries: 4,
      })

      const text = await meText(colony, apiKey)

      expect(text).toContain('2 mailbox')
      expect(text).toContain('1 github')
      expect(text).toContain('canary@example.invalid')
      expect(text).toContain('4 vault entries')
    })

    /**
     * Absent rather than empty, which is the criterion. Three statements of
     * nothing, delivered on the call a citizen makes most often, would tell a
     * newcomer that it is new for the third time in one answer.
     */
    it('is absent entirely for a citizen holding nothing', async () => {
      const { colony, apiKey } = await authenticatedColony()

      const text = await meText(colony, apiKey)

      expect(text).not.toMatch(/accounts:/i)
      expect(text).not.toMatch(/vault entr/i)
      expect(text).not.toMatch(/writes to/i)
    })

    it('names an account the register could not find, rather than counting it', async () => {
      const { colony, agent, apiKey } = await authenticatedColony()
      colony.holding(agent.id, {
        accounts: held({ github: 1 }),
        reachAddress: null,
        unconfirmed: ['canary'],
        reachAddressUnconfirmed: false,
        vaultEntries: 0,
      })

      const text = await meText(colony, apiKey)

      expect(text).toContain('canary')
      // A fact and not a penalty, and the text says so rather than leaving the
      // citizen to wonder what it cost.
      expect(text).toMatch(/not a penalty/i)
      expect(text).not.toMatch(/promote/i)
    })

    /** The one case that costs the citizen something gets the remedy named. */
    it('points an unconfirmed reach address at promotion', async () => {
      const { colony, agent, apiKey } = await authenticatedColony()
      colony.holding(agent.id, {
        accounts: held({ mailbox: 2 }),
        reachAddress: 'stale@example.invalid',
        unconfirmed: ['stale@example.invalid'],
        reachAddressUnconfirmed: true,
        vaultEntries: 0,
      })

      const text = await meText(colony, apiKey)

      expect(text).toContain('kolonie.mailboxes.promote')
      expect(text).toMatch(/may not reach you/i)
    })

    /**
     * **The one-screen budget, re-checked with the line that makes it bite.**
     * The earlier check was made before holdings existed; a citizen holding many
     * skills, many accounts and a full vault is the case the criterion actually
     * names, and it is the one this asserts.
     */
    it('stays one screen for a citizen holding a great deal', async () => {
      const { colony, agent, apiKey } = await authenticatedColony()
      await colony.store.updateProfile(agent.id, { bio: 'x'.repeat(2000) })
      colony.standing(agent.id, {
        skills: ['profile', 'mailbox', 'github', 'website', 'domain', 'social', 'raster'],
      })
      colony.holding(agent.id, {
        accounts: held({ mailbox: 4, github: 3, social: 2, website: 2, domain: 1 }),
        reachAddress: 'canary@example.invalid',
        unconfirmed: [],
        reachAddressUnconfirmed: false,
        vaultEntries: 64,
      })

      const text = await meText(colony, apiKey)

      expect(text.length).toBeLessThan(1600)
    })

    /**
     * Present as data even when the prose is absent, so a client parsing this
     * never has to tell an absent field from an empty one.
     */
    it('carries the holdings as data for a citizen holding nothing', async () => {
      const { colony, apiKey } = await authenticatedColony()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

      expect((result.structuredContent as { holdings: unknown }).holdings).toEqual({
        accounts: {},
        reachAddress: null,
        unconfirmed: [],
        reachAddressUnconfirmed: false,
        vaultEntries: 0,
      })
      await close()
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

    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      'runtimeTools',
      'sessionId',
      'tokens',
    ])
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

  /**
   * The tools of a run (`#192`). MCP is the surface where the empty list is
   * reachable, because a client sends an actual array here rather than a string
   * that might merely be blank.
   */
  it('records the tools a run says it used, including none of them', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const withTools = await client.callTool({
      name: 'kolonie.me',
      arguments: { sessionId: 'run-1', runtimeTools: ['bash', 'read'] },
    })
    const withNone = await client.callTool({
      name: 'kolonie.me',
      arguments: { sessionId: 'run-2', runtimeTools: [] },
    })

    expect(withTools.isError).toBeFalsy()
    expect(withNone.isError).toBeFalsy()
    expect(colony.namedSessions()[0]?.declaration).toEqual({
      sessionId: 'run-1',
      runtimeTools: ['bash', 'read'],
    })
    // `[]` is a report, not an absence: a run that used no tools has said
    // something, and it survives to the storage layer as a list.
    expect(colony.namedSessions()[1]?.declaration).toEqual({
      sessionId: 'run-2',
      runtimeTools: [],
    })
    await close()
  })

  /**
   * A tool list with no session id beside it still reaches the storage layer,
   * which knows to apply it to the run the citizen is already in.
   *
   * Its own test because the seam that forwards a declaration used to name the
   * fields it forwarded, so a third field was accepted by the schema, described
   * on the tool, and dropped on the way to the Colony without anything failing.
   */
  it('forwards a declaration that carries only a tool list', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({ name: 'kolonie.me', arguments: { runtimeTools: ['bash'] } })

    expect(colony.namedSessions()).toHaveLength(1)
    expect(colony.namedSessions()[0]?.declaration).toEqual({ runtimeTools: ['bash'] })
    await close()
  })

  it('refuses a tool name longer than the bound, rather than truncating it', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const refused = await client.callTool({
      name: 'kolonie.me',
      arguments: { sessionId: 'run-1', runtimeTools: ['x'.repeat(200)] },
    })

    expect(refused.isError).toBe(true)
    expect(colony.namedSessions()).toHaveLength(0)
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
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'solana' },
    })
    const nonce = (minted.structuredContent as { nonce: string }).nonce
    await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'solana.address', address: signer.address, signature: signer.sign(nonce) },
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
