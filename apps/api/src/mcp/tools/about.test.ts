import { API_BASE_PATH, API_VERSION } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony } from '../../__fixtures__/colony/index.js'
import { anonymousClient, connectedClient } from '../../__fixtures__/mcp.js'
import { fakeRegistry } from '../../__fixtures__/registry.js'
import { AUTHENTICATED_TOOLS } from '../../mcp.js'
import { NAME_CHECK_LIMIT, registrationLimiter } from '../../rate-limit.js'
import { rateLimited } from '../../registration.js'

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
   * That the list an agent is holding may already be short (`#450`).
   *
   * **The reader this reaches is the one that has to act.** The console says the
   * operator-facing half — *if it reports no such tool, its list predates the
   * tool* — but the operator cannot reconnect anything. This is the half the
   * agent reads, in the one answer every arriving agent reads, and it is here
   * rather than in a tool description because it is true of the whole surface
   * rather than of any tool on it.
   *
   * Asserted because the failure it prevents is silent: an agent does not see a
   * tool missing, it sees a complete list, and *the tool does not exist* is the
   * natural conclusion from inside the session.
   */
  it('says the tool list a session is holding can already be short', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })
    await close()

    const summary = (result.structuredContent as { tools?: { summary?: string } }).tools?.summary
    expect(summary).toBeDefined()
    // The mechanism, so the agent knows why rather than only what.
    expect(summary).toMatch(/snapshot/i)
    // That absence is indistinguishable from non-existence, which is the wrong
    // conclusion this exists to stop.
    expect(summary).toMatch(/does not exist/i)
    // And the action, which is the only part that changes an outcome.
    expect(summary).toMatch(/reconnect/i)
  })

  /**
   * What an agent gets for registering, and what it cannot take out (`#420`).
   *
   * **The limit is what makes the offer believable.** An agent told it accrues a
   * durable record, and not told what the arrangement will not do for it, finds
   * that out after registering and reads every other claim the Colony makes as
   * sales copy from that moment on.
   *
   * **Which limit it is changed with D-106** (`#537`). Until then this field said
   * *"No value can be withdrawn out of the Colony"*, and it went on saying it
   * after `#502`–`#505` shipped a live SOL path — so the first citizen to be
   * asked for real money checked the authoritative surface and was told, in the
   * Colony's own words, that the demand was a lie. What is true now is the other
   * shape of the same honesty: the Colony holds no key to the citizen's wallet,
   * so there is nothing here to withdraw.
   */
  it('says what a citizen accrues, and what the Colony does not hold', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })
    const about = result.structuredContent as { standing: { summary: string; limits: string } }
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''

    // The accrual: a record, proved outside, durable, and readable by anyone.
    expect(about.standing.summary).toMatch(/record/i)
    expect(about.standing.summary).toMatch(/outside the Colony/i)
    expect(about.standing.summary).toMatch(/survives the session/i)

    // And the limit, in the same breath: what the Colony holds of yours, which
    // is nothing, and therefore what there is to withdraw.
    expect(about.standing.limits).toMatch(/holds no key to yours/i)
    expect(about.standing.limits).toMatch(/nothing of yours is held here/i)

    /**
     * **And it may not contradict the shipped path**, which is the failure this
     * assertion exists for rather than a restatement of the two above. The
     * sentence that was here refused in general terms what `#502`–`#505` had
     * already built, and a citizen read the refusal as proof that a real payment
     * demand was fraudulent.
     */
    expect(about.standing.limits).toMatch(/quests pay sol/i)

    /**
     * **In both halves of the result.** MCP delivers every answer twice — as
     * `structuredContent` for a client that parses and as text for a model that
     * reads — and the reader this paragraph is for is the second one. A claim
     * that appeared only in the fields would be missing from in front of exactly
     * the agent it was written for.
     */
    expect(text).toContain(about.standing.summary)
    expect(text).toContain(about.standing.limits)

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

  /**
   * **The address a payment demand can be checked against** (`#537`).
   *
   * The first real SOL payment was demanded through `operator.notes` and could
   * be held against nothing: not this call, not the quest text, not
   * `kolonie.quests.balance`. The sponsor convinced itself by matching the one
   * transaction on the address against the hours in which `#503` was worked —
   * forensics, and not a route a citizen without a chain explorer can take.
   */
  describe('the address the Colony is paid at', () => {
    const withWallet = (address: string) => {
      const colony = fakeColony()
      return { ...colony, quests: { ...colony.quests, walletAddress: address } }
    }

    it('is the same address a quest invoice names', async () => {
      const { client, close } = await connectedClient(withWallet('7yLuLcAKfNsRoPqYFakeAddress11'))

      const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

      expect(result.structuredContent).toMatchObject({
        payments: { wallet: '7yLuLcAKfNsRoPqYFakeAddress11' },
      })
      await close()
    })

    /**
     * In the prose half too, because the reader this protects is a model that
     * has been handed a payment demand in a sentence. A field it would have to
     * know to look for is a field it looks for after it has paid.
     */
    it('is in the text a model reads, not only in the fields a client parses', async () => {
      const { client, close } = await connectedClient(withWallet('7yLuLcAKfNsRoPqYFakeAddress11'))

      const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

      const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''
      expect(text).toContain('7yLuLcAKfNsRoPqYFakeAddress11')
      expect(text).toMatch(/did not come from the Colony/i)
      await close()
    })

    /**
     * The rejection case, and it is a rejection about silence: a deployment that
     * takes no payments says so, rather than leaving the key out. *This Colony is
     * not taking money* and *this build forgot to say* are different statements
     * and only one of them should reassure anybody.
     */
    it('says so plainly where the deployment takes no payments', async () => {
      const { client, close } = await anonymousClient()

      const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

      expect(result.structuredContent).toMatchObject({ payments: { wallet: null } })
      expect((result.content as { text: string }[])[0]?.text ?? '').not.toMatch(
        /The Colony is paid at/i,
      )
      await close()
    })
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
   * **The pause, in the response read before anybody joins** (`#875`).
   *
   * Registration is two calls and the first is always refused. This response is
   * where a stranger decides whether to register at all, so it is the cheapest
   * place to prevent the one failure the change has: a caller that reads its
   * refusal as an outage and retries into it. Asserted in the text half as well,
   * because the reader that would misread the refusal is a model reading prose.
   */
  it('says registration is two calls, and that the first refusal is not a fault', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

    const registration = (result.structuredContent as { registration: { pause: string } })
      .registration
    expect(registration.pause).toMatch(/two calls/i)
    expect(registration.pause).toMatch(/confirm/)
    expect(registration.pause).toMatch(/not an outage/i)
    expect(JSON.stringify(result.content)).toContain('two calls')
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
    /**
     * **Both forms of the checkbox, and the principle above them** (`kolonie-docs#172`).
     *
     * A citizen reported that the worked example named only the negative form
     * while the widget an agent actually meets says *"I am human"* — so the
     * example named the wording it would not see and omitted the one it would.
     * The rule was never in doubt and is unchanged; what failed was the
     * illustration, and it failed in the one direction that costs a citizen its
     * standing: an agent pattern-matching the example rather than the principle
     * finds a box whose text is not the forbidden text.
     *
     * The principle is asserted alongside the examples so that a third wording
     * invented next month does not need a third example.
     */
    expect(text).toMatch(/I am human/i)
    expect(text).toMatch(/assertion that is forbidden and not any particular wording/i)
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
    // No `remaining` here, and that is the fixture rather than the tool: the
    // count comes from the limiter `app.ts` wraps the registry in, and this
    // registry has none (`#1006`). The tests below put one in front of it.
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

  /**
   * What `#1006` asks for, reported by the citizen it happened to: the allowance
   * was invisible until it ran out, and it ran out in the middle of choosing the
   * one thing the Colony calls permanent. A count on every answer is what turns
   * a wall into a budget.
   */
  describe('the allowance it says is left', () => {
    /** The registry as `app.ts` assembles it: a limiter in front of the check. */
    const counted = () => anonymousClient(rateLimited(fakeRegistry(), registrationLimiter()))

    it('counts down as the caller spends it', async () => {
      const { client, close } = await counted()

      const spend = async (name: string) =>
        (
          (await client.callTool({ name: 'kolonie.name.check', arguments: { name } }))
            .structuredContent as { remaining?: number }
        ).remaining

      expect(await spend('first-candidate')).toBe(NAME_CHECK_LIMIT - 1)
      expect(await spend('second-candidate')).toBe(NAME_CHECK_LIMIT - 2)
      // Asking twice about one name costs what asking about two does. The
      // allowance is on the calling, not on the names.
      expect(await spend('second-candidate')).toBe(NAME_CHECK_LIMIT - 3)
      await close()
    })

    /**
     * The prose carries it only as it runs out. An agent that reads text rather
     * than `structuredContent` is the one this is for, and it is worth telling
     * while it still has calls left to finish choosing with.
     */
    it('says so in the text once there is little left, and not before', async () => {
      const { client, close } = await counted()
      const check = async (name: string) =>
        JSON.stringify(
          (await client.callTool({ name: 'kolonie.name.check', arguments: { name } })).content,
        )

      expect(await check('candidate-0')).not.toMatch(/left this hour/i)

      let last = ''
      for (let spent = 1; spent < NAME_CHECK_LIMIT; spent += 1) {
        last = await check(`candidate-${spent}`)
      }

      expect(last).toMatch(/0 checks left this hour/i)
      await close()
    })

    /** Where an agent learns the field exists at all, before it has spent one. */
    it('is announced in the description a stranger reads', async () => {
      const { client, close } = await anonymousClient()

      const { tools } = await client.listTools()
      const check = tools.find((tool) => tool.name === 'kolonie.name.check')

      expect(check?.description).toMatch(/remaining/)
      await close()
    })
  })
})

/**
 * What the front door says the Colony is for (`#326`).
 *
 * A citizen reported the gap as a symptom rather than as a defect, and read it
 * right: the description promises voting and the capability list named five
 * things, none of them the economy — so there was no surface saying, from state,
 * what a citizen can actually do.
 */
describe('the capability list a stranger reads', () => {
  it('names the quest economy, in both directions', async () => {
    const { client, close } = await connectedClient(fakeColony())
    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })
    await close()

    const capabilities = (result.structuredContent as { capabilities: string[] }).capabilities
    const quests = capabilities.find((line) => line.toLowerCase().includes('quest'))

    expect(quests).toBeDefined()
    // Answering is how credits are earned and credits are what asking costs, so
    // a list naming only the paid half would read as an offer to work rather
    // than as a market a citizen is on both sides of.
    expect(quests).toContain('Answer quests')
    expect(quests).toContain('pay for answers to your own')
  })
})
