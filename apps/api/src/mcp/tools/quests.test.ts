import { AUDIENCE_FLOOR, type AgentId, type TaskId } from '@kolonie-ai/core'
import { SKILLS_THE_ACADEMY_GRANTS } from '@kolonie-ai/db'
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'
import { fakePaymentDesk, type FakePaymentDesk } from '../../__fixtures__/payments.js'
import { FAKE_AUDIENCE, fakeQuests, type FakeQuestDesk } from '../../__fixtures__/quests.js'
import { fakeStore, type FakeStore } from '../../__fixtures__/store.js'
import { AUTHENTICATED_TOOLS, WARDEN_TOOLS, UNAUTHENTICATED_TOOLS } from '../../mcp.js'

/**
 * The quest surface over MCP (`#320`).
 *
 * Driven through a real client and the real protocol, like every other tool
 * test: the input schema and the description are part of what an agent sees, and
 * only a round trip proves they survived registration.
 */

let store: FakeStore
let quests: FakeQuestDesk
/** Held across the per-call colonies below, so a test can seed an arrival (`#760`). */
let paymentDesk: FakePaymentDesk

const colony = () => ({ ...fakeColony(), store, quests, paymentDesk })

beforeEach(() => {
  store = fakeStore()
  quests = fakeQuests()
  paymentDesk = fakePaymentDesk()
})

const anAgent = (roles: readonly 'warden'[] = []) => {
  const issued = store.issue({})
  if (roles.length > 0) store.setRoles(issued.agent.id, roles)
  return { id: issued.agent.id as AgentId, key: String(issued.apiKey) }
}

/**
 * A draft an ordinary citizen can publish, which since `#744` is a priced one.
 *
 * `criteria` on the question puts it in the colony-judged tier, so the ceiling is
 * 10,000,000 rather than the soft 500,000 and a price can reach the floor at all;
 * obstacles are off because publishing them is a second promise the platform fee
 * is not taken from, and it binds at four times the floor. 1,400,000 clears both
 * with room, so a test that is not about the price never has to think about one.
 *
 * **Reputation-only is now the steward's case**, not the default: `#743` made the
 * floor a refusal and `#744` made paying nothing a role. A test about either says
 * so by setting a price or by holding the role.
 */
const aDraft = (overrides: Record<string, unknown> = {}) => ({
  questions: [
    {
      key: 'what-happened',
      prompt: 'What happened when you registered?',
      criteria: 'Name the provider and what it asked for.',
      minLength: 20,
      maxLength: 500,
    },
  ],
  title: 'A thousand registrations',
  description: 'We hand out mailbox addresses and want to know whether agents can take one.',
  instructions: 'Register at the address in the brief and report what happened.',
  reward: { reputation: 5, lamports: 1_400_000 },
  publishObstacles: false,
  slots: 5,
  expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
  ...overrides,
})

const call = async (
  key: string,
  name: string,
  args: Record<string, unknown> = {},
  warden = false,
) => {
  const { client, close } = await connectedClient(colony(), `Bearer ${key}`, undefined, warden)
  const result = await client.callTool({ name, arguments: args })
  await close()
  return result
}

const structured = (result: Awaited<ReturnType<typeof call>>) =>
  result.structuredContent as Record<string, never>

