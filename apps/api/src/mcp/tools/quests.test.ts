import type { AgentId, TaskId } from '@kolonie-ai/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'
import { fakeQuests, type FakeQuestDesk } from '../../__fixtures__/quests.js'
import { fakeStore, type FakeStore } from '../../__fixtures__/store.js'
import { AUTHENTICATED_TOOLS, STEWARD_TOOLS, UNAUTHENTICATED_TOOLS } from '../../mcp.js'

/**
 * The quest surface over MCP (`#320`).
 *
 * Driven through a real client and the real protocol, like every other tool
 * test: the input schema and the description are part of what an agent sees, and
 * only a round trip proves they survived registration.
 */

let store: FakeStore
let quests: FakeQuestDesk

const colony = () => ({ ...fakeColony(), store, quests })

beforeEach(() => {
  store = fakeStore()
  quests = fakeQuests()
})

const anAgent = (roles: readonly 'steward'[] = []) => {
  const issued = store.issue({})
  if (roles.length > 0) store.setRoles(issued.agent.id, roles)
  return { id: issued.agent.id as AgentId, key: String(issued.apiKey) }
}

const aDraft = (overrides: Record<string, unknown> = {}) => ({
  questions: [
    {
      key: 'what-happened',
      prompt: 'What happened when you registered?',
      minLength: 20,
      maxLength: 500,
    },
  ],
  title: 'A thousand registrations',
  description: 'We hand out mailbox addresses and want to know whether agents can take one.',
  instructions: 'Register at the address in the brief and report what happened.',
  reward: { credits: 1, reputation: 0 },
  slots: 5,
  expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
  ...overrides,
})

const call = async (
  key: string,
  name: string,
  args: Record<string, unknown> = {},
  steward = false,
) => {
  const { client, close } = await connectedClient(colony(), `Bearer ${key}`, undefined, steward)
  const result = await client.callTool({ name, arguments: args })
  await close()
  return result
}

const structured = (result: Awaited<ReturnType<typeof call>>) =>
  result.structuredContent as Record<string, never>

describe('the sponsor over MCP', () => {
  it('writes a quest, reads it back, and sees it in its own list', async () => {
    const sponsor = anAgent()

    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    expect(written.isError).toBeFalsy()

    const id = (structured(written).quest as unknown as { id: TaskId }).id
    const read = await call(sponsor.key, 'kolonie.quests.read', { questId: id })
    const listed = await call(sponsor.key, 'kolonie.quests.list')

    expect((structured(read).quest as unknown as { title: string }).title).toBe(
      'A thousand registrations',
    )
    expect(structured(listed).quests).toHaveLength(1)
  })

  /**
   * The number that had no route at all until this issue: `QuestDesk.balance`
   * was read by six console pages and by nothing else, so a sponsor not driving
   * a browser found out what it could afford by being refused.
   */
  it('reads a balance, and the reservation shows up in it after submission', async () => {
    const sponsor = anAgent()
    quests.credit(sponsor.id, 100)

    const before = await call(sponsor.key, 'kolonie.quests.balance')
    expect(structured(before)).toMatchObject({ balance: 100, reserved: 0, available: 100 })

    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    const submitted = await call(sponsor.key, 'kolonie.quests.submit', { questId: id })
    expect(submitted.isError).toBeFalsy()

    // Five slots at one credit each, reserved whole at submission — a quest that
    // cannot be paid for never reaches a steward.
    const after = await call(sponsor.key, 'kolonie.quests.balance')
    expect(structured(after)).toMatchObject({ balance: 100, reserved: 5, available: 95 })
  })

  it('is refused a quest it cannot pay for, and nothing is reserved', async () => {
    const sponsor = anAgent()

    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    const submitted = await call(sponsor.key, 'kolonie.quests.submit', { questId: id })

    expect(submitted.isError).toBe(true)
    expect(structured(await call(sponsor.key, 'kolonie.quests.balance'))).toMatchObject({
      reserved: 0,
    })
  })

  it('changes a draft it has not submitted', async () => {
    const sponsor = anAgent()

    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    const changed = await call(sponsor.key, 'kolonie.quests.update', {
      questId: id,
      title: 'A hundred registrations',
    })

    expect(changed.isError).toBeFalsy()
    const read = await call(sponsor.key, 'kolonie.quests.read', { questId: id })
    expect((structured(read).quest as unknown as { title: string }).title).toBe(
      'A hundred registrations',
    )
  })

  /**
   * What a sponsor is shown before the step it cannot take back (`#323`).
   *
   * Asserted on the text as well as on the structure, because the text is what a
   * model acts on: a cost that only appears in `structuredContent` is a cost the
   * reader has to go looking for, which is close to the failure being fixed.
   */
  it('echoes the cost and the citizen view when a draft is written', async () => {
    const sponsor = anAgent()
    quests.credit(sponsor.id, 500)

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ reward: { credits: 15, reputation: 0 }, slots: 20 }),
    )

    expect(structured(written).commitment).toMatchObject({
      cost: 300,
      available: 500,
      affordable: true,
    })
    expect(String(structured(written).preview)).toContain('A thousand registrations')
    expect(JSON.stringify(written.content)).toContain('300 credit(s)')
  })

  it('says the draft is unaffordable at the moment it is written', async () => {
    const sponsor = anAgent()
    quests.credit(sponsor.id, 100)

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ reward: { credits: 15, reputation: 0 }, slots: 200 }),
    )

    expect(structured(written).commitment).toMatchObject({ cost: 3000, affordable: false })
    expect(JSON.stringify(written.content)).toContain('more than you can currently pay')
  })

  it('withdraws a quest from review, freeing the reservation and the slot', async () => {
    const sponsor = anAgent()
    quests.credit(sponsor.id, 1_000)

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ reward: { credits: 10, reputation: 0 }, slots: 5 }),
    )
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    await call(sponsor.key, 'kolonie.quests.submit', { questId: id })

    expect(structured(await call(sponsor.key, 'kolonie.quests.balance')).reserved).toBe(50)

    const withdrawn = await call(sponsor.key, 'kolonie.quests.withdraw', { questId: id })

    expect(withdrawn.isError).toBeFalsy()
    expect((structured(withdrawn).quest as unknown as { status: string }).status).toBe('draft')
    expect(structured(await call(sponsor.key, 'kolonie.quests.balance')).reserved).toBe(0)

    // Editable again, which is the whole reason a sponsor withdraws.
    const changed = await call(sponsor.key, 'kolonie.quests.update', {
      questId: id,
      title: 'A hundred registrations',
    })
    expect(changed.isError).toBeFalsy()
  })

  it('refuses to withdraw a quest that was never in the queue', async () => {
    const sponsor = anAgent()

    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id

    const withdrawn = await call(sponsor.key, 'kolonie.quests.withdraw', { questId: id })

    expect(withdrawn.isError).toBe(true)
    expect(JSON.stringify(withdrawn.content)).toContain('already a draft')
  })

  /**
   * *No such quest* and *not yours* are one answer on both surfaces, and the
   * reason is the same: a distinguishable refusal enumerates which task ids are
   * quests and who owns them.
   */
  it('cannot read somebody else’s quest', async () => {
    const sponsor = anAgent()
    const stranger = anAgent()

    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id

    const read = await call(stranger.key, 'kolonie.quests.read', { questId: id })
    expect(read.isError).toBe(true)
    expect(JSON.stringify(read.content)).toContain('not_found')
  })
})

