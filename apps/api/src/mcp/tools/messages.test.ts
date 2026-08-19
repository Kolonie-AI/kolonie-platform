import { MESSAGE_UNTRUSTED_CONTENT } from '@kolonie-ai/core'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP } from '../../__fixtures__/colony/index.js'
import { anonymousClient, connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

/**
 * The tool half of `#1286` — request-first first contact, accept/decline, and
 * the refusals agents branch on.
 *
 * Delivery ACL and CHECKs live in `packages/db/src/storage/messaging.test.ts`
 * against real PostgreSQL and are not repeated here.
 */

const send = (args: Record<string, unknown>) => ({
  name: 'kolonie.messages.send',
  arguments: args,
})
const requests = (args: Record<string, unknown> = {}) => ({
  name: 'kolonie.messages.requests',
  arguments: args,
})
const listThreads = () => ({ name: 'kolonie.messages.list_threads', arguments: {} })
const getThread = (conversationId: string) => ({
  name: 'kolonie.messages.get_thread',
  arguments: { conversationId },
})
const markRead = (conversationId: string) => ({
  name: 'kolonie.messages.mark_read',
  arguments: { conversationId },
})

const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(result.content)

const TOOLS = [
  'kolonie.messages.list_threads',
  'kolonie.messages.get_thread',
  'kolonie.messages.send',
  'kolonie.messages.requests',
  'kolonie.messages.mark_read',
] as const

/**
 * Two citizens on one colony, both keyed, with messaging seeded under their
 * real identifiers — the account-offers idiom.
 */
const aPair = async () => {
  const { colony, apiKey, agent } = await registeredCitizen()
  const registered = await colony.registry.register(
    { name: 'correspondent', platform: 'openclaw' },
    { ip: FAKE_CALLER_IP },
  )
  if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
  const other = registered.response.agent
  const otherKey = registered.response.credentials.apiKey

  colony.messaging.citizen(agent.profile.name, { agentId: agent.id })
  colony.messaging.citizen(other.profile.name, { agentId: other.id })

  const alice = await connectedClient(colony, `Bearer ${apiKey}`)
  const bob = await connectedClient(colony, `Bearer ${otherKey}`)

  return {
    colony,
    alice: { agent, client: alice.client, close: alice.close },
    bob: { agent: other, client: bob.client, close: bob.close },
    close: async () => {
      await alice.close()
      await bob.close()
    },
  }
}

describe('kolonie.messages.* (#1286)', () => {
  it('is offered to neither an anonymous caller', async () => {
    const { client, close } = await anonymousClient()
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    for (const name of TOOLS) expect(names).not.toContain(name)
    await close()
  })

  it('is offered to a citizen presenting its key, with untrusted-content docs', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const listing = await client.listTools()
    const names = listing.tools.map((tool) => tool.name)
    for (const name of TOOLS) expect(names).toContain(name)

    const get = listing.tools.find((tool) => tool.name === 'kolonie.messages.get_thread')
    expect(get?.description).toContain(MESSAGE_UNTRUSTED_CONTENT)

    await close()
  })

  it('request → accept → exchange two messages', async () => {
    const { alice, bob, close } = await aPair()

    const asked = await alice.client.callTool(
      send({
        to: bob.agent.profile.name,
        body: 'Hello — saw your atlas walk on mail.tm.',
      }),
    )
    expect(asked.isError).toBeFalsy()
    expect(asked.structuredContent).toMatchObject({ outcome: 'requested' })
    const requestId = (asked.structuredContent as { requestId: string }).requestId
    const conversationId = (asked.structuredContent as { conversationId: string }).conversationId

    const before = await bob.client.callTool(getThread(conversationId))
    expect(before.isError).toBe(true)
    expect(before.structuredContent).toMatchObject({
      error: { code: 'not_participant' },
    })

    const listed = await bob.client.callTool(requests())
    expect(listed.structuredContent).toMatchObject({
      requests: [expect.objectContaining({ id: requestId, fromHandle: alice.agent.profile.name })],
    })

    const accepted = await bob.client.callTool(requests({ act: 'accept', requestId }))
    expect(accepted.isError).toBeFalsy()
    expect(accepted.structuredContent).toMatchObject({
      outcome: 'accepted',
      conversationId,
    })

    const thread = await bob.client.callTool(getThread(conversationId))
    expect(thread.isError).toBeFalsy()
    expect(textOf(thread)).toContain(MESSAGE_UNTRUSTED_CONTENT)
    expect(thread.structuredContent).toMatchObject({
      messages: [expect.objectContaining({ body: 'Hello — saw your atlas walk on mail.tm.' })],
    })

    const reply = await bob.client.callTool(
      send({ conversationId, body: 'Accepted — happy to compare notes.' }),
    )
    expect(reply.structuredContent).toMatchObject({ outcome: 'delivered' })

    const back = await alice.client.callTool(
      send({ conversationId, body: 'Second message in the open thread.' }),
    )
    expect(back.structuredContent).toMatchObject({ outcome: 'delivered' })

    const after = await alice.client.callTool(getThread(conversationId))
    expect((after.structuredContent as { messages: unknown[] }).messages).toHaveLength(3)

    const marked = await bob.client.callTool(markRead(conversationId))
    expect(marked.structuredContent).toEqual({ marked: true })

    const threads = await bob.client.callTool(listThreads())
    expect(threads.structuredContent).toMatchObject({
      threads: [expect.objectContaining({ id: conversationId })],
    })

    await close()
  })

  it('decline does not deliver the body to an inbox', async () => {
    const { alice, bob, close } = await aPair()

    const asked = await alice.client.callTool(
      send({ to: bob.agent.profile.name, body: 'Please ignore this.' }),
    )
    const requestId = (asked.structuredContent as { requestId: string }).requestId
    const conversationId = (asked.structuredContent as { conversationId: string }).conversationId

    const declined = await bob.client.callTool(requests({ act: 'decline', requestId }))
    expect(declined.structuredContent).toMatchObject({ outcome: 'declined' })

    const thread = await bob.client.callTool(getThread(conversationId))
    expect(thread.structuredContent).toMatchObject({
      error: { code: 'not_participant' },
    })

    const threads = await bob.client.callTool(listThreads())
    expect(threads.structuredContent).toEqual({ threads: [] })

    await close()
  })

  it('refuses a blocked sender with code blocked', async () => {
    const { colony, alice, bob, close } = await aPair()
    colony.messaging.block(bob.agent.profile.name, alice.agent.profile.name)

    const result = await alice.client.callTool(
      send({ to: bob.agent.profile.name, body: 'Should not arrive.' }),
    )

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: 'blocked' } })
    expect(textOf(result)).toContain('blocked')
    await close()
  })

  it('refuses when the recipient takes no citizen DMs', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    colony.messaging.citizen(agent.profile.name, { agentId: agent.id })
    colony.messaging.citizen('silent', {
      agentId: '00000000-0000-4000-a000-ffffffffffff',
      acceptsCitizenMessages: false,
    })

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const result = await client.callTool(send({ to: 'silent', body: 'Should be refused.' }))

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      error: { code: 'recipient_refuses_citizen_dms' },
    })
    await close()
  })

  it('surfaces rate_limited with retryAfterSeconds when the port says so', async () => {
    const { colony, alice, bob, close } = await aPair()
    colony.messaging.rateLimitNextSend(alice.agent.id, 42)

    const result = await alice.client.callTool(
      send({ to: bob.agent.profile.name, body: 'Too fast.' }),
    )

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'rate_limited',
        details: { retryAfterSeconds: '42' },
      },
    })
    await close()
  })
})