describe('the sponsor over MCP', () => {
  it('does not offer a refund in any quest tool description', async () => {
    const { client, close } = await connectedClient(colony(), `Bearer ${anAgent().key}`)
    const { tools } = await client.listTools()
    await close()

    const descriptions = tools
      .filter((tool) => tool.name.startsWith('kolonie.quests.'))
      .map((tool) => tool.description ?? '')

    expect(descriptions).not.toHaveLength(0)
    for (const description of descriptions) {
      expect(description).not.toMatch(/\b(?:is|are|be|been) refunded\b|\brefunded at\b/i)
    }
  })

  it('describes a proof verifier as a hand-in check rather than an attempt gate', async () => {
    const { client, close } = await connectedClient(colony(), `Bearer ${anAgent().key}`)
    const { tools } = await client.listTools()
    await close()

    const description =
      tools.find((tool) => tool.name === 'kolonie.quests.write')?.description ?? ''
    expect(description).toContain('checked when an answer is handed in')
    expect(description).toContain('does not narrow who may attempt')
    expect(description).not.toContain('gate on who may answer')
  })

  it('describes submission without the deleted funding mechanism', async () => {
    const sponsor = anAgent()
    const { client, close } = await connectedClient(colony(), `Bearer ${sponsor.key}`)
    const { tools } = await client.listTools()
    await close()

    const described = ['kolonie.quests.submit', 'kolonie.quests.withdraw'].map(
      (name) => tools.find((tool) => tool.name === name)?.description ?? '',
    )

    expect(described[0]).toContain('commitment has already been computed and shown')
    expect(described[0]).toContain(
      'the Colony publishes it and asks you to pay the full commitment',
    )
    expect(described[0]).toContain('The Colony checks one quest of yours at a time')
    expect(described[0]).toContain('after submitting')
    expect(described[1]).toContain('lets you submit another quest')
    for (const description of described) {
      expect(description).not.toHaveLength(0)
      expect(description.toLowerCase()).not.toContain('reservation')
      // The credit balance the Colony held on a sponsor's behalf, which D-106
      // deleted. **Only this phrase, and no longer the bare word `balance`**:
      // since D-115 (`#751`) the text says the Colony reads the sponsor's own
      // *public* balance and reserves nothing, and a word filter cannot tell a
      // denial from a claim — `nothing is reserved` matched a ban on
      // `reserved`. What replaces the filter is the positive assertion below,
      // which is the stronger test anyway: it fails if the sentence goes
      // missing, where a blacklist only failed if the wrong one came back.
      expect(description.toLowerCase()).not.toContain('your balance')
    }

    // And what it does say about money it does not hold (D-115, `#751`).
    expect(described[0]).toContain('Your wallet is checked at this call')
    expect(described[0]).toContain('reads one public balance')
    expect(described[0]).toContain('Nothing is reserved, held or taken')
  })

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
   * **Two tests about a balance stood here** (`#553`, D-106).
   *
   * One read `kolonie.quests.balance` before and after a submission and watched
   * the reservation appear; the other asserted that a sponsor with nothing was
   * refused and nothing was reserved. Both read a tool that is gone with the
   * balance it reported: a citizen is paid in SOL to a wallet the Colony has no
   * key to, and a quest is invoiced from the sponsor's own after publication.
   *
   * The refusal at submission still exists — `submitQuestForReview` still books
   * a reservation and still refuses what the ledger cannot cover — and it is
   * asserted where it lives, in `packages/db`. What went is the surface that
   * reported it.
   */

  it('changes a draft it has not submitted', async () => {
    const sponsor = anAgent()

    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    const changed = await call(sponsor.key, 'kolonie.quests.update', {
      questId: id,
      title: 'A hundred registrations',
    })

    expect(changed.isError).toBeFalsy()
    expect(structured(changed)).toEqual({
      status: 'draft',
      changes: [
        {
          field: 'title',
          from: 'A thousand registrations',
          to: 'A hundred registrations',
        },
      ],
    })
    expect(JSON.stringify(changed.content)).toContain('title: from')
    expect(JSON.stringify(changed.content)).toContain('kolonie.quests.read')
    expect(structured(changed)).not.toHaveProperty('quest')
    expect(structured(changed)).not.toHaveProperty('preview')
    const read = await call(sponsor.key, 'kolonie.quests.read', { questId: id })
    expect((structured(read).quest as unknown as { title: string }).title).toBe(
      'A hundred registrations',
    )
  })

  it.each([
    ['write', () => aDraft({ mustNotHold: ['email-send'] })],
    ['update', (questId: TaskId) => ({ questId, timeoutHours: 96, mustNotHold: ['email-send'] })],
  ] as const)('refuses an unknown field on %s by name', async (tool, argumentsFor) => {
    const sponsor = anAgent()
    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id

    const refused = await call(sponsor.key, `kolonie.quests.${tool}`, argumentsFor(id))

    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('`mustNotHold` is not a field of a quest')
    expect(JSON.stringify(refused.content)).toContain('Targeting is positive-only')
  })

  it('refuses a full read round-tripped as an update, naming the read-only fields', async () => {
    const sponsor = anAgent()
    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    const read = await call(sponsor.key, 'kolonie.quests.read', { questId: id })

    const refused = await call(sponsor.key, 'kolonie.quests.update', {
      ...(structured(read).quest as unknown as Record<string, unknown>),
      questId: id,
      title: 'A hundred registrations',
    })

    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('`status` is not a field of a quest')
  })

  it('reports a no-op update without repeating the quest', async () => {
    const sponsor = anAgent()
    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id

    const changed = await call(sponsor.key, 'kolonie.quests.update', {
      questId: id,
      title: 'A thousand registrations',
    })

    expect(structured(changed)).toEqual({ status: 'draft', changes: [] })
    expect(JSON.stringify(changed.content)).toContain('No fields changed')
    expect(JSON.stringify(changed)).not.toContain('What happened when you registered?')
    expect(JSON.stringify(changed)).not.toContain(
      'Register at the address in the brief and report what happened.',
    )
  })

  it('submits with only the status, commitment total, and next step', async () => {
    const sponsor = anAgent()
    quests.credit(sponsor.id, 7_000_000)
    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id

    const submitted = await call(sponsor.key, 'kolonie.quests.submit', { questId: id })

    expect(structured(submitted)).toEqual({
      status: 'pending_review',
      commitment: 7_000_000,
      next: 'The Colony is checking it; nothing waits on you.',
    })
    expect(JSON.stringify(submitted.content)).toContain('kolonie.quests.read')
    expect(structured(submitted)).not.toHaveProperty('quest')
    expect(structured(submitted)).not.toHaveProperty('preview')
    expect(JSON.stringify(submitted)).not.toContain('What happened when you registered?')
    expect(JSON.stringify(submitted)).not.toContain(
      'Register at the address in the brief and report what happened.',
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
    // Not a test about the floor: it prices an answer in single lamports so the
    // arithmetic is readable, which `#743` would refuse. Zero is the setting's
    // own way of being off.
    quests.setPriceFloor(0)
    const sponsor = anAgent()
    quests.credit(sponsor.id, 500)

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ reward: { reputation: 0, lamports: 15 }, slots: 20, publishObstacles: true }),
    )

    // 20 × 15 for the answers, and that is the whole of it (D-114, `#752`). It
    // was 309 while a quest carried a second price — nine of obstacle pool held
    // on top of the capacity.
    // The commitment is the cost and nothing else since `#553`: `available` and
    // `affordable` read a balance the Colony does not hold.
    expect(structured(written).commitment).toMatchObject({ cost: 300 })
    expect(String(structured(written).preview)).toContain('A thousand registrations')
    expect(JSON.stringify(written.content)).toContain('300')
  })

  /**
   * A sponsor may keep its obstacles unpublished, and learns what that costs at
   * the moment it chooses — not when nobody answers (`#370`).
   *
   * The cost is not a figure the Colony can compute, so the assertion is on the
   * sentence: every citizen after the first pays the discovery cost again.
   */
  it('says what withholding the obstacles costs, in the answer that took the decision', async () => {
    const sponsor = anAgent()

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ publishObstacles: false }),
    )

    const said = JSON.stringify(written.content)
    expect(said).toContain('pays the discovery cost again')
    expect(said).toContain('You still read every obstacle report in full')
    expect(
      (structured(written).quest as unknown as { publishObstacles: boolean }).publishObstacles,
    ).toBe(false)
  })

  /**
   * The sponsor sees what the obstacle bonus costs it **at the moment it commits
   * the quest** (`#371`) — a sponsor discovering afterwards that its escrow paid
   * for something it did not ask for is the failure `#323` exists to prevent.
   */
  /**
   * **This asserted the opposite until D-114 (`#752`)**: that the obstacle pool
   * was named in the commitment before anything was irreversible, which was the
   * right rule for a price that existed. It does not exist, and a sponsor that
   * publishes its obstacles is committing to exactly what one that does not is.
   */
  it('names no obstacle pool, because publishing obstacles costs nothing', async () => {
    // Not a test about the floor: it prices an answer in single lamports so the
    // arithmetic is readable, which `#743` would refuse. Zero is the setting's
    // own way of being off.
    quests.setPriceFloor(0)
    const sponsor = anAgent()
    quests.credit(sponsor.id, 500)

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ reward: { reputation: 0, lamports: 10 }, slots: 10, publishObstacles: true }),
    )

    expect(structured(written).commitment).toMatchObject({ cost: 100 })
    const said = JSON.stringify(written.content)
    expect(said).toContain('100')
    expect(said).not.toContain('lamports of that is for the first')
  })

  it('holds no pool, and says nothing, for a sponsor that kept its obstacles', async () => {
    // Not a test about the floor: it prices an answer in single lamports so the
    // arithmetic is readable, which `#743` would refuse. Zero is the setting's
    // own way of being off.
    quests.setPriceFloor(0)
    const sponsor = anAgent()
    quests.credit(sponsor.id, 500)

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ reward: { reputation: 0, lamports: 10 }, slots: 10, publishObstacles: false }),
    )

    expect(structured(written).commitment).toMatchObject({ cost: 100 })
    expect(JSON.stringify(written.content)).not.toContain('is for the first 3 citizens')
  })

  /**
   * And the default says nothing, which is the same rule the activity window
   * follows: a sponsor that changed nothing is warned about nothing.
   */
  it('publishes by default, and warns a sponsor that chose the default about nothing', async () => {
    const sponsor = anAgent()

    // The field withheld rather than set, since the subject is the schema's own
    // default and {@link aDraft} turns obstacles off to keep the floor out of the
    // way of tests that are about something else. Priced at four times the floor,
    // which is what the obstacle bonus the default turns on costs (`#743`).
    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ publishObstacles: undefined, reward: { reputation: 5, lamports: 4_000_000 } }),
    )

    expect(
      (structured(written).quest as unknown as { publishObstacles: boolean }).publishObstacles,
    ).toBe(true)
    // The withholding warning by its own words rather than by `discovery cost`,
    // which the obstacle pool a priced quest now holds also uses — for the
    // opposite thing: what those three citizens spare everybody else.
    expect(JSON.stringify(written.content)).not.toContain('pays the discovery cost again')
  })

  /**
   * **The behaviour on changing it after answers exist**, which `#370` asks to
   * be stated and tested rather than discovered.
   *
   * It is refused, and the refusal is the one every frozen field already gets:
   * flipping publication mid-flight splits the cohort into citizens who answered
   * with a briefing and citizens who answered without one, and afterwards
   * nothing in the data says which was which. A change is a new quest.
   */
  it('refuses to change publication once the quest is published', async () => {
    const sponsor = anAgent()
    quests.credit(sponsor.id, 100)

    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    await call(sponsor.key, 'kolonie.quests.submit', { questId: id })
    quests.publish(id)

    const changed = await call(sponsor.key, 'kolonie.quests.update', {
      questId: id,
      publishObstacles: false,
    })

    expect(changed.isError).toBeTruthy()
    expect(JSON.stringify(changed.content)).toContain('only a draft or a refused quest')
  })

  /**
   * The cost of the money was stated at the moment it was committed; the cost of
   * a requirement was stated nowhere (`#351`). A sponsor that narrowed its
   * audience found out when nobody answered, weeks later.
   */
  it('states what the requirement costs in reach, in the answer that took the decision', async () => {
    const sponsor = anAgent()

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ requires: ['browser', 'mailbox'], proofVerifier: 'email-inbox' }),
    )

    const audience = structured(written).audience as unknown as {
      reach: { kind: string; citizens: number }
      unrestricted: { kind: string; citizens: number }
      requires: readonly string[]
      sentence: string
    }
    expect(audience.requires).toEqual(['browser', 'mailbox'])
    expect(audience.reach).toEqual({ kind: 'exact', citizens: FAKE_AUDIENCE })
    expect(audience.unrestricted).toEqual({ kind: 'exact', citizens: FAKE_AUDIENCE })
    // The text is what a model acts on, so the sentence has to be in it.
    expect(JSON.stringify(written.content)).toContain('With browser, mailbox required')
    expect(JSON.stringify(written.content)).toContain('may attempt this quest')
    expect(JSON.stringify(written.content)).toContain(
      'The `proofVerifier` is not included in this reach',
    )
    expect(JSON.stringify(written.content)).toContain(
      '`email-inbox` is checked when an answer is handed in',
    )
    expect(JSON.stringify(written.content)).toContain('with no requirement')
  })

  /**
   * A field that only appears once you have used it is a field you have to know
   * about already — which is the complaint `#352` makes about `requires_skills`.
   */
  it('answers with an audience for a quest that requires nothing', async () => {
    const sponsor = anAgent()

    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())

    const audience = structured(written).audience as unknown as {
      requires: readonly string[]
      sentence: string
    }
    expect(audience.requires).toEqual([])
    expect(audience.sentence).toContain('anyone this quest is offered to may attempt')
  })

  it('recomputes the reach when an update changes the requirement', async () => {
    const sponsor = anAgent()
    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id

    const changed = await call(sponsor.key, 'kolonie.quests.update', {
      questId: id,
      requires: ['browser'],
    })

    expect(structured(changed).changes).toEqual([{ field: 'requires', from: [], to: ['browser'] }])
    expect(
      (structured(changed).audience as unknown as { requires: readonly string[] }).requires,
    ).toEqual(['browser'])
    expect(structured(changed).commitment).toMatchObject({ cost: 7_000_000 })
    expect(structured(changed)).not.toHaveProperty('quest')
    expect(structured(changed)).not.toHaveProperty('preview')
    expect(JSON.stringify(changed.content)).toContain('With browser required')
  })

  /** A count small enough to name a citizen is never a number a sponsor reads. */
  it('suppresses a reach below the floor rather than naming a population of one', async () => {
    const sponsor = anAgent()
    quests.countAudienceAs(1)

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ requires: ['browser'] }),
    )

    expect((structured(written).audience as unknown as { reach: unknown }).reach).toEqual({
      kind: 'fewer-than',
      citizens: AUDIENCE_FLOOR,
    })
    expect(JSON.stringify(written.content)).toContain(`fewer than ${AUDIENCE_FLOOR} citizens`)
  })

  /**
   * The field existed with a default of `[]` and was mentioned nowhere (`#352`).
   * A sponsor is an agent, and an agent optimises toward what it is shown — a
   * default nobody is shown keeps its value for ever.
   */
  it('tells a sponsor what requires buys, what it costs, and what may be asked for', async () => {
    const { client, close } = await connectedClient(colony(), `Bearer ${anAgent().key}`)
    try {
      const { tools } = await client.listTools()
      const write = tools.find((tool) => tool.name === 'kolonie.quests.write')
      const requires = (write?.inputSchema.properties as Record<string, { description?: string }>)[
        'requires'
      ]
      const text = String(requires?.description)

      expect(text).toContain('decision')
      // Both directions, which is what makes it a decision rather than a warning.
      expect(text).toContain('prerequisite')
      expect(text).toContain('audience shrinks')
      // The vocabulary, so a sponsor never has to guess at a slug.
      for (const skill of SKILLS_THE_ACADEMY_GRANTS) expect(text).toContain(skill)
    } finally {
      await close()
    }
  })

  /**
   * The rejection case. A requirement nobody can hold produces a well-formed
   * quest that publishes normally and is offered to no one — silent at every
   * stage and visible only at expiry.
   */
  it('refuses a requirement naming a skill the Academy does not grant', async () => {
    const sponsor = anAgent()

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ requires: ['mailbocks'] }),
    )

    expect(written.isError).toBe(true)
    expect(JSON.stringify(written.content)).toContain('mailbocks')
    expect(JSON.stringify(written.content)).toContain('offered to nobody')
  })

  it('refuses the same requirement arriving as an update', async () => {
    const sponsor = anAgent()
    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id

    const changed = await call(sponsor.key, 'kolonie.quests.update', {
      questId: id,
      requires: ['coordination'],
    })

    expect(changed.isError).toBe(true)
    expect(JSON.stringify(changed.content)).toContain('coordination')
  })

  /**
   * **`says the draft is unaffordable at the moment it is written` stood here**
   * (`#553`, D-106). It asserted `affordable: false` on a 3,021-credit draft
   * from a sponsor holding 500, and the sentence *more than you can currently
   * pay*. The Colony cannot see what a sponsor holds — the money is in a wallet
   * it has no key to — so the honest answer is the cost, which the tests above
   * assert, and the invoice, which arrives after a steward publishes.
   */

  it('withdraws a quest from review, freeing the slot', async () => {
    // Not a test about the floor: it prices an answer in single lamports so the
    // arithmetic is readable, which `#743` would refuse. Zero is the setting's
    // own way of being off.
    quests.setPriceFloor(0)
    const sponsor = anAgent()
    quests.credit(sponsor.id, 1_000)

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ reward: { reputation: 0, lamports: 10 }, slots: 5 }),
    )
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    await call(sponsor.key, 'kolonie.quests.submit', { questId: id })

    const withdrawn = await call(sponsor.key, 'kolonie.quests.withdraw', { questId: id })

    // The reservation is no longer readable from a tool (`#553`); the status is
    // what a sponsor experiences, and the freed slot is asserted below.
    expect(withdrawn.isError).toBeFalsy()
    expect((structured(withdrawn).quest as unknown as { status: string }).status).toBe('draft')

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

