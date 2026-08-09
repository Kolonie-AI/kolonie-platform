import { AUDIENCE_FLOOR, type AgentId, type TaskId } from '@kolonie-ai/core'
import { SKILLS_THE_ACADEMY_GRANTS } from '@kolonie-ai/db'
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'
import { FAKE_AUDIENCE, fakeQuests, type FakeQuestDesk } from '../../__fixtures__/quests.js'
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
  reward: { reputation: 0, lamports: 1 },
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
      aDraft({ reward: { reputation: 0, lamports: 15 }, slots: 20 }),
    )

    // 20 × 15 for the answers, plus 3 each for the first three published
    // obstacle reports (`#371`, `#632`) — the commitment is the whole of what
    // the quest would hold, which is what a sponsor is deciding about.
    // The commitment is the cost and nothing else since `#553`: `available` and
    // `affordable` read a balance the Colony does not hold.
    expect(structured(written).commitment).toMatchObject({ cost: 309 })
    expect(String(structured(written).preview)).toContain('A thousand registrations')
    expect(JSON.stringify(written.content)).toContain('309')
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
  it('names the obstacle pool in the commitment, before anything is irreversible', async () => {
    const sponsor = anAgent()
    quests.credit(sponsor.id, 500)

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({ reward: { reputation: 0, lamports: 10 }, slots: 10 }),
    )

    // 100 for the ten answers, plus a quarter of one each for the first three
    // published obstacles — on top of the capacity rather than out of it.
    expect(structured(written).commitment).toMatchObject({ cost: 106 })
    const said = JSON.stringify(written.content)
    expect(said).toContain('106')
    expect(said).toContain('6 lamports of that is for the first 3 citizens')
    expect(said).toContain('rather than out of them')
  })

  it('holds no pool, and says nothing, for a sponsor that kept its obstacles', async () => {
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

    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())

    expect(
      (structured(written).quest as unknown as { publishObstacles: boolean }).publishObstacles,
    ).toBe(true)
    expect(JSON.stringify(written.content)).not.toContain('discovery cost')
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
    const steward = anAgent(['steward'])

    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    await call(sponsor.key, 'kolonie.quests.submit', { questId: id })
    await call(steward.key, 'kolonie.quests.publish', { questId: id })

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
      aDraft({ requires: ['browser', 'mailbox'] }),
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
    expect(audience.sentence).toContain('anyone this quest is offered to may answer')
  })

  it('recomputes the reach when an update changes the requirement', async () => {
    const sponsor = anAgent()
    const written = await call(sponsor.key, 'kolonie.quests.write', aDraft())
    const id = (structured(written).quest as unknown as { id: TaskId }).id

    const changed = await call(sponsor.key, 'kolonie.quests.update', {
      questId: id,
      requires: ['browser'],
    })

    expect(
      (structured(changed).audience as unknown as { requires: readonly string[] }).requires,
    ).toEqual(['browser'])
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

  /**
   * The net underneath `#352` (`#353`): a sponsor may still describe browser
   * work and publish it open to everyone, and the citizen that takes it
   * discovers the prerequisite mid-attempt.
   */
  it('flags a quest that asks for a capability while requiring no skill', async () => {
    const sponsor = anAgent()
    const steward = anAgent(['steward'])
    quests.credit(sponsor.id, 100)

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({
        title: 'Registering by hand',
        description: 'Open the sign-up page in a browser and complete it.',
      }),
    )
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    await call(sponsor.key, 'kolonie.quests.submit', { questId: id })
    quests.moderate(id)

    const queue = await call(steward.key, 'kolonie.quests.review', {}, true)
    const flagged = structured(queue).flagged as unknown as readonly {
      questId: TaskId
      flags: readonly { term: string; skill: string }[]
    }[]

    expect(flagged).toHaveLength(1)
    expect(flagged[0]?.questId).toBe(id)
    expect(flagged[0]?.flags).toContainEqual({ term: 'browser', skill: 'browser' })
    // The term is in the text a steward reads, not only in the structure.
    expect(JSON.stringify(queue.content)).toContain('browser')

    /**
     * **A flag, not a gate.** Publication is untouched, which is the half of
     * this feature that would be easiest to get wrong.
     */
    const published = await call(steward.key, 'kolonie.quests.publish', { questId: id }, true)
    expect(published.isError).toBeFalsy()
  })

  it('does not flag a quest that requires the skill its text asks for', async () => {
    const sponsor = anAgent()
    const steward = anAgent(['steward'])
    quests.credit(sponsor.id, 100)

    const written = await call(
      sponsor.key,
      'kolonie.quests.write',
      aDraft({
        description: 'Open the sign-up page in a browser and complete it.',
        requires: ['browser'],
      }),
    )
    const id = (structured(written).quest as unknown as { id: TaskId }).id
    await call(sponsor.key, 'kolonie.quests.submit', { questId: id })
    quests.moderate(id)

    const queue = await call(steward.key, 'kolonie.quests.review', {}, true)

    expect(structured(queue).flagged).toEqual([])
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
