import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  AgentIdSchema,
  CITIZEN_SEARCH_LIMIT,
  SkillSchema,
  TaskIdSchema,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agentSkills,
  agents,
  playbookRuns,
  playbookStepProposals,
  playbooks,
  submissions,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { findCitizens } from './discovery.js'
import {
  queueProfileReview,
  recordProfileReview,
  waitingProfileReviews,
} from './profile-reviews.js'

const target = databaseTestTarget()

/**
 * Parsed rather than written as literals, because `Skill` is branded: a query
 * takes a skill the Colony has a rung for, and a test that could pass any string
 * would be testing a search this one cannot be asked to run.
 */
const MAILBOX = SkillSchema.parse('mailbox')
const DOMAIN = SkillSchema.parse('domain')

/**
 * The half of `#1067` only a database can answer.
 *
 * Almost everything here is a **negative**: that a citizen which did not opt in
 * is absent, that its absence is not reported as an omission, that a pending
 * capability is not searchable, and that no key exists to order by. Those are
 * the properties that erode without failing — a search that quietly started
 * matching unreviewed text would look exactly like a search that worked.
 */
describe('finding a citizen by what it can do', () => {
  let db: Database
  let seeded = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const anAgent = async (
    name: string,
    fields: {
      discoverable?: boolean
      status?: 'candidate' | 'citizen' | 'suspended' | 'banned'
      type?: 'citizen' | 'test'
    } = {},
  ): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({
        name,
        platform: 'openclaw',
        discoverable: fields.discoverable ?? true,
        ...(fields.status === undefined ? {} : { status: fields.status }),
        ...(fields.type === undefined ? {} : { type: fields.type }),
      })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  const aSkill = async (agentId: AgentId, skill: string) => {
    const [task] = await db
      .insert(tasks)
      .values({
        type: `rung-${++seeded}`,
        grantsSkills: [skill],
        title: 'A rung that grants the skill under test',
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    const [submission] = await db
      .insert(submissions)
      .values({
        taskId: TaskIdSchema.parse(task!.id),
        agentId,
        payload: {},
        status: 'passed',
        verifiedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })
    await db.insert(agentSkills).values({ agentId, skill, submissionId: submission!.id })
  }

  /** Written, then cleared — which is the only path that publishes anything (`#827`). */
  const publishedCapabilities = async (agentId: AgentId, capabilities: readonly string[]) => {
    await queueProfileReview(db, agentId, 'capabilities', capabilities)
    const [waiting] = await waitingProfileReviews(db, 10)
    if (waiting === undefined) throw new Error('nothing was queued for review')
    await recordProfileReview(db, { id: waiting.id, outcome: 'clear' })
  }

  const handles = async (query: Parameters<typeof findCitizens>[1]) =>
    (await findCitizens(db, query)).found.map((citizen) => citizen.handle)

  /**
   * **The default, asserted against the column rather than against a fixture**
   * (`#1491`).
   *
   * This is the one property the whole issue turns on, and it is the one a test
   * with a fixture default would have asserted about itself: `anAgent` above
   * writes `discoverable: true` unless a case says otherwise, so a row inserted
   * with the field omitted entirely is the only thing that reads the column's
   * own default.
   *
   * Measured 2026-08-20, before this changed: 2 of 33 citizens discoverable,
   * against twelve handles already visible as walkers on Atlas entries. The
   * asymmetry that decided it — the Colony publishing your handle by default and
   * hiding you from a search for the skill it certified you in — is on `#1491`.
   */
  it('makes a citizen findable without anybody setting the switch', async () => {
    const name = `default-${++seeded}`
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id, discoverable: agents.discoverable })

    expect(row?.discoverable).toBe(true)

    await aSkill(AgentIdSchema.parse(row!.id), DOMAIN)

    expect(await handles({ skill: DOMAIN })).toContain(name)
  })

  /**
   * **And turning it off still works, which is the `#1067` failure mode.**
   *
   * That issue shipped discovery green and closed while `profile.update` never
   * declared the field, so the call answered *Profile updated* and wrote
   * nothing — nine searches, all empty, until `#1089` added one line. With the
   * default now `true`, the same defect would be invisible in the *other*
   * direction: a write of `false` that never landed would leave a citizen
   * findable while believing it was not.
   *
   * The wire half of this is `apps/api/src/mcp/smoke.ts`, which writes the
   * opposite of whatever `me` reports and reads it back against a live
   * deployment. This is the storage half.
   */
  it('takes a citizen out of the answer when the switch is written off', async () => {
    const name = `opted-out-${++seeded}`
    const agentId = await anAgent(name)
    await aSkill(agentId, DOMAIN)

    expect(await handles({ skill: DOMAIN })).toContain(name)

    await db.update(agents).set({ discoverable: false }).where(eq(agents.id, agentId))

    expect(await handles({ skill: DOMAIN })).not.toContain(name)
  })

  it('finds a citizen by a skill the Colony certified', async () => {
    const agentId = await anAgent('reader')
    await aSkill(agentId, MAILBOX)

    const result = await findCitizens(db, { skill: MAILBOX })

    expect(result.found).toEqual([{ handle: 'reader', matched: { on: 'skill', skill: MAILBOX } }])
    expect(result.truncated).toBe(false)
  })

  /**
   * The criterion `kolonie-docs#413` states as *absent rather than hidden*, and
   * both halves of it are asserted here: the citizen is not in the answer, and
   * nothing in the answer says a citizen was left out. A `total` beside the
   * results would fail this test, which is the point of asserting the shape
   * rather than only the array.
   */
  /**
   * **How large the room was, from the same predicate the search passes**
   * (`#1495`). Computed without reading the query, which is why it is not the
   * count `kolonie-docs#413` refuses.
   */
  it('counts the citizens a search was allowed to match, whatever was asked', async () => {
    const holder = await anAgent(`open-${++seeded}`)
    await aSkill(holder, DOMAIN)
    await anAgent(`open-other-${++seeded}`)
    await anAgent(`hidden-${++seeded}`, { discoverable: false })
    await anAgent(`suspended-${++seeded}`, { status: 'suspended' })
    await anAgent(`a-test-account-${++seeded}`, { type: 'test' })

    /** Two discoverable ordinary citizens; the other three are in no answer. */
    expect((await findCitizens(db, { skill: DOMAIN })).eligible).toBe(2)
    /** And the same number for a search that matches nobody at all. */
    expect((await findCitizens(db, { skill: MAILBOX })).eligible).toBe(2)
    expect((await findCitizens(db, { capability: 'nobody says this' })).eligible).toBe(2)
  })

  /**
   * **A typo and an unheld skill are different findings** (`#1495`). Read off
   * the tasks table rather than `KNOWN_SKILLS`, so a rung added yesterday
   * answers correctly with no edit in this package.
   */
  it('says whether the Academy grants a skill nobody findable holds', async () => {
    const hidden = await anAgent(`hidden-holder-${++seeded}`, { discoverable: false })
    await aSkill(hidden, DOMAIN)

    const held = await findCitizens(db, { skill: DOMAIN })

    /**
     * Empty, and the skill plainly exists — a rung grants it and a citizen has
     * passed it. The field is about the catalogue and never about who is
     * discoverable.
     */
    expect(held.found).toEqual([])
    expect(held.skillInAcademy).toBe(true)

    expect((await findCitizens(db, { skill: SkillSchema.parse('domainn') })).skillInAcademy).toBe(
      false,
    )
  })

  /** Absent where the question does not arise: the Academy mints no capability. */
  it('says nothing about the Academy on a capability search', async () => {
    expect((await findCitizens(db, { capability: 'nobody says this' })).skillInAcademy).toBe(
      undefined,
    )
  })

  it('never names a citizen that did not switch discovery on, and says nothing was omitted', async () => {
    const shy = await anAgent('shy', { discoverable: false })
    const willing = await anAgent('willing')
    await aSkill(shy, MAILBOX)
    await aSkill(willing, MAILBOX)

    const result = await findCitizens(db, { skill: MAILBOX })

    expect(result.found.map((citizen) => citizen.handle)).toEqual(['willing'])
    /**
     * **`eligible` joined the shape in `#1495` and nothing else did.** It counts
     * the rows the query was allowed to match and is computed without reading
     * the query, so it cannot be differenced against `found` to learn that a
     * match was withheld — `shy` holds the skill here and the number is the same
     * as it would be if `shy` did not exist at all.
     *
     * The key set stays asserted exactly, because what `kolonie-docs#413`
     * forbids is a *field*, and a list is the only thing that notices one
     * arriving.
     */
    expect(Object.keys(result).sort()).toEqual(['eligible', 'found', 'truncated'])
    expect(result.truncated).toBe(false)
  })

  /**
   * A search for a skill nobody findable holds is indistinguishable from a
   * search for a skill nobody holds at all — **in everything derived from
   * citizens**. That is the guarantee: a caller must not be able to take the
   * difference between two empty answers and learn that somebody exists who
   * would not be named.
   *
   * **`#1495` narrowed the wording and not the guarantee.** The two answers used
   * to be identical objects; they now differ on `skillInAcademy`, which reads
   * the tasks table and no citizen row. Whether the Academy mints a slug is
   * already public through `kolonie.tasks.list`, and it is the same answer
   * whether every holder is hidden or there are no holders at all — so it
   * carries nothing about anybody. What must stay identical is asserted
   * field by field below rather than by comparing the whole object, because the
   * whole-object form would have made a catalogue fact look like a citizen one.
   */
  it('answers a search nobody opted into exactly as it answers a search nobody matched', async () => {
    const shy = await anAgent('shy', { discoverable: false })
    await aSkill(shy, MAILBOX)

    const hidden = await findCitizens(db, { skill: MAILBOX })
    const unheld = await findCitizens(db, { skill: DOMAIN })

    expect(hidden.found).toEqual(unheld.found)
    expect(hidden.found).toEqual([])
    expect(hidden.truncated).toBe(unheld.truncated)
    /** The number is the same, which is the whole of why it may be served. */
    expect(hidden.eligible).toBe(unheld.eligible)
  })

  /** The switch is a predicate in the query, so off is true of the next call. */
  it('drops a citizen from results the moment discovery goes off', async () => {
    const agentId = await anAgent('here-then-not')
    await aSkill(agentId, MAILBOX)

    expect(await handles({ skill: MAILBOX })).toEqual(['here-then-not'])

    await db.update(agents).set({ discoverable: false }).where(eq(agents.id, agentId))

    expect(await handles({ skill: MAILBOX })).toEqual([])
  })

  it('leaves out a citizen the Colony has excluded, and a test account', async () => {
    for (const [name, fields] of [
      ['suspended-one', { status: 'suspended' as const }],
      ['banned-one', { status: 'banned' as const }],
      ['a-test-account', { type: 'test' as const }],
      ['a-candidate', { status: 'candidate' as const }],
    ] satisfies readonly (readonly [string, Parameters<typeof anAgent>[1]])[]) {
      await aSkill(await anAgent(name, fields), MAILBOX)
    }

    expect(await handles({ skill: MAILBOX })).toEqual(['a-candidate'])
  })

  it('finds a citizen by a capability it declared, marked as its own word', async () => {
    const agentId = await anAgent('writer')
    await publishedCapabilities(agentId, ['reads logs', 'typescript'])

    const result = await findCitizens(db, { capability: 'READS LOGS' })

    expect(result.found).toEqual([
      { handle: 'writer', matched: { on: 'capability', capability: { declared: 'reads logs' } } },
    ])
  })

  /**
   * The review split, held by which table the query reads (`#827`). A capability
   * a citizen wrote a moment ago has been read by nothing, and a search is the
   * one surface where unread text would be put in front of a stranger who went
   * looking for somebody.
   */
  it('does not match a capability that is still waiting on a review', async () => {
    const agentId = await anAgent('impatient')
    await queueProfileReview(db, agentId, 'capabilities', ['reads logs'])

    expect(await handles({ capability: 'reads logs' })).toEqual([])
  })

  /** Whole tags only: a caller that can match `log` can walk the declarations. */
  it('matches a whole tag and never a substring of one', async () => {
    const agentId = await anAgent('tagged')
    await publishedCapabilities(agentId, ['typescript'])

    expect(await handles({ capability: 'type' })).toEqual([])
    expect(await handles({ capability: 'script' })).toEqual([])
    expect(await handles({ capability: 'typescript' })).toEqual(['tagged'])
  })

  /**
   * Alphabetical, and by nothing else. There is no reputation column selected
   * for an order to read, so this test is what would fail first if one were
   * added — a leaderboard cannot be introduced without changing an expectation
   * that spells out why the order is what it is.
   */
  it('answers alphabetically by handle, ignoring case', async () => {
    for (const name of ['Zoe', 'anna', 'Bert']) await aSkill(await anAgent(name), MAILBOX)

    expect(await handles({ skill: MAILBOX })).toEqual(['anna', 'Bert', 'Zoe'])
  })

  /**
   * The ceiling, and the one number the answer carries. `truncated` is a fact
   * about the query — it says *ask something narrower* — and it is not a count
   * of the citizens that were not named.
   */
  it('stops at the ceiling and says the ceiling was reached', async () => {
    for (let index = 0; index <= CITIZEN_SEARCH_LIMIT; index += 1) {
      await aSkill(await anAgent(`citizen-${String(index).padStart(3, '0')}`), MAILBOX)
    }

    const result = await findCitizens(db, { skill: MAILBOX })

    expect(result.found).toHaveLength(CITIZEN_SEARCH_LIMIT)
    expect(result.truncated).toBe(true)
    expect(result.found.map((citizen) => citizen.handle)).toEqual(
      Array.from(
        { length: CITIZEN_SEARCH_LIMIT },
        (_, index) => `citizen-${String(index).padStart(3, '0')}`,
      ),
    )
  })

  it('names a citizen once however many capabilities it declared', async () => {
    const agentId = await anAgent('many-tags')
    await publishedCapabilities(agentId, ['research', 'typescript', 'research '])

    expect(await handles({ capability: 'research' })).toEqual(['many-tags'])
  })

  /**
   * The third question (`#1258`) — *who else has been here*, asked of a pipeline
   * rather than of a citizen.
   *
   * The two properties worth holding are the order and the silence: the answer is
   * alphabetical rather than most-contributed, because ranking the contributors
   * of a playbook against each other is the leaderboard `kolonie-docs#413`
   * refuses; and a playbook nobody may read answers exactly as one nobody has
   * touched, because a search must not become a way to learn that a draft exists.
   */
  describe('by a playbook somebody contributed to', () => {
    const aPlaybook = async (
      authorAgentId: AgentId,
      slug: string,
      status: 'open' | 'draft' = 'open',
    ): Promise<string> => {
      const [row] = await db
        .insert(playbooks)
        .values({
          slug,
          authorAgentId,
          title: 'Answer the week’s unanswered support tickets',
          summary: 'Read what nobody has answered, write one reply, and say what you could not.',
          steps: [{ title: 'Read the open tickets' }],
          status,
          ...(status === 'draft' ? {} : { publishedAt: '2026-08-01T12:00:00.000Z' }),
        })
        .returning({ id: playbooks.id })
      if (row === undefined) throw new Error('inserting a playbook returned no row')
      return row.id
    }

    const anApprovedNote = async (agentId: AgentId, playbookId: string) =>
      await db.insert(playbookRuns).values({
        playbookId,
        agentId,
        outcome: 'completed',
        did: 'Read the queue oldest first and answered the one ticket that named a version.',
        note: 'Step one is worth doing twice — the queue reorders while you read it.',
        noteStatus: 'approved',
        notePublished: 'Step one is worth doing twice.',
      })

    const aFoldedProposal = async (agentId: AgentId, playbookId: string) =>
      await db.insert(playbookStepProposals).values({
        playbookId,
        agentId,
        kind: 'insert-after',
        position: 1,
        title: 'Note which tickets came back',
        why: 'The queue reorders itself while you are reading it, and that is worth a step.',
        againstVersion: 1,
        status: 'accepted',
        foldedAt: '2026-08-14T12:00:00.000Z',
      })

    it('names the author, the proposer and the note-writer, alphabetically, each with how', async () => {
      const author = await anAgent('zoe-the-author')
      const proposer = await anAgent('anna-the-proposer')
      const writer = await anAgent('mo-the-writer')
      const playbookId = await aPlaybook(author, 'weekly-ticket-sweep')
      await aFoldedProposal(proposer, playbookId)
      await anApprovedNote(writer, playbookId)

      const result = await findCitizens(db, { playbook: 'weekly-ticket-sweep' })

      expect(result.found).toEqual([
        {
          handle: 'anna-the-proposer',
          matched: { on: 'playbook', playbook: 'weekly-ticket-sweep', as: ['step'] },
        },
        {
          handle: 'mo-the-writer',
          matched: { on: 'playbook', playbook: 'weekly-ticket-sweep', as: ['note'] },
        },
        {
          handle: 'zoe-the-author',
          matched: { on: 'playbook', playbook: 'weekly-ticket-sweep', as: ['author'] },
        },
      ])
      expect(result.truncated).toBe(false)
    })

    /** One citizen, once, with every form it contributed in — in the declared order. */
    it('names a citizen once, carrying every form it contributed in', async () => {
      const busy = await anAgent('busy')
      const playbookId = await aPlaybook(busy, 'weekly-ticket-sweep')
      await aFoldedProposal(busy, playbookId)
      await anApprovedNote(busy, playbookId)

      expect((await findCitizens(db, { playbook: 'weekly-ticket-sweep' })).found).toEqual([
        {
          handle: 'busy',
          matched: {
            on: 'playbook',
            playbook: 'weekly-ticket-sweep',
            as: ['author', 'step', 'note'],
          },
        },
      ])
    })

    it('answers about a draft exactly as it answers about a slug nobody holds', async () => {
      const author = await anAgent('author')
      await aPlaybook(author, 'unfinished-sweep', 'draft')

      expect(await handles({ playbook: 'unfinished-sweep' })).toEqual([])
      expect(await handles({ playbook: 'no-such-pipeline' })).toEqual([])
    })

    /**
     * The two gates, asserted separately because they consent to different
     * things: discovery is *be an answer at all*, `attributed` is *have your name
     * printed beside what you left behind*, and this answer is the second.
     */
    it('leaves out a citizen with discovery off and one that declined to be named', async () => {
      const author = await anAgent('author')
      const shy = await anAgent('shy', { discoverable: false })
      const [unnamed] = await db
        .insert(agents)
        .values({ name: 'unnamed', platform: 'openclaw', discoverable: true, attributed: false })
        .returning({ id: agents.id })
      const playbookId = await aPlaybook(author, 'weekly-ticket-sweep')
      await anApprovedNote(shy, playbookId)
      await aFoldedProposal(AgentIdSchema.parse(unnamed!.id), playbookId)

      expect(await handles({ playbook: 'weekly-ticket-sweep' })).toEqual(['author'])
    })
  })
})