/**
 * The payout floor over MCP (`#743`).
 *
 * The rule itself is `packages/core`'s and is measured there. What is worth a
 * round trip is that it reaches a sponsor on **every** way in — including the
 * one that had no reward check at all, `kolonie.quests.slots`.
 */
describe('the floor a sponsor meets', () => {
  /** {@link aDraft} is already colony-judged with obstacles off; only the price varies. */
  const priced = (lamports: number, overrides: Record<string, unknown> = {}) =>
    aDraft({ reward: { reputation: 0, lamports }, ...overrides })

  const write = async (key: string, lamports: number, overrides = {}) =>
    call(key, 'kolonie.quests.write', priced(lamports, overrides))

  it('refuses a draft one lamport under the boundary and takes it at the boundary', async () => {
    const sponsor = anAgent()

    const under = await write(sponsor.key, 1_333_332)
    const at = await write(sponsor.key, 1_333_333)

    expect(under.isError).toBe(true)
    expect(JSON.stringify(under.content)).toContain('1333333')
    expect(at.isError).toBeFalsy()
  })

  /** A draft written high and edited down is the way round the check at write. */
  it('refuses the same price arriving as an update', async () => {
    const sponsor = anAgent()

    const written = await write(sponsor.key, 1_333_333)
    const id = (structured(written).quest as unknown as { id: TaskId }).id

    const lowered = await call(sponsor.key, 'kolonie.quests.update', {
      questId: id,
      reward: { reputation: 0, lamports: 1_333_332 },
    })

    expect(lowered.isError).toBe(true)
    expect(JSON.stringify(lowered.content)).toContain('may not promise')
  })

  /** And a floor raised after the draft was written applies at submission. */
  it('refuses at submission a draft the floor overtook', async () => {
    const sponsor = anAgent()

    const written = await write(sponsor.key, 1_333_333)
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    quests.setPriceFloor(2_000_000)

    const submitted = await call(sponsor.key, 'kolonie.quests.submit', { questId: id })

    expect(submitted.isError).toBe(true)
    expect(JSON.stringify(submitted.content)).toContain('2000000')
  })

  /**
   * **The 3× jump D-114 removed** (`#752`). 1,400,000 passed the answer
   * condition and failed the obstacle one, so the refusal had to name which of
   * the two had failed and offer `publishObstacles: false` as a second way
   * through — and a sponsor that left the default on paid 4,000,000 a slot
   * against 1,333,333. `publishObstacles` changes no price now.
   */
  it('holds a quest publishing its obstacles to the same floor as one that is not', async () => {
    const sponsor = anAgent()

    expect((await write(sponsor.key, 1_400_000, { publishObstacles: true })).isError).toBeFalsy()

    const refused = await write(anAgent().key, 1_000_000, { publishObstacles: true })
    expect(refused.isError).toBe(true)
    const said = JSON.stringify(refused.content)
    expect(said).toContain('an accepted answer is paid')
    expect(said).not.toContain('publishObstacles')
  })

  /**
   * The floor measures lamports and says nothing about reputation, so a quest
   * paying none is past it before it is read — `#744`'s separate rule is what
   * catches it. Read off the sentence rather than a role: `#947` deleted the
   * bypass this used to be written through, and which of the two rules answered
   * is the only thing left that tells them apart.
   */
  it('is not the rule that catches a quest paying reputation alone', async () => {
    const refused = await call(
      anAgent().key,
      'kolonie.quests.write',
      aDraft({ reward: { reputation: 5, lamports: 0 } }),
    )

    expect(refused.isError).toBe(true)
    const said = JSON.stringify(refused.content)
    expect(said).toContain('kolonie.support.open')
    expect(said).not.toContain('an accepted answer is paid')
  })

  /**
   * The one case the floor is retroactive about, and deliberately: a quest
   * published before it exists keeps every place already bought, and cannot buy
   * another. Anything already owed stays owed (D-106).
   */
  it('refuses more capacity on a quest published below the floor, leaving what it has', async () => {
    const sponsor = anAgent()
    quests.credit(sponsor.id, 100_000_000)
    quests.setPriceFloor(0)

    const written = await write(sponsor.key, 400_000)
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    await call(sponsor.key, 'kolonie.quests.submit', { questId: id })
    quests.publish(id)

    quests.setPriceFloor(1_000_000)
    const bought = await call(sponsor.key, 'kolonie.quests.slots', { questId: id, slots: 3 })

    expect(bought.isError).toBe(true)
    const said = JSON.stringify(bought.content)
    expect(said).toContain('cannot be topped up')
    expect(said).toContain('stays answerable')

    const read = await call(sponsor.key, 'kolonie.quests.read', { questId: id })
    expect((structured(read).quest as unknown as { slots: number }).slots).toBe(5)
  })

  it('sells capacity on a quest that is above the floor', async () => {
    const sponsor = anAgent()
    quests.credit(sponsor.id, 100_000_000)

    const written = await write(sponsor.key, 1_333_333)
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    await call(sponsor.key, 'kolonie.quests.submit', { questId: id })
    quests.publish(id)

    expect(
      (await call(sponsor.key, 'kolonie.quests.slots', { questId: id, slots: 3 })).isError,
    ).toBeFalsy()
  })

  it('is off entirely at a floor of zero', async () => {
    const sponsor = anAgent()
    quests.setPriceFloor(0)

    expect((await write(sponsor.key, 1)).isError).toBeFalsy()
  })
})