describe('the steward tier', () => {
  it('is absent from an ordinary sponsor’s tool list', async () => {
    const sponsor = anAgent()
    const { client, close } = await connectedClient(colony(), `Bearer ${sponsor.key}`)

    const listing = await client.listTools()
    const names = listing.tools.map((tool) => tool.name)

    expect(names.sort()).toEqual([...UNAUTHENTICATED_TOOLS, ...AUTHENTICATED_TOOLS].sort())
    // Not merely absent from the names — absent from the listing altogether, so
    // no description names a tool this caller cannot reach.
    for (const tool of STEWARD_TOOLS) expect(JSON.stringify(listing)).not.toContain(tool)
    await close()
  })

  it('appears for a caller that holds the role', async () => {
    const steward = anAgent(['steward'])
    const { client, close } = await connectedClient(
      colony(),
      `Bearer ${steward.key}`,
      undefined,
      true,
    )

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...UNAUTHENTICATED_TOOLS, ...AUTHENTICATED_TOOLS, ...STEWARD_TOOLS].sort(),
    )
    await close()
  })

  /**
   * **Unlisted is not unreachable.** The tier decides what is offered and the
   * handler decides what is allowed, and this is the caller the second one is
   * for: one that learned the name somewhere other than a listing.
   */
  it('refuses a caller without the role even when the tools were registered', async () => {
    const sponsor = anAgent()

    const result = await call(sponsor.key, 'kolonie.quests.review', {}, true)

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('forbidden')
  })

  it('reviews and publishes, and the escrow moves with the publication', async () => {
    const sponsor = anAgent()
    const steward = anAgent(['steward'])
    quests.credit(sponsor.id, 100)

    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    await call(sponsor.key, 'kolonie.quests.submit', { questId: id })
    quests.moderate(id)

    const queue = await call(steward.key, 'kolonie.quests.review', {}, true)
    expect(structured(queue).quests).toHaveLength(1)

    const published = await call(steward.key, 'kolonie.quests.publish', { questId: id }, true)
    expect(published.isError).toBeFalsy()
    expect(structured(published)).toMatchObject({ escrowed: 5 })
  })

  it('refuses a quest with a reason its author reads', async () => {
    const sponsor = anAgent()
    const steward = anAgent(['steward'])
    quests.credit(sponsor.id, 100)

    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    await call(sponsor.key, 'kolonie.quests.submit', { questId: id })
    quests.moderate(id)

    const refused = await call(
      steward.key,
      'kolonie.quests.refuse',
      { questId: id, reason: 'The instructions do not say where to register.' },
      true,
    )
    expect(refused.isError).toBeFalsy()

    const read = await call(sponsor.key, 'kolonie.quests.read', { questId: id })
    expect(structured(read).rejectionReason).toBe('The instructions do not say where to register.')
  })
})
