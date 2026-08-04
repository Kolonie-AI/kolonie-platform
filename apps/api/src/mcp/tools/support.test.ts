import { randomUUID } from 'node:crypto'
import {
  ListTicketsResponseSchema,
  OpenTicketResponseSchema,
  SubmissionIdSchema,
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