/**
 * Who may publish a quest that pays no lamports (`#744`).
 *
 * The floor above says what a paying quest must reach. This says that zero is not
 * a way underneath it: a quest promising nothing is the Colony's own to ask, and a
 * citizen is offered both ways forward rather than told it lacks a role.
 *
 * Since `#947` no citizen holds a way through, whatever it holds — the sentence
 * about the two routes is now the only answer this gate ever gives.
 */
describe('the quest that pays nothing', () => {
  const unpaid = (overrides: Record<string, unknown> = {}) =>
    aDraft({ reward: { reputation: 5, lamports: 0 }, ...overrides })

  it('refuses a citizen, naming the price that would clear and the other way round', async () => {
    const refused = await call(anAgent().key, 'kolonie.quests.write', unpaid())

    expect(refused.isError).toBe(true)
    const said = JSON.stringify(refused.content)
    // The figure the floor would take, so the sponsor is not left to derive it,
    // and the route that does not need a price at all.
    expect(said).toContain('1333333')
    expect(said).toContain('kolonie.support.open')
  })

  it('takes the same quest from the same citizen once it is priced', async () => {
    const sponsor = anAgent()

    expect((await call(sponsor.key, 'kolonie.quests.write', unpaid())).isError).toBe(true)
    expect((await call(sponsor.key, 'kolonie.quests.write', aDraft())).isError).toBeFalsy()
  })

  /**
   * **No role buys the way past it** (`#947`). `steward` did, and that was the
   * one thing the shrink to a lever deleted rather than renamed: a role kept for
   * emergencies must not also be a discount, or the next holder learns it from
   * what it can do. The Colony's own zero is a row with no author and never
   * reaches this function, so nothing it needs was lost with the bypass.
   */
  it('refuses the holder of the one privileged role exactly as it refuses anyone', async () => {
    const refused = await call(anAgent(['warden']).key, 'kolonie.quests.write', unpaid())

    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('kolonie.support.open')
  })

  /** Priced at write and edited down to nothing is the way round a gate that only reads the write. */
  it('refuses a citizen that edits a priced draft down to nothing', async () => {
    const sponsor = anAgent()

    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id

    const lowered = await call(sponsor.key, 'kolonie.quests.update', {
      questId: id,
      reward: { reputation: 5, lamports: 0 },
    })

    expect(lowered.isError).toBe(true)
    expect(JSON.stringify(lowered.content)).toContain('kolonie.support.open')
  })

  /** Off with the floor, because gating zero while a single lamport passes is theatre. */
  it('is off entirely at a floor of zero', async () => {
    quests.setPriceFloor(0)

    expect((await call(anAgent().key, 'kolonie.quests.write', unpaid())).isError).toBeFalsy()
  })
})

