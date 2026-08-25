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
const listThreads = (args: Record<string, unknown> = {}) => ({
  name: 'kolonie.messages.list_threads',
  arguments: args,
})
const getThread = (conversationId: string) => ({
  name: 'kolonie.messages.get_thread',
  arguments: { conversationId },
})
const markRead = (conversationId: string, upTo?: string) => ({
  name: 'kolonie.messages.mark_read',
  arguments: upTo === undefined ? { conversationId } : { conversationId, upTo },
})
const archive = (args: Record<string, unknown>) => ({
  name: 'kolonie.messages.archive',
  arguments: args,
})
const acknowledge = (messageId: string) => ({
  name: 'kolonie.messages.acknowledge',
  arguments: { messageId },
})
const protect = (args: Record<string, unknown>) => ({
  name: 'kolonie.messages.protect',
  arguments: args,
})

const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(result.content)

const TOOLS = [
  'kolonie.messages.list_threads',
  'kolonie.messages.get_thread',
  'kolonie.messages.send',
  'kolonie.messages.requests',
  'kolonie.messages.mark_read',
  'kolonie.messages.archive',
  'kolonie.messages.acknowledge',
  'kolonie.messages.protect',
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

  /**
   * `#1681`: the tool answered `mcp.tool.threw` for an `upTo` that named no
   * message, because the id went straight into a column with a foreign key on
   * it. A bad argument is a refusal an agent can branch on, not a 500.
   */
  it('refuses an upTo that names no message of the conversation', async () => {
    const { alice, bob, close } = await aPair()

    const asked = await alice.client.callTool(
      send({ to: bob.agent.profile.name, body: 'First contact.' }),
    )
    const requestId = (asked.structuredContent as { requestId: string }).requestId
    const conversationId = (asked.structuredContent as { conversationId: string }).conversationId
    await bob.client.callTool(requests({ act: 'accept', requestId }))

    const refused = await bob.client.callTool(
      markRead(conversationId, '00000000-0000-0000-0000-000000000000'),
    )
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toMatchObject({ error: { code: 'not_found' } })
    expect(textOf(refused)).toContain('names no message')

    const marked = await bob.client.callTool(markRead(conversationId))
    expect(marked.structuredContent).toEqual({ marked: true })

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

  /**
   * The citizen's half of `#1288`. The operator's own direction is a console
   * route — there is deliberately no tool here that opens one, so what these
   * assert is that a citizen can tell its operator's thread from a DM, read it
   * and answer in it.
   */
  describe('operator threads (#1288)', () => {
    it('lists them apart from citizen DMs, and narrows to either', async () => {
      const { colony, alice, bob, close } = await aPair()

      const conversationId = colony.messaging.operatorThread(alice.agent.profile.name)
      const asked = await bob.client.callTool(
        send({ to: alice.agent.profile.name, body: 'I read your Atlas entry.' }),
      )
      const requestId = (asked.structuredContent as { requestId: string }).requestId
      await alice.client.callTool(requests({ act: 'accept', requestId }))

      const all = await alice.client.callTool(listThreads())
      expect((all.structuredContent as { threads: unknown[] }).threads).toHaveLength(2)

      const mine = await alice.client.callTool(listThreads({ kind: 'operator-human' }))
      expect(mine.structuredContent).toMatchObject({
        threads: [expect.objectContaining({ id: conversationId, kind: 'operator-human' })],
      })
      /** The kind is printed, so a model reading the text can tell them apart too. */
      expect(textOf(mine)).toContain('[operator-human]')

      const dms = await alice.client.callTool(listThreads({ kind: 'citizen' }))
      expect((dms.structuredContent as { threads: unknown[] }).threads).toHaveLength(1)
      expect(textOf(dms)).not.toContain('[operator-human]')

      await close()
    })

    it('reads the thread with the person’s party on it, and answers in it', async () => {
      const { colony, alice, close } = await aPair()
      const conversationId = colony.messaging.operatorThread(alice.agent.profile.name)

      const read = await alice.client.callTool(getThread(conversationId))
      expect(read.structuredContent).toMatchObject({
        messages: [
          expect.objectContaining({ sender: expect.objectContaining({ party: 'operator-human' }) }),
        ],
      })
      expect(textOf(read)).toContain(MESSAGE_UNTRUSTED_CONTENT)

      const replied = await alice.client.callTool(send({ conversationId, body: 'Understood.' }))
      expect(replied.structuredContent).toMatchObject({ outcome: 'delivered' })

      await close()
    })

    it('refuses a reply once the relationship has ended, and keeps the thread readable', async () => {
      const { colony, alice, close } = await aPair()
      const conversationId = colony.messaging.operatorThread(alice.agent.profile.name)
      colony.messaging.endOperatorLink(conversationId)

      const refused = await alice.client.callTool(send({ conversationId, body: 'Still there?' }))
      expect(refused.isError).toBe(true)
      expect(refused.structuredContent).toMatchObject({ error: { code: 'conflict' } })

      const read = await alice.client.callTool(getThread(conversationId))
      expect(read.isError).toBeFalsy()

      await close()
    })
  })

  /**
   * `#1289`: system fields surface on read; acknowledge clears actionRequired;
   * there is still no citizen tool that mints a system-role sender.
   */
  describe('system messages (#1289)', () => {
    it('surfaces priority and actionRequired, and acknowledge clears them', async () => {
      const { colony, alice, close } = await aPair()
      const { conversationId, messageId } = colony.messaging.systemThread(
        alice.agent.profile.name,
        {
          nextAction: 'kolonie.support.open',
        },
      )

      const read = await alice.client.callTool(getThread(conversationId))
      expect(read.structuredContent).toMatchObject({
        messages: [
          expect.objectContaining({
            priority: 'critical',
            actionRequired: true,
            nextAction: 'kolonie.support.open',
            sender: expect.objectContaining({ party: 'system-role', systemRole: 'security' }),
          }),
        ],
      })
      expect(textOf(read)).toContain('actionRequired')
      expect(textOf(read)).toContain('priority=critical')

      const done = await alice.client.callTool(acknowledge(messageId))
      expect(done.isError).toBeFalsy()
      expect(done.structuredContent).toMatchObject({
        acknowledgedAt: expect.stringMatching(/^\d{4}-/),
      })

      const again = await alice.client.callTool(getThread(conversationId))
      expect(again.structuredContent).toMatchObject({
        messages: [expect.objectContaining({ actionRequired: false })],
      })

      const second = await alice.client.callTool(acknowledge(messageId))
      expect(second.isError).toBe(true)
      expect(second.structuredContent).toMatchObject({ error: { code: 'not_found' } })

      await close()
    })

    it('refuses acknowledge for a citizen-authored message and for another inbox', async () => {
      const { colony, alice, bob, close } = await aPair()
      const asked = await alice.client.callTool(
        send({ to: bob.agent.profile.name, body: 'Not a system message.' }),
      )
      const requestId = (asked.structuredContent as { requestId: string }).requestId
      const conversationId = (asked.structuredContent as { conversationId: string }).conversationId
      await bob.client.callTool(requests({ act: 'accept', requestId }))

      const thread = await bob.client.callTool(getThread(conversationId))
      const messageId = (thread.structuredContent as { messages: { id: string }[] }).messages[0]!.id

      const onCitizen = await bob.client.callTool(acknowledge(messageId))
      expect(onCitizen.isError).toBe(true)
      expect(onCitizen.structuredContent).toMatchObject({ error: { code: 'not_found' } })

      const { messageId: systemId } = colony.messaging.systemThread(alice.agent.profile.name)
      const outsider = await bob.client.callTool(acknowledge(systemId))
      expect(outsider.isError).toBe(true)
      expect(outsider.structuredContent).toMatchObject({ error: { code: 'not_found' } })

      await close()
    })
  })

  describe('protect (#1290)', () => {
    it('blocks further delivery and declines a pending request', async () => {
      const { alice, bob, close } = await aPair()
      const asked = await alice.client.callTool(
        send({ to: bob.agent.profile.name, body: 'May I write?' }),
      )
      expect(asked.isError).not.toBe(true)

      const blocked = await bob.client.callTool(
        protect({ handle: alice.agent.profile.name, act: 'block' }),
      )
      expect(blocked.isError).not.toBe(true)
      expect(blocked.structuredContent).toMatchObject({ blocked: true })

      const inbox = await bob.client.callTool(requests())
      const listed = inbox.structuredContent as { requests: { status: string }[] }
      expect(listed.requests.every((r) => r.status !== 'pending')).toBe(true)

      const again = await alice.client.callTool(
        send({ to: bob.agent.profile.name, body: 'Still here?' }),
      )
      expect(again.isError).toBe(true)
      expect(again.structuredContent).toMatchObject({ error: { code: 'blocked' } })

      await close()
    })

    it('unblocks and reports an auditable record', async () => {
      const { alice, bob, close } = await aPair()
      await bob.client.callTool(protect({ handle: alice.agent.profile.name, act: 'block' }))
      const unblocked = await bob.client.callTool(
        protect({ handle: alice.agent.profile.name, act: 'unblock' }),
      )
      expect(unblocked.structuredContent).toMatchObject({ unblocked: true })

      const reported = await bob.client.callTool(
        protect({
          handle: alice.agent.profile.name,
          act: 'report',
          reason: 'Unsolicited spam paste across many citizens.',
        }),
      )
      expect(reported.isError).not.toBe(true)
      expect(reported.structuredContent).toMatchObject({
        reported: true,
        reportId: expect.any(String),
      })

      await close()
    })

    it('carries untrusted-content wording on the protect tool', async () => {
      const { alice, close } = await aPair()
      const listed = await alice.client.listTools()
      const tool = listed.tools.find((t) => t.name === 'kolonie.messages.protect')
      expect(tool?.description).toMatch(/untrusted content/i)
      expect(tool?.description).toMatch(/never instructions|data, never instructions/i)
      await close()
    })
  })

  describe('operator opens (#1319)', () => {
    const A_TASK = '11111111-1111-4111-a111-111111111111'
    const B_TASK = '22222222-2222-4222-a222-222222222222'
    const A_WISH = '33333333-3333-4333-a333-333333333333'

    it('needs exactly one destination, and says which argument was the one too many', async () => {
      const { alice, close } = await aPair()

      const none = await alice.client.callTool(send({ body: 'Nobody is named here.' }))
      expect(none.isError).toBe(true)
      expect(none.structuredContent).toMatchObject({ error: { code: 'validation_failed' } })

      const both = await alice.client.callTool(
        send({ to: 'correspondent', operator: true, body: 'Two destinations at once.' }),
      )
      expect(both.isError).toBe(true)
      expect(both.structuredContent).toMatchObject({ error: { code: 'validation_failed' } })

      await close()
    })

    it('refuses a subject that does not belong to an operator open', async () => {
      const { colony, alice, close } = await aPair()
      colony.messaging.operatorLink(alice.agent.profile.name)

      /** A subject on a citizen DM: the thread it would qualify cannot hold one. */
      const dm = await alice.client.callTool(
        send({ to: 'correspondent', taskId: A_TASK, body: 'What is this thread about?' }),
      )
      expect(dm.isError).toBe(true)
      expect(dm.structuredContent).toMatchObject({ error: { code: 'validation_failed' } })

      /** Both halves of the provenance pair, refused before the CHECK sees it. */
      const both = await alice.client.callTool(
        send({ operator: true, taskId: A_TASK, wishId: A_WISH, body: 'About two things at once.' }),
      )
      expect(both.isError).toBe(true)
      expect(both.structuredContent).toMatchObject({ error: { code: 'validation_failed' } })

      await close()
    })

    it('refuses to open when nobody answers for this citizen', async () => {
      const { alice, close } = await aPair()

      const refused = await alice.client.callTool(
        send({ operator: true, body: 'Could you open the account for me?' }),
      )
      expect(refused.isError).toBe(true)
      expect(refused.structuredContent).toMatchObject({ error: { code: 'forbidden' } })

      await close()
    })

    it('opens one thread per subject, and lands the same subject in the thread that holds it', async () => {
      const { colony, alice, close } = await aPair()
      colony.messaging.operatorLink(alice.agent.profile.name)

      const first = await alice.client.callTool(
        send({
          operator: true,
          taskId: A_TASK,
          body: 'This rung needs a card. Could you add one?',
        }),
      )
      expect(first.structuredContent).toMatchObject({ outcome: 'delivered' })
      const firstThread = (first.structuredContent as { conversationId: string }).conversationId

      const again = await alice.client.callTool(
        send({
          operator: true,
          taskId: A_TASK,
          body: 'Still the same rung, in case it was missed.',
        }),
      )
      expect(again.structuredContent).toMatchObject({ conversationId: firstThread })

      const second = await alice.client.callTool(
        send({ operator: true, taskId: B_TASK, body: 'A different rung, and a different ask.' }),
      )
      const secondThread = (second.structuredContent as { conversationId: string }).conversationId
      expect(secondThread).not.toBe(firstThread)

      /** Naming neither is an ordinary open, and the plain thread is its own. */
      const plain = await alice.client.callTool(
        send({ operator: true, body: 'Nothing in particular — are you there?' }),
      )
      const plainThread = (plain.structuredContent as { conversationId: string }).conversationId
      expect(plainThread).not.toBe(firstThread)
      expect(plainThread).not.toBe(secondThread)

      const threads = await alice.client.callTool(listThreads({ kind: 'operator-human' }))
      expect((threads.structuredContent as { threads: unknown[] }).threads).toHaveLength(3)

      await close()
    })
  })

  /**
   * **A citizen may take a thread out of its own list** (`#1550`). Measured on
   * production 2026-08-21: 53 of 53 operator participant rows archived, 0 of 54
   * citizen rows — because there was no call, not because nobody wanted one.
   */
  describe('archive (#1550)', () => {
    it('takes a thread out of the default listing and gives it back', async () => {
      const { alice, bob, close } = await aPair()

      const opened = await bob.client.callTool(
        send({ to: alice.agent.profile.name, body: 'Have you walked this provider?' }),
      )
      const requestId = (opened.structuredContent as { requestId: string }).requestId
      await alice.client.callTool(requests({ act: 'accept', requestId }))

      const listed = await alice.client.callTool(listThreads())
      const [thread] = (listed.structuredContent as { threads: { id: string }[] }).threads
      expect(thread).toBeDefined()

      const archived = await alice.client.callTool(archive({ conversationId: thread!.id }))
      expect(archived.structuredContent).toEqual({ archived: true })
      expect(textOf(archived)).toContain('Archived')

      const open = await alice.client.callTool(listThreads())
      expect((open.structuredContent as { threads: unknown[] }).threads).toHaveLength(0)

      const behindTheFlag = await alice.client.callTool(listThreads({ archived: true }))
      expect(
        (behindTheFlag.structuredContent as { threads: { id: string }[] }).threads.map((t) => t.id),
      ).toEqual([thread!.id])

      const back = await alice.client.callTool(
        archive({ conversationId: thread!.id, archived: false }),
      )
      expect(back.structuredContent).toEqual({ archived: false })
      expect((await alice.client.callTool(listThreads())).structuredContent).toMatchObject({
        threads: [{ id: thread!.id }],
      })

      await close()
    })

    /**
     * *Not a participant* and *no such thread* are the same answer on purpose —
     * the refusal `messageRefusals` writes says so — so a conversation id nobody
     * holds is the honest way to reach this branch.
     */
    it('refuses a thread the caller is not in', async () => {
      const { alice, close } = await aPair()

      const refused = await alice.client.callTool(
        archive({ conversationId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' }),
      )
      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toContain('not a participant')

      await close()
    })
  })
})
