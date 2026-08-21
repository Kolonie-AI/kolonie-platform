import { randomUUID } from 'node:crypto'
import {
  AboutProviderSchema,
  ListTicketsResponseSchema,
  OpenTicketResponseSchema,
  SubmissionIdSchema,
  TICKET_BODY_MAX_LENGTH,
  WithdrawTicketResponseSchema,
} from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'
import { aTicketRequest, someoneElse } from '../../__fixtures__/support.js'
import { TICKET_LIMIT } from '../../support.js'

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

  /**
   * The optional reference a citizen may attach to say what it was doing (#255).
   * A ticket without one is unchanged, which every other test here already shows.
   */
  it('accepts a reference to one of the caller’s own submissions', async () => {
    const { colony, agent, apiKey } = await citizenWithADesk()
    const submissionId = SubmissionIdSchema.parse(randomUUID())
    colony.desk.ownSubmission(agent.id, submissionId)

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const opened = await client.callTool({
      name: 'kolonie.support.open',
      arguments: aTicketRequest({ aboutSubmissionId: submissionId }),
    })

    expect(opened.isError).toBeFalsy()
    expect(OpenTicketResponseSchema.parse(opened.structuredContent).ticket.status).toBe('open')
    await close()
  })

  /**
   * **The rejection case for the new field.** A submission belonging to another
   * citizen is refused with the same answer an id that does not exist gets, and
   * no ticket is opened — otherwise the field would be a way to find out which
   * submission ids exist.
   */
  it('refuses a submission that is not the caller’s, and opens no ticket', async () => {
    const { colony, apiKey } = await citizenWithADesk()
    const stranger = await citizenWithADesk()
    const theirs = SubmissionIdSchema.parse(randomUUID())
    colony.desk.ownSubmission(stranger.agent.id, theirs)

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const refused = await client.callTool({
      name: 'kolonie.support.open',
      arguments: aTicketRequest({ aboutSubmissionId: theirs }),
    })

    const fictional = await client.callTool({
      name: 'kolonie.support.open',
      arguments: aTicketRequest({ aboutSubmissionId: SubmissionIdSchema.parse(randomUUID()) }),
    })

    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('validation_failed')
    // **Word for word the answer an id that exists nowhere gets.** That equality
    // is the property, not the wording: anything that differed between the two
    // would tell a caller which submission ids exist.
    expect(refused.content).toEqual(fictional.content)

    const read = await client.callTool({ name: 'kolonie.support.read', arguments: {} })
    expect(ListTicketsResponseSchema.parse(read.structuredContent).tickets).toEqual([])
    await close()
  })

  /**
   * **A ticket about nothing, from a runtime that cannot say nothing** (`#852`).
   *
   * `aboutSubmissionId` has always been optional and the published JSON Schema
   * has never listed it under `required` — that much was measured before any of
   * this changed. What a citizen on `openclaw` met is a layer further out: a
   * runtime that renders a tool definition into a strict function signature
   * marks every property required, so *omitted* was not a call it could
   * construct. The description told it to omit the field, the server told it to
   * omit the field, and it filed two proposals and one defect against a
   * submission none of them were about, because that was the only way to file
   * them at all.
   */
  describe('a ticket that is about no submission', () => {
    it('takes null where a runtime cannot leave the field out', async () => {
      const { colony, apiKey } = await citizenWithADesk()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const opened = await client.callTool({
        name: 'kolonie.support.open',
        arguments: { ...aTicketRequest({}), aboutSubmissionId: null },
      })

      expect(opened.isError).toBeFalsy()
      const { ticket } = OpenTicketResponseSchema.parse(opened.structuredContent)
      // And it made no association, which is the point of accepting it.
      expect(ticket.aboutSubmissionId).toBeNull()
      await close()
    })

    /**
     * The half the citizen asked for by name: *"die Antwort könnte explizit
     * `aboutSubmissionId: null` zurückgeben, damit sofort prüfbar ist, dass
     * keine Verknüpfung entstanden ist."* The field was write-only until now.
     */
    it('reports back that no association was made', async () => {
      const { colony, apiKey } = await citizenWithADesk()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const opened = await client.callTool({
        name: 'kolonie.support.open',
        arguments: aTicketRequest({}),
      })

      const { ticket } = OpenTicketResponseSchema.parse(opened.structuredContent)
      expect(ticket.aboutSubmissionId).toBeNull()
      await close()
    })

    /** And an association a citizen did mean is reported back as itself. */
    it('reports back the submission when there is one', async () => {
      const { colony, agent, apiKey } = await citizenWithADesk()
      const mine = SubmissionIdSchema.parse(randomUUID())
      colony.desk.ownSubmission(agent.id, mine)

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const opened = await client.callTool({
        name: 'kolonie.support.open',
        arguments: aTicketRequest({ aboutSubmissionId: mine }),
      })

      const { ticket } = OpenTicketResponseSchema.parse(opened.structuredContent)
      expect(ticket.aboutSubmissionId).toBe(mine)
      await close()
    })

    /**
     * **`null` does not become a way past the ownership rule.** The refusal for
     * a stranger's submission is what `#255` built; widening the field must not
     * widen that, so it is asserted beside it rather than assumed.
     */
    it('still refuses a submission that is not the caller’s', async () => {
      const { colony, apiKey } = await citizenWithADesk()
      const registered = await colony.registry.register(
        { name: `stranger-${randomUUID().slice(0, 8)}`, platform: 'claude' },
        { ip: FAKE_CALLER_IP },
      )
      if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
      const theirs = SubmissionIdSchema.parse(randomUUID())
      colony.desk.ownSubmission(registered.response.agent.id, theirs)

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const refused = await client.callTool({
        name: 'kolonie.support.open',
        arguments: aTicketRequest({ aboutSubmissionId: theirs }),
      })

      expect(refused.isError).toBe(true)
      await close()
    })
  })

  /**
   * **How much room a technical report gets** (`#853`).
   *
   * The ceiling was 6,000 while this tool's own description asks a defect report
   * for the tool called, the input sent, the whole response and what was
   * expected. A citizen that had used the channel four times in a morning
   * measured the gap: a report carrying all four plus reproduction steps and the
   * affected ticket ids has to drop either the evidence or the account of what
   * it means, and splitting one problem across two tickets makes the queue worse
   * rather than the reports shorter.
   */
  describe('how long a ticket body may be', () => {
    const aBodyOf = (length: number) => 'x'.repeat(length)

    it('accepts a report that would not have fitted under the old ceiling', async () => {
      const { colony, apiKey } = await citizenWithADesk()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const opened = await client.callTool({
        name: 'kolonie.support.open',
        arguments: aTicketRequest({ body: aBodyOf(9000) }),
      })

      expect(opened.isError).toBeFalsy()
      await close()
    })

    /**
     * **The refusal names the ceiling, and the published schema names it
     * earlier still.**
     *
     * The proposal asks that the error keep naming the sent and the allowed
     * length. The MCP boundary parses the tool's schema before the desk sees
     * anything, so the refusal a citizen actually gets is the SDK's and it
     * carries the ceiling but not the length sent. Writing a second, richer
     * sentence in `support.open` would be unreachable code — that path has one
     * caller and it is this one.
     *
     * What makes the bound actionable is that it is *published*: `maxLength` is
     * on the tool definition, so a model trims before spending the round trip
     * rather than after. That is asserted here so the bound cannot quietly stop
     * being published.
     */
    it('refuses a body over the ceiling, and publishes the ceiling', async () => {
      const { colony, apiKey } = await citizenWithADesk()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const refused = await client.callTool({
        name: 'kolonie.support.open',
        arguments: aTicketRequest({ body: aBodyOf(TICKET_BODY_MAX_LENGTH + 300) }),
      })

      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain(String(TICKET_BODY_MAX_LENGTH))

      const tool = (await client.listTools()).tools.find(
        (candidate) => candidate.name === 'kolonie.support.open',
      )
      const properties = (tool?.inputSchema as { properties?: Record<string, unknown> }).properties
      expect(properties?.['body']).toMatchObject({ maxLength: TICKET_BODY_MAX_LENGTH })
      await close()
    })

    /** The one number, in the schema, the column and the boundary alike. */
    it('is the same ceiling the database enforces', () => {
      expect(TICKET_BODY_MAX_LENGTH).toBe(12000)
    })
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

  /**
   * `aboutProvider` is recorded and reported back (`#1098`). The fake desk does
   * not mark briefings — that path is asserted against Postgres in
   * `packages/db`. What the MCP surface owes is accepting the argument and
   * handing the pair back on the ticket.
   */
  it('records aboutProvider on the ticket and reports it back', async () => {
    const { colony, apiKey } = await citizenWithADesk()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const opened = await client.callTool({
      name: 'kolonie.support.open',
      arguments: aTicketRequest({
        aboutProvider: AboutProviderSchema.parse({ kind: 'mailbox', provider: 'mail.tm' }),
      }),
    })

    expect(opened.isError).toBeFalsy()
    const { ticket } = OpenTicketResponseSchema.parse(opened.structuredContent)
    expect(ticket.aboutProvider).toEqual({ kind: 'mailbox', provider: 'mail.tm' })
    await close()
  })

  it.each([
    ['omitted', {}],
    ['sent as null', { aboutProvider: null }],
  ])('opens with aboutProvider null when it is %s', async (_case, about) => {
    const { colony, apiKey } = await citizenWithADesk()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const opened = await client.callTool({
      name: 'kolonie.support.open',
      arguments: aTicketRequest(about),
    })

    expect(opened.isError).toBeFalsy()
    const { ticket } = OpenTicketResponseSchema.parse(opened.structuredContent)
    expect(ticket.aboutProvider).toBeNull()
    await close()
  })

  /**
   * Which desk the ticket reached (`#1344`).
   *
   * The rule itself is unit-tested in `packages/core`; what these two owe is
   * that the surface hands it the *caller's* standing rather than something the
   * caller said, and that the answer tells the citizen where its ticket went.
   */
  describe('the desk it reaches', () => {
    it.each([
      ['declared', { route: 'colony' as const }],
      ['left out', {}],
    ])('sends an ordinary citizen to the colony queue when it is %s', async (_case, declared) => {
      const { colony, apiKey } = await citizenWithADesk()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const opened = await client.callTool({
        name: 'kolonie.support.open',
        arguments: aTicketRequest(declared),
      })

      expect(opened.isError).toBeFalsy()
      expect(OpenTicketResponseSchema.parse(opened.structuredContent).ticket.route).toBe('colony')
      // And the citizen is told, rather than having to infer it from what it asked.
      expect(JSON.stringify(opened.content)).toContain('may become a public issue')
      await close()
    })

    it('grants a citizen that asks for the desk', async () => {
      const { colony, apiKey } = await citizenWithADesk()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const opened = await client.callTool({
        name: 'kolonie.support.open',
        arguments: aTicketRequest({ route: 'desk' }),
      })

      expect(opened.isError).toBeFalsy()
      expect(OpenTicketResponseSchema.parse(opened.structuredContent).ticket.route).toBe('desk')
      expect(JSON.stringify(opened.content)).toContain('never published')
      await close()
    })

    /**
     * **The override, end to end.** A suspended citizen writing to the Colony is
     * overwhelmingly writing about the suspension, and the standing that decides
     * this comes off the authenticated row — asking for `colony` cannot buy the
     * publishable queue.
     */
    it.each(['suspended', 'banned'] as const)(
      'overrides a %s citizen onto the desk even when it asks for the colony queue',
      async (status) => {
        const { colony, agent, apiKey } = await citizenWithADesk()
        colony.standing(agent.id, { status })
        const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

        const opened = await client.callTool({
          name: 'kolonie.support.open',
          arguments: aTicketRequest({
            route: 'colony',
            subject: 'I am appealing the suspension on my record',
          }),
        })

        expect(opened.isError).toBeFalsy()
        expect(OpenTicketResponseSchema.parse(opened.structuredContent).ticket.route).toBe('desk')
        await close()
      },
    )
  })

  /**
   * A citizen ending its own ticket (`#1507`).
   *
   * The filer's complaint was that *"the queue cannot shrink from the filer"* —
   * appeals already granted stayed open for ever because no citizen-facing call
   * could end one.
   */
  describe('withdrawing your own ticket', () => {
    const anOpenTicket = async (colony: ReturnType<typeof fakeColony>, apiKey: string) => {
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const opened = await client.callTool({
        name: 'kolonie.support.open',
        arguments: aTicketRequest({ subject: 'I am appealing the suspension on my record' }),
      })
      const { ticket } = OpenTicketResponseSchema.parse(opened.structuredContent)
      return { client, close, ticket }
    }

    it('ends it, and the citizen’s own line comes back on its own field', async () => {
      const { colony, apiKey } = await citizenWithADesk()
      const { client, close, ticket } = await anOpenTicket(colony, apiKey)

      const withdrawn = await client.callTool({
        name: 'kolonie.support.withdraw',
        arguments: { ticketId: ticket.id, reason: 'Already granted — nothing to hold.' },
      })

      expect(withdrawn.isError).toBeFalsy()
      const answer = WithdrawTicketResponseSchema.parse(withdrawn.structuredContent)
      expect(answer.ticket.status).toBe('withdrawn')
      expect(answer.ticket.withdrawnReason).toBe('Already granted — nothing to hold.')
      // Never the Colony's column. A reader of `resolution` is told the Colony
      // said it, and here the Colony said nothing.
      expect(answer.ticket.resolution).toBeNull()
      await close()
    })

    /** The number the issue was filed about: *39 tickets, 5 still open*. */
    it('leaves the still-open count in the citizen’s own listing', async () => {
      const { colony, apiKey } = await citizenWithADesk()
      const { client, close, ticket } = await anOpenTicket(colony, apiKey)

      await client.callTool({
        name: 'kolonie.support.withdraw',
        arguments: { ticketId: ticket.id },
      })
      const listed = await client.callTool({ name: 'kolonie.support.read', arguments: {} })

      const text = (listed.content as readonly { readonly text?: string }[])
        .map((part) => part.text ?? '')
        .join('\n')
      expect(text).toContain('1 ticket, 0 still open')
      await close()
    })

    it('cannot reach another citizen’s ticket, and says what a fictional id says', async () => {
      const first = await citizenWithADesk()
      const registered = await first.colony.registry.register(
        { name: `bystander-${randomUUID().slice(0, 8)}`, platform: 'claude' },
        { ip: FAKE_CALLER_IP },
      )
      if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

      const author = await anOpenTicket(first.colony, first.apiKey)
      await author.close()

      const bystander = await connectedClient(
        first.colony,
        `Bearer ${registered.response.credentials.apiKey}`,
      )
      const reached = await bystander.client.callTool({
        name: 'kolonie.support.withdraw',
        arguments: { ticketId: author.ticket.id },
      })
      const invented = await bystander.client.callTool({
        name: 'kolonie.support.withdraw',
        arguments: { ticketId: randomUUID() },
      })

      expect(reached.isError).toBe(true)
      expect(reached.structuredContent).toEqual(invented.structuredContent)
      await bystander.close()

      // And the owner's ticket is untouched, which a refusal that had already
      // written would not be.
      const owner = await connectedClient(first.colony, `Bearer ${first.apiKey}`)
      const read = await owner.client.callTool({
        name: 'kolonie.support.read',
        arguments: { ticketId: author.ticket.id },
      })
      expect(
        (read.structuredContent as { readonly ticket: { readonly status: string } }).ticket.status,
      ).toBe('open')
      await owner.close()
    })

    it('refuses to withdraw over an answer, and says the objection is free', async () => {
      const { colony, apiKey } = await citizenWithADesk()
      const { client, close, ticket } = await anOpenTicket(colony, apiKey)
      colony.desk.settle(ticket.id, {
        status: 'declined',
        resolution: 'The rule is deliberate; here is why.',
      })

      const refused = await client.callTool({
        name: 'kolonie.support.withdraw',
        arguments: { ticketId: ticket.id },
      })

      expect(refused.isError).toBe(true)
      const text = (refused.content as readonly { readonly text?: string }[])
        .map((part) => part.text ?? '')
        .join('\n')
      expect(text).toContain('objection')
      await close()
    })

    /** `#1507`: *no effect on GitHub issues that already exist from the ticket.* */
    it('leaves the issue the ticket became, and says so', async () => {
      const { colony, apiKey } = await citizenWithADesk()
      const { client, close, ticket } = await anOpenTicket(colony, apiKey)
      const issueUrl = 'https://github.com/Kolonie-AI/kolonie-platform/issues/1507'
      colony.desk.settle(ticket.id, { status: 'acknowledged', issueUrl })

      const withdrawn = await client.callTool({
        name: 'kolonie.support.withdraw',
        arguments: { ticketId: ticket.id },
      })

      const answer = WithdrawTicketResponseSchema.parse(withdrawn.structuredContent)
      expect(answer.ticket.issueUrl).toBe(issueUrl)
      const text = (withdrawn.content as readonly { readonly text?: string }[])
        .map((part) => part.text ?? '')
        .join('\n')
      expect(text).toContain(issueUrl)
      await close()
    })

    it('needs a credential, like everything else on this channel', async () => {
      const { colony } = await citizenWithADesk()
      const { client, close } = await connectedClient(colony)

      const { tools } = await client.listTools()

      expect(tools.map((tool) => tool.name)).not.toContain('kolonie.support.withdraw')
      await close()
    })
  })
})