/**
 * What became of one transfer a sponsor sent (`#760`).
 *
 * **The case it exists for is the payment that reached no quest.** A quarantined
 * row carries no `agent_id` — the check constraint forbids one, and quarantine
 * happens precisely because the sending address is not one any citizen proved —
 * so it is attributed to no quest and no citizen, and no quest-keyed answer can
 * ever carry it. Before this, finding out took a steward.
 */
describe('asking what became of a transfer', () => {
  const textOf = (result: Awaited<ReturnType<typeof call>>) =>
    (result.content as Array<{ text: string }>)[0]?.text ?? ''

  it('says a signature it has not recorded is not recorded, without implying the money is gone', async () => {
    const result = await call(anAgent().key, 'kolonie.quests.payment', {
      signature: 'a-signature-nobody-sent',
    })

    expect(structured(result)).toMatchObject({ outcome: 'unseen' })
    // The two ordinary reasons, because a sponsor reading *not seen* one minute
    // after sending will otherwise send the money a second time.
    expect(textOf(result)).toContain('finalized')
    expect(textOf(result)).toContain('hour')
  })

  it('names the amount and both dates once the payment became the sponsor’s money', async () => {
    const sponsor = anAgent()
    paymentDesk.hold({
      signature: 'a-credited-signature',
      agentId: sponsor.id,
      lamports: 2_500_000,
      attributedAt: '2026-08-07T15:52:04.000Z',
    })

    const result = await call(sponsor.key, 'kolonie.quests.payment', {
      signature: 'a-credited-signature',
    })

    expect(structured(result)).toMatchObject({
      outcome: 'credited',
      lamports: 2_500_000,
      attributedAt: '2026-08-07T15:52:04.000Z',
    })
  })

  /**
   * The whole point: the sending address, the cause, and the two ways out —
   * none of which a sponsor could reach without asking a maintainer.
   */
  it('tells a sponsor its payment is held, from where, and what to do about it', async () => {
    paymentDesk.hold({
      signature: 'a-held-signature',
      sender: 'an-exchange-hot-wallet',
      quarantine: 'unverified-sender',
    })

    const result = await call(anAgent().key, 'kolonie.quests.payment', {
      signature: 'a-held-signature',
    })

    expect(structured(result)).toMatchObject({
      outcome: 'held',
      sender: 'an-exchange-hot-wallet',
      quarantine: 'unverified-sender',
      settled: false,
    })
    expect(textOf(result)).toContain('an-exchange-hot-wallet')
    expect(textOf(result)).toContain('solana-wallet')
  })

  /**
   * **A signature is public**, copyable off any explorer by anybody. Answering
   * *that one is somebody else's* would make this a way to ask whether a named
   * citizen has paid the Colony, so attributed-to-another and never-seen are one
   * answer — the `NO_SUCH_QUEST` idiom, for the same reason.
   */
  it('answers about another citizen’s payment exactly as about one it never saw', async () => {
    const sponsor = anAgent()
    const stranger = anAgent()
    paymentDesk.hold({
      signature: 'somebody-elses-signature',
      agentId: sponsor.id,
      attributedAt: '2026-08-07T15:52:04.000Z',
    })

    const mine = await call(stranger.key, 'kolonie.quests.payment', {
      signature: 'somebody-elses-signature',
    })
    const neither = await call(stranger.key, 'kolonie.quests.payment', {
      signature: 'a-signature-nobody-sent',
    })

    expect(structured(mine)).toMatchObject({ outcome: 'unseen' })
    // Byte equality but for the signature echoed back: two different answers
    // would be the disclosure, however politely each was worded.
    expect(textOf(mine).replace('somebody-elses-signature', 'a-signature-nobody-sent')).toBe(
      textOf(neither),
    )
  })

  /** A held row is attributed to nobody, so there is no citizen for it to be about. */
  it('answers a held payment to whoever knows its signature', async () => {
    paymentDesk.hold({ signature: 'a-held-signature', quarantine: 'colony-sender' })

    const result = await call(anAgent().key, 'kolonie.quests.payment', {
      signature: 'a-held-signature',
    })

    expect(structured(result)).toMatchObject({ outcome: 'held', quarantine: 'colony-sender' })
  })

  it('points a sponsor at support once a maintainer has settled the hold', async () => {
    paymentDesk.hold({
      signature: 'a-settled-signature',
      quarantine: 'unverified-sender',
      resolvedAt: '2026-08-09T09:00:00.000Z',
      resolution: 'refunded',
    })

    const result = await call(anAgent().key, 'kolonie.quests.payment', {
      signature: 'a-settled-signature',
    })

    expect(structured(result)).toMatchObject({ outcome: 'held', settled: true })
    expect(textOf(result)).toContain('kolonie.support.open')
    // What was decided is not published here: the row carries a maintainer's
    // note, and a sponsor reading it would be reading an internal one.
    expect(textOf(result)).not.toContain('refunded')
  })

  /**
   * Registered only where a payment desk is wired, which is D-013's way of
   * switching a surface off. A deployment with no wallet has no arrivals.
   */
  it('does not exist in a Colony with no wallet', async () => {
    const { paymentDesk: _absent, ...withoutWallet } = colony()
    const { client, close } = await connectedClient(withoutWallet, `Bearer ${anAgent().key}`)

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.quests.payment')
    await close()
  })
})

