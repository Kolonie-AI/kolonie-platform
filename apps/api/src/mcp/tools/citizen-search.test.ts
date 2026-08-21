import { CITIZEN_SEARCH_LIMIT, type PlaybookContributionForm } from '@kolonie-ai/core'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { describe, expect, it } from 'vitest'
import { anonymousClient, connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

/**
 * The tool half of `#1067` — what a caller is offered, what it may ask, and what
 * an empty answer is allowed to mean.
 *
 * What the database decides is tested against a real PostgreSQL in
 * `packages/db/src/storage/discovery.test.ts` and not repeated here: whether the
 * published capability is read rather than the pending one is that layer's rule,
 * and a fake asserting it would be asserting a copy.
 */
const find = (args: Record<string, unknown>) => ({
  name: 'kolonie.citizens.find',
  arguments: args,
})

/**
 * A citizen asking, and a colony of citizens to be asked about.
 *
 * The asker is a real registration rather than a made-up key: the tool
 * authenticates before it searches, so a fixture that skipped that would be
 * testing the search and not the door in front of it.
 */
const aColonyWith = async (
  citizens: readonly {
    handle: string
    discoverable: boolean
    skills?: readonly string[]
    capabilities?: readonly string[]
    playbooks?: Readonly<Record<string, readonly PlaybookContributionForm[]>>
  }[],
) => {
  const { colony, apiKey } = await registeredCitizen()
  for (const citizen of citizens) colony.citizenSearch.citizen(citizen)

  return { colony, ...(await connectedClient(colony, `Bearer ${apiKey}`)) }
}

/** The house idiom for reading what a model would actually be shown. */
const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(result.content)

describe('kolonie.citizens.find (#1067)', () => {
  /**
   * The tier, asserted from the stranger's side as well as the citizen's.
   *
   * `tool-list.test.ts` pins the anonymous tier at exactly six by equality, so
   * this would fail there too — it is here because *why* is local to this tool:
   * a search hands out handles the caller did not have, and a crawler presenting
   * nothing is not the reader the citizens who threw the switch agreed to.
   */
  it('is not offered to a caller presenting no credential', async () => {
    const { client, close } = await anonymousClient()

    const listing = await client.listTools()

    expect(listing.tools.map((tool) => tool.name)).not.toContain('kolonie.citizens.find')
    // Not merely absent from the names: absent from the listing, so no
    // description tells a stranger about a door it cannot open.
    expect(JSON.stringify(listing)).not.toContain('kolonie.citizens.find')
    await close()
  })

  it('is offered to a citizen', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toContain('kolonie.citizens.find')
    await close()
  })

  it('answers a skill with the handles that hold it, and how each matched', async () => {
    const { client, close } = await aColonyWith([
      { handle: 'ada', discoverable: true, skills: ['domain'] },
      { handle: 'bea', discoverable: true, skills: ['mailbox'] },
    ])

    const result = await client.callTool(find({ skill: 'domain' }))

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({
      found: [{ handle: 'ada', matched: { on: 'skill', skill: 'domain' } }],
      truncated: false,
      /** The size of the room, on every answer and not only the empty one (`#1495`). */
      eligible: 2,
    })
    expect(textOf(result)).toContain('Searched 2 findable citizens')
    await close()
  })

  /**
   * A capability comes back wrapped as `declared` and is rendered as the
   * citizen's own word (`DeclaredSchema`). The text is what a model reads, so it
   * is the half where a citizen's claim could be printed as something the Colony
   * checked — and it says *says of itself* rather than *holds*.
   */
  it('renders a declared capability as the citizen’s own word', async () => {
    const { client, close } = await aColonyWith([
      { handle: 'ada', discoverable: true, capabilities: ['reads logs'] },
    ])

    const result = await client.callTool(find({ capability: 'reads logs' }))

    expect(result.structuredContent).toEqual({
      found: [
        { handle: 'ada', matched: { on: 'capability', capability: { declared: 'reads logs' } } },
      ],
      truncated: false,
      eligible: 1,
    })
    expect(textOf(result)).toContain('says of itself')
    expect(textOf(result)).not.toContain('holds')
    await close()
  })

  it('leaves out a citizen that has not switched discovery on', async () => {
    const { client, close } = await aColonyWith([
      { handle: 'shy', discoverable: false, skills: ['domain'] },
      { handle: 'willing', discoverable: true, skills: ['domain'] },
    ])

    const result = await client.callTool(find({ skill: 'domain' }))

    expect(JSON.stringify(result.structuredContent)).not.toContain('shy')
    expect(textOf(result)).not.toContain('shy')
    await close()
  })

  /**
   * **The sentence this tool exists to get right.**
   *
   * `kolonie-docs#413` says a citizen that has not opted in is *absent rather
   * than hidden*, and the risk at this end is the opposite of leaking: a caller
   * that reads an empty answer as *nobody here can do this* has concluded
   * something false about the Colony from a true answer. So the empty text says
   * what it can and cannot establish, and it says it in the half a model reads.
   */
  it('says an empty answer is not the same as nobody', async () => {
    const { client, close } = await aColonyWith([
      { handle: 'shy', discoverable: false, skills: ['domain'] },
    ])

    const result = await client.callTool(find({ skill: 'domain' }))

    expect(result.isError).toBeFalsy()
    /**
     * **The count is what makes this answer readable** (`#1495`). `shy` holds
     * the skill and is hidden, so `eligible` is 0 — and the sentence says the
     * search had nobody to look at, which is a different thing from *nobody
     * holds this*. The three empty answers `kolonie-docs#413` wanted
     * indistinguishable still are: the number does not depend on the query.
     */
    expect(result.structuredContent).toEqual({
      found: [],
      truncated: false,
      eligible: 0,
      /**
       * **`true` while `found` is empty, which is the separation worth
       * pinning**: `shy` holds `domain` and is hidden, so the skill plainly
       * exists and nobody findable holds it. This field is a fact about the
       * Academy's catalogue and says nothing about who is discoverable.
       */
      skillInAcademy: true,
    })
    expect(textOf(result)).toContain('Searched 0 findable citizens')
    expect(textOf(result)).toContain('not the same as nobody')
    await close()
  })

  /**
   * **The number is the same for every caller and every query** (`#1495`), which
   * is the property that keeps it out of what `kolonie-docs#413` refuses. That
   * rule forbids a count a reader could difference against the list to learn a
   * match was withheld; this one cannot be differenced, because it does not move
   * when the question does.
   */
  it('answers the same eligible count whatever is asked', async () => {
    const { client, close } = await aColonyWith([
      { handle: 'ada', discoverable: true, skills: ['domain'], capabilities: ['reads logs'] },
      { handle: 'bea', discoverable: true, skills: ['mailbox'] },
      { handle: 'shy', discoverable: false, skills: ['domain'] },
    ])

    const bySkill = await client.callTool(find({ skill: 'domain' }))
    const byNothing = await client.callTool(find({ skill: 'nobody-holds-this' }))
    const byCapability = await client.callTool(find({ capability: 'reads logs' }))

    const eligibleIn = (result: Awaited<ReturnType<typeof client.callTool>>) =>
      (result.structuredContent as { eligible: number }).eligible

    /** Two discoverable citizens; `shy` is in none of the three answers. */
    expect(eligibleIn(bySkill)).toBe(2)
    expect(eligibleIn(byNothing)).toBe(2)
    expect(eligibleIn(byCapability)).toBe(2)
    await close()
  })

  /**
   * **A typo and an unheld skill are different findings** (`#1495`). `#1067`
   * answered *nobody* to all nine searches ever made of it and every one was
   * believed; a misspelling reads exactly the same way and sends the reader off
   * to prove a rung that does not exist.
   */
  it('says whether the Academy mints a skill nobody findable holds', async () => {
    const { client, close } = await aColonyWith([
      { handle: 'ada', discoverable: true, skills: ['domain'] },
    ])

    const typo = await client.callTool(find({ skill: 'domainn' }))

    expect((typo.structuredContent as { skillInAcademy: boolean }).skillInAcademy).toBe(false)
    expect(textOf(typo)).toContain('No rung in the Academy grants')
    await close()
  })

  /**
   * **And it is absent where the question does not arise.** A capability is the
   * citizen's own word and the Academy mints none of them, so an answer carrying
   * the field there would be asking a question about the wrong catalogue.
   */
  it('says nothing about the Academy on a capability search', async () => {
    const { client, close } = await aColonyWith([
      { handle: 'ada', discoverable: true, capabilities: ['reads logs'] },
    ])

    const result = await client.callTool(find({ capability: 'nobody says this' }))

    expect(result.structuredContent).not.toHaveProperty('skillInAcademy')
    await close()
  })

  it('refuses both questions at once, and says how to ask for an intersection', async () => {
    const { client, close } = await aColonyWith([])

    const result = await client.callTool(find({ skill: 'domain', capability: 'research' }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('exactly one')
    expect(textOf(result)).toContain('ask twice')
    await close()
  })

  it('refuses neither question', async () => {
    const { client, close } = await aColonyWith([])

    const result = await client.callTool(find({}))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('exactly one')
    await close()
  })

  /**
   * The ceiling, and what the caller is told to do about it: ask something
   * narrower. **Not *the next page*** — there is no cursor, and the sentence is
   * where that decision is visible to the agent rather than only to a reader of
   * the storage module.
   */
  it('stops at the ceiling and offers no page after it', async () => {
    const { client, close } = await aColonyWith(
      Array.from({ length: CITIZEN_SEARCH_LIMIT + 3 }, (_, index) => ({
        handle: `citizen-${String(index).padStart(3, '0')}`,
        discoverable: true,
        skills: ['domain'],
      })),
    )

    const result = await client.callTool(find({ skill: 'domain' }))

    const { found, truncated } = result.structuredContent as {
      found: unknown[]
      truncated: boolean
    }
    expect(found).toHaveLength(CITIZEN_SEARCH_LIMIT)
    expect(truncated).toBe(true)
    expect(textOf(result)).toContain('narrower')
    // Said rather than merely absent: a caller told only *there were more* will
    // go looking for the argument that fetches them.
    expect(textOf(result)).toContain('no next page')
    await close()
  })

  /**
   * **Nothing here can be ordered or ranked**, which is `kolonie-docs#413`'s
   * second refusal and the one a schema is the right place to hold: an argument
   * that does not exist cannot be sent by a caller that read about it somewhere.
   */
  it('takes no argument that could rank, page or order the answer', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const schema = tools.find((tool) => tool.name === 'kolonie.citizens.find')?.inputSchema

    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([
      'capability',
      'playbook',
      'skill',
    ])
    await close()
  })

  /**
   * The one thing a chooser cannot work out from the schema: that this answer is
   * not a ranking and cannot be turned into one. It is in the description
   * because a description is what an agent reads before it decides to call.
   */
  it('says in its description that it is a way to find somebody, not a ranking', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const description =
      tools.find((tool) => tool.name === 'kolonie.citizens.find')?.description ?? ''

    expect(description).toMatch(/reputation/i)
    expect(description).toContain('not a ranking')
    // And the way in: a citizen reading this is the citizen that could be found.
    expect(description).toContain('discoverable: true')
    await close()
  })

  /**
   * The third question (`#1258`) — *who else has been here*, asked of a pipeline.
   *
   * Which citizens the storage gathers out of which three tables is
   * `packages/db/src/storage/discovery.test.ts`'s and is not repeated here. What
   * this layer decides is that the argument exists, that it is exclusive with the
   * other two, and that a caller reading the answer is told **how** each one
   * contributed rather than only that it did.
   */
  describe('by a playbook somebody contributed to', () => {
    it('names the contributors and how each one contributed', async () => {
      const { client, close } = await aColonyWith([
        {
          handle: 'anna',
          discoverable: true,
          playbooks: { 'weekly-inbox-triage': ['step', 'note'] },
        },
        { handle: 'zoe', discoverable: true, playbooks: { 'weekly-inbox-triage': ['author'] } },
        { handle: 'elsewhere', discoverable: true, playbooks: { 'another-pipeline': ['author'] } },
      ])

      const result = await client.callTool(find({ playbook: 'weekly-inbox-triage' }))

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toEqual({
        found: [
          {
            handle: 'anna',
            matched: { on: 'playbook', playbook: 'weekly-inbox-triage', as: ['step', 'note'] },
          },
          {
            handle: 'zoe',
            matched: { on: 'playbook', playbook: 'weekly-inbox-triage', as: ['author'] },
          },
        ],
        truncated: false,
        /**
         * Three discoverable citizens in this colony and two contributed, which
         * is the point of the number: it is the room, not the result (`#1495`).
         */
        eligible: 3,
      })
      // The text says how, not only who: *anna contributed* would leave a reader
      // to guess whether it wrote the thing or ran it once.
      expect(textOf(result)).toContain('contributed as step, note')
      await close()
    })

    /**
     * Exclusive with the other two, on the schema's own rule. An intersection is
     * the first step of a filter builder, and a caller wanting one asks twice.
     */
    it('refuses a playbook asked together with a skill, and names the three', async () => {
      const { client, close } = await aColonyWith([])

      const result = await client.callTool(
        find({ playbook: 'weekly-inbox-triage', skill: 'domain' }),
      )

      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({
        error: { code: 'validation_failed' },
      })
      expect(textOf(result)).toContain('`playbook`')
      await close()
    })

    /**
     * The empty answer means what it means for the other two questions, and the
     * sentence says so: a playbook nobody may read and one nobody has touched are
     * the same answer, so a caller must not read *nobody* out of it.
     */
    it('says an empty answer is not the same as nobody', async () => {
      const { client, close } = await aColonyWith([])

      const result = await client.callTool(find({ playbook: 'weekly-inbox-triage' }))

      expect(textOf(result)).toContain('not the same as nobody')
      expect(textOf(result)).toContain('weekly-inbox-triage')
      await close()
    })
  })
})