describe('the warden tier', () => {
  it('is absent from an ordinary sponsor’s tool list', async () => {
    const sponsor = anAgent()
    const { client, close } = await connectedClient(colony(), `Bearer ${sponsor.key}`)

    const listing = await client.listTools()
    const names = listing.tools.map((tool) => tool.name)

    expect(names.sort()).toEqual([...UNAUTHENTICATED_TOOLS, ...AUTHENTICATED_TOOLS].sort())
    // Not merely absent from the names — absent from the listing altogether, so
    // no description names a tool this caller cannot reach.
    for (const tool of WARDEN_TOOLS) expect(JSON.stringify(listing)).not.toContain(tool)
    await close()
  })

  it('appears for a caller that holds the role', async () => {
    const warden = anAgent(['warden'])
    const { client, close } = await connectedClient(
      colony(),
      `Bearer ${warden.key}`,
      undefined,
      true,
    )

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...UNAUTHENTICATED_TOOLS, ...AUTHENTICATED_TOOLS, ...WARDEN_TOOLS].sort(),
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

    const result = await call(
      sponsor.key,
      'kolonie.quests.end',
      { questId: crypto.randomUUID(), reason: 'A sponsor may not end a quest it did not write.' },
      true,
    )

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('forbidden')
  })

  it('ends a live quest with a reason citizens can read', async () => {
    const sponsor = anAgent()
    const warden = anAgent(['warden'])
    quests.credit(sponsor.id, 100)

    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    await call(sponsor.key, 'kolonie.quests.submit', { questId: id })
    quests.publish(id)

    const reason = 'The automatic publication was mistaken and the quest must stop.'
    const ended = await call(warden.key, 'kolonie.quests.end', { questId: id, reason }, true)

    expect(ended.isError).toBeFalsy()
    expect(structured(ended)).toMatchObject({
      quest: { quest: { id, status: 'retired', endedReason: reason } },
      attemptsStillOpen: 0,
      escrow: 'not-returned',
    })
    expect(JSON.stringify(ended.content)).toContain('Nothing is refunded')
  })

  it('does not let an ordinary caller invoke the ending tool even when it is registered', async () => {
    const sponsor = anAgent()

    const ended = await call(
      sponsor.key,
      'kolonie.quests.end',
      {
        questId: '018f0f91-c913-7aa3-a92d-47c4b462c180',
        reason: 'This caller does not hold the warden role.',
      },
      true,
    )

    expect(ended.isError).toBe(true)
    expect(JSON.stringify(ended.content)).toContain('forbidden')
  })

  it('requires a reason for ending a quest', async () => {
    const warden = anAgent(['warden'])

    const ended = await call(
      warden.key,
      'kolonie.quests.end',
      { questId: '018f0f91-c913-7aa3-a92d-47c4b462c180' },
      true,
    )

    expect(ended.isError).toBe(true)
  })

  /**
   * **`#353`'s flag has no surface here any more** (`#723`). It named quests
   * asking for a browser, an address, a wallet or a domain while requiring no
   * skill, and it was shown beside the review queue — which is gone, because a
   * quest that clears moderation is published by that verdict (`#693`).
   * `capabilityMismatches` is untouched in `packages/core` and still has its own
   * tests; what it lost is a reader. `kolonie-platform#694` is where a
   * judgement about a quest's answerability belongs now, and this comment is
   * here so the flag is picked up again rather than quietly forgotten.
   */
})

/**
 * A quest's funding is checked before it is moderated, and only then — D-115
 * (`#751`).
 *
 * Every test here is about the *submission*, because that is where the check
 * sits and where a refusal costs the Colony nothing. The draft is written first
 * with the desk answering `unknown`, which is what a deployment with no endpoint
 * answers and what lets a test about something else stay about something else.
 */
describe('whether the sponsor can pay, asked before a steward reads it', () => {
  const priced = (lamports: number, slots = 5) =>
    aDraft({ reward: { reputation: 0, lamports }, slots })

  /** A draft that costs `lamports × slots`, ready to submit. */
  const drafted = async (key: string, lamports = 1_400_000, slots = 5) => {
    const written = await call(key, 'kolonie.quests.write', priced(lamports, slots))
    expect(written.isError).toBeFalsy()

    return (structured(written).quest as unknown as { id: TaskId }).id
  }

  const submit = (key: string, questId: TaskId) => call(key, 'kolonie.quests.submit', { questId })

  const wallet = 'So1anaAddressOfTheSponsor11111111111111111'

  it('refuses a submission the proved wallet cannot cover, and names the shortfall', async () => {
    const sponsor = anAgent()
    const id = await drafted(sponsor.key)
    quests.setSponsorFunding({ outcome: 'known', address: wallet, lamports: 1_000_000 })

    const refused = await submit(sponsor.key, id)

    expect(refused.isError).toBe(true)
    const said = JSON.stringify(refused.content)
    // 5 × 1,400,000 = 7,000,000 invoiced against 0.001 SOL held.
    expect(said).toContain('0.007 SOL')
    expect(said).toContain('SOL short')
    expect(said).toContain('the draft is untouched')
  })

  it('refuses a sponsor that has proved no wallet, and names the rung', async () => {
    const sponsor = anAgent()
    const id = await drafted(sponsor.key)
    quests.setSponsorFunding({ outcome: 'no-wallet' })

    const refused = await submit(sponsor.key, id)

    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('solana-wallet rung')
  })

  it('takes a submission from a wallet that covers the invoice and its fee', async () => {
    const sponsor = anAgent()
    quests.credit(sponsor.id, 100_000_000)
    const id = await drafted(sponsor.key)
    quests.setSponsorFunding({ outcome: 'known', address: wallet, lamports: 100_000_000 })

    expect((await submit(sponsor.key, id)).isError).toBeFalsy()
  })

  /**
   * **The deployment that cannot ask.** No `RPC_URL` means the desk carries no
   * `sponsorFunding` at all, exactly as an absent wallet address means no
   * invoice is shown — and every submission that was accepted before is still
   * accepted.
   */
  it('takes a submission when the desk cannot answer the question', async () => {
    const sponsor = anAgent()
    quests.credit(sponsor.id, 100_000_000)
    const id = await drafted(sponsor.key)

    expect((await submit(sponsor.key, id)).isError).toBeFalsy()
  })

  /**
   * **The outage rule, and the one a refactor is most likely to break silently.**
   * `state/decisions/the-colony-judges-its-own-quests.md`: an outage must never
   * turn away a sponsor who did nothing wrong. An endpoint that throws has told
   * the Colony nothing, and nothing is not zero.
   */
  it('takes a submission when the balance read failed', async () => {
    const sponsor = anAgent()
    quests.credit(sponsor.id, 100_000_000)
    const id = await drafted(sponsor.key)
    quests.setSponsorFunding({ outcome: 'unknown' })

    expect((await submit(sponsor.key, id)).isError).toBeFalsy()
  })

  /**
   * `questNeedsInvoice(0)` is false, so an empty wallet buys a free quest fine.
   *
   * At a floor of zero because that is the only state a zero-lamport quest exists
   * in now — `#947` deleted the role that used to be written through here, and a
   * floor of zero is the deployment saying it is not policing what a quest
   * promises. The invoice rule is what is under test either way.
   */
  it('asks nothing of a quest that pays reputation only', async () => {
    quests.setPriceFloor(0)
    const sponsor = anAgent()
    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ reward: { reputation: 5, lamports: 0 } }),
    )
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    quests.setSponsorFunding({ outcome: 'no-wallet' })

    expect((await submit(sponsor.key, id)).isError).toBeFalsy()
  })

  /**
   * **The top-up, on the same terms** (`#629`). The invoice is the places being
   * bought at the quest's own frozen price — 3 × 1,400,000 — and not the whole
   * quest, which the sponsor has already paid for.
   */
  describe('and the same question when more capacity is bought', () => {
    const published = async (key: string) => {
      const id = await drafted(key)
      expect((await submit(key, id)).isError).toBeFalsy()
      quests.publish(id)

      return id
    }

    it('refuses more places than the proved wallet can cover', async () => {
      const sponsor = anAgent()
      quests.credit(sponsor.id, 100_000_000)
      const id = await published(sponsor.key)
      quests.setSponsorFunding({ outcome: 'known', address: wallet, lamports: 1_000_000 })

      const bought = await call(sponsor.key, 'kolonie.quests.slots', { questId: id, slots: 3 })

      expect(bought.isError).toBe(true)
      // 3 × 1,400,000, the places being bought — not the whole quest again.
      expect(JSON.stringify(bought.content)).toContain('0.0042 SOL')
    })

    it('sells them to a wallet that covers them', async () => {
      const sponsor = anAgent()
      quests.credit(sponsor.id, 100_000_000)
      const id = await published(sponsor.key)
      quests.setSponsorFunding({ outcome: 'known', address: wallet, lamports: 100_000_000 })

      expect(
        (await call(sponsor.key, 'kolonie.quests.slots', { questId: id, slots: 3 })).isError,
      ).toBeFalsy()
    })

    it('sells them when the Colony could not ask', async () => {
      const sponsor = anAgent()
      quests.credit(sponsor.id, 100_000_000)
      const id = await published(sponsor.key)
      quests.setSponsorFunding({ outcome: 'unknown' })

      expect(
        (await call(sponsor.key, 'kolonie.quests.slots', { questId: id, slots: 3 })).isError,
      ).toBeFalsy()
    })
  })
})

/**
 * A sponsor cannot buy more answers than there are citizens to give them —
 * D-116 (`#754`).
 */
describe('capacity a quest cannot reach', () => {
  const wallet = 'So1anaAddressOfTheSponsor11111111111111111'

  const drafted = async (key: string, slots: number) => {
    const written = await call(
      key,
      'kolonie.quests.write',
      aDraft({ reward: { reputation: 0, lamports: 1_400_000 }, slots }),
    )
    expect(written.isError).toBeFalsy()

    return (structured(written).quest as unknown as { id: TaskId }).id
  }

  const submit = (key: string, questId: TaskId) => call(key, 'kolonie.quests.submit', { questId })

  it('refuses a submission buying more answers than citizens who can give them', async () => {
    const sponsor = anAgent()
    quests.credit(sponsor.id, 1_000_000_000)
    const id = await drafted(sponsor.key, 3)
    quests.countAudienceAs(2)

    const refused = await submit(sponsor.key, id)

    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('3 answers')
  })

  /**
   * **The acceptance criterion this issue turns on.** The refusal is a bounded
   * leak — one inequality about a figure the sponsor chose — and it stops being
   * bounded the moment the count or the shortfall appears anywhere in the
   * answer, structured half included.
   */
  it('prints neither the reach nor the shortfall anywhere in the answer', async () => {
    const sponsor = anAgent()
    quests.credit(sponsor.id, 1_000_000_000)
    const id = await drafted(sponsor.key, 9)
    quests.countAudienceAs(2)

    const said = JSON.stringify(await submit(sponsor.key, id))

    expect(said).toContain('9 answers')
    // The count, and 9 − 2. Neither is the sponsor's to know.
    expect(said).not.toContain('2 citizens')
    expect(said).not.toContain(' 7 ')
  })

  it('takes a submission whose capacity is at the reach', async () => {
    const sponsor = anAgent()
    quests.credit(sponsor.id, 1_000_000_000)
    quests.setSponsorFunding({ outcome: 'known', address: wallet, lamports: 1_000_000_000 })
    const id = await drafted(sponsor.key, 2)
    quests.countAudienceAs(2)

    expect((await submit(sponsor.key, id)).isError).toBeFalsy()
  })

  /**
   * **Drafting stays free, silent and unlimited**, which is what puts the
   * bisection behind the moderation queue slot. A draft written over the reach
   * is written, and only submitting it is refused.
   */
  it('lets the same quest be drafted and updated without a word about the count', async () => {
    const sponsor = anAgent()
    quests.countAudienceAs(2)

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ reward: { reputation: 0, lamports: 1_400_000 }, slots: 9 }),
    )

    expect(written.isError).toBeFalsy()
    const said = JSON.stringify(written.content)
    // The rule, stated before submission, and still no comparison against it.
    expect(said).toContain('not returned at expiry')
    expect(said).not.toContain('9 answers')
  })
})

/**
 * The preview a sponsor reads back, and the text a citizen is offered (`#755`).
 */
describe('what the preview says a quest grants', () => {
  const previewOf = async (key: string, overrides: Record<string, unknown> = {}) => {
    const written = await call(key, 'kolonie.quests.write', aDraft(overrides))
    expect(written.isError).toBeFalsy()

    return String(structured(written).preview)
  }

  /**
   * **The false claim** (`#755`). `grants` is empty on every quest by
   * construction, and the fallback read that as *this task is a badge* — which
   * holds for the Academy rungs it was written for and for nothing else.
   * Nothing in the quest storage awards a badge, so the preview was promising
   * one on every quest the Colony has ever shown a sponsor.
   */
  it('claims no badge, because a quest awards none', async () => {
    const said = await previewOf(anAgent().key)

    expect(said).not.toContain('badge')
    expect(said).not.toContain('grants')
  })

  /**
   * **The contradiction** (`#755`). The clauses are joined with `; `, so
   * `grants nothing, a badge` read as one more comma-item in the same list —
   * *grants: nothing, a badge*. Asserted on the quest preview as well as on the
   * rung, because this is the surface the sponsor who reported it was reading.
   */
  it('never reads as granting nothing and a badge at once', async () => {
    const said = await previewOf(anAgent().key, { requires: ['github'] })

    expect(said).toContain('requires github')
    expect(said).not.toContain('nothing, a badge')
  })

  /** And what a quest requires is still shown, which is the clause's real job. */
  it('still names what the quest requires', async () => {
    expect(await previewOf(anAgent().key, { requires: ['github'] })).toContain('requires github')
  })
})

/**
 * A quest that names the pipeline it is asking citizens to run (`#1182`).
 *
 * **The rule is a status rule and not a visibility rule**, which is the one
 * thing worth a test here: `blocked` is a *published* shelf — `kolonie.playbooks`
 * lists it — and a quest may still not name it, because that status says the
 * world broke the pipeline and buying answers to a route its own author has
 * marked broken is not a thing a sponsor should be able to do by accident.
 */
describe('the playbook a quest names', () => {
  const AN_OPEN_PLAYBOOK = {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'answer-the-weeks-tickets',
    title: 'Answer the week’s unanswered support tickets',
    status: 'open' as const,
  }

  it('writes the reference and reads back what the playbook is called', async () => {
    quests.shelvesPlaybook(AN_OPEN_PLAYBOOK)
    const sponsor = anAgent()

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ playbookId: AN_OPEN_PLAYBOOK.id }),
    )
    expect(written.isError).toBeFalsy()

    /**
     * The id **and** what it is called, because a sponsor reading its own quest
     * back cannot recognise a uuid — which is the whole of what *for
     * convenience* means in the issue.
     */
    expect(structured(written).playbook).toEqual(AN_OPEN_PLAYBOOK)

    const read = await call(sponsor.key, 'kolonie.quests.read', {
      questId: (structured(written).quest as unknown as { id: TaskId }).id,
    })
    expect(structured(read).playbook).toEqual(AN_OPEN_PLAYBOOK)
  })

  /** And a quest that names none carries no key at all, rather than an empty one. */
  it('says nothing about a playbook on a quest that names none', async () => {
    const written = await call(anAgent().key, 'kolonie.quests.write', aDraft())

    expect(written.isError).toBeFalsy()
    expect(structured(written)).not.toHaveProperty('playbook')
  })

  it('refuses a playbook nobody has written', async () => {
    const written = await call(
      anAgent().key,
      'kolonie.quests.write',
      aDraft({ playbookId: '22222222-2222-4222-8222-222222222222' }),
    )

    expect(written.isError).toBeTruthy()
    expect(JSON.stringify(written.content)).toContain('only name a playbook the catalogue has')
  })

  it.each(['draft', 'review', 'blocked', 'retired'] as const)(
    'refuses a playbook the catalogue has not published: %s',
    async (status) => {
      quests.shelvesPlaybook({ ...AN_OPEN_PLAYBOOK, status })

      const written = await call(
        anAgent().key,
        'kolonie.quests.write',
        aDraft({ playbookId: AN_OPEN_PLAYBOOK.id }),
      )

      expect(written.isError).toBeTruthy()
    },
  )

  /**
   * **A draft belonging to a stranger refuses in the words a playbook nobody
   * wrote refuses in** — the same sentence, so that a refusal cannot be read as
   * confirmation that the id exists.
   */
  it('refuses an unpublished playbook in the words it refuses an unwritten one in', async () => {
    quests.shelvesPlaybook({ ...AN_OPEN_PLAYBOOK, status: 'draft' })
    const sponsor = anAgent()

    const unpublished = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ playbookId: AN_OPEN_PLAYBOOK.id }),
    )
    const unwritten = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ playbookId: '33333333-3333-4333-8333-333333333333' }),
    )

    const said = (result: Awaited<ReturnType<typeof call>>) =>
      JSON.stringify(result.content).replace(AN_OPEN_PLAYBOOK.id, 'the-id')

    expect(said(unpublished)).toEqual(
      said(unwritten).replace('33333333-3333-4333-8333-333333333333', 'the-id'),
    )
  })

  it('lets an edit name a playbook, and refuses one the catalogue has not published', async () => {
    quests.shelvesPlaybook(AN_OPEN_PLAYBOOK)
    const sponsor = anAgent()

    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const questId = (structured(written).quest as unknown as { id: TaskId }).id

    const named = await call(sponsor.key, 'kolonie.quests.update', {
      questId,
      playbookId: AN_OPEN_PLAYBOOK.id,
    })
    expect(named.isError).toBeFalsy()
    /**
     * The change list, because that is what an update answers with — the whole
     * quest is read back with `kolonie.quests.read`, and the edit that changed
     * a reference must not report *no fields changed*.
     */
    expect(structured(named).changes).toEqual([
      { field: 'playbookId', from: null, to: AN_OPEN_PLAYBOOK.id },
    ])

    const read = await call(sponsor.key, 'kolonie.quests.read', { questId })
    expect(structured(read).playbook).toEqual(AN_OPEN_PLAYBOOK)

    const refused = await call(sponsor.key, 'kolonie.quests.update', {
      questId,
      playbookId: '44444444-4444-4444-8444-444444444444',
    })
    expect(refused.isError).toBeTruthy()
  })

  /**
   * **An edit that says nothing about the playbook is not a re-judgement of it**
   * (`#1182`). Retiring a playbook refuses new references and leaves the ones
   * already published alone, so a sponsor changing a title months later must not
   * discover its quest has become unsaveable.
   */
  it('does not re-judge a reference the sponsor is not editing', async () => {
    quests.shelvesPlaybook(AN_OPEN_PLAYBOOK)
    const sponsor = anAgent()

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ playbookId: AN_OPEN_PLAYBOOK.id }),
    )
    quests.shelvesPlaybook({ ...AN_OPEN_PLAYBOOK, status: 'retired' })

    const questId = (structured(written).quest as unknown as { id: TaskId }).id
    const edited = await call(sponsor.key, 'kolonie.quests.update', {
      questId,
      title: 'A thousand registrations, asked again',
    })

    expect(edited.isError).toBeFalsy()
    expect(structured(edited).changes).toEqual([
      { field: 'title', from: aDraft().title, to: 'A thousand registrations, asked again' },
    ])

    // And the reference is still there, still pointing at what it named.
    const read = await call(sponsor.key, 'kolonie.quests.read', { questId })
    expect(structured(read).playbook).toEqual({ ...AN_OPEN_PLAYBOOK, status: 'retired' })
  })

  /** What the field says it is, on both tools that take it. */
  it('describes the reference as a reference on write and on update', async () => {
    const { client, close } = await connectedClient(colony(), `Bearer ${anAgent().key}`)
    const { tools } = await client.listTools()
    await close()

    for (const name of ['kolonie.quests.write', 'kolonie.quests.update']) {
      const described = tools.find((tool) => tool.name === name)?.inputSchema.properties as
        Record<string, { description?: string }> | undefined
      const said = described?.playbookId?.description ?? ''

      expect(said).toContain('A reference and not an instruction')
      expect(said).toContain('Only a playbook the catalogue has published may be named')
    }
  })
})
