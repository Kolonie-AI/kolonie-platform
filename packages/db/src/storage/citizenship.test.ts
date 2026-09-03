import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { AgentIdSchema, type AgentId, type CitizenshipStatus } from '@kolonie-ai/core'
import type { Database } from '../client.js'

import {
  agentSkills,
  agents,
  submissions,
  tasks,
  workplaceBoardMemberships,
  workplaceBoards,
  workplaceCardLabels,
  workplaceCards,
  workplaceChecklistItems,
  workplaceChecklists,
  workplaceLabels,
  workplaceRecurrenceRules,
} from '../schema/index.js'
import {
  BACKFILL_CITIZENSHIP_SQL,
  backfillCitizenship,
  CITIZENSHIP_MIGRATION,
  liftSuspension,
  promoteIfEarned,
} from './citizenship.js'
import {
  DEFAULT_WORKPLACE_SEED_VERSION,
  backfillDefaultWorkplaces,
  provisionDefaultWorkplace,
} from './workplace-provision.js'
import { connectForTests, databaseTestTarget, MIGRATIONS_FOLDER, truncateAll } from '../testing.js'

const target = databaseTestTarget()

/** The copy check, and it needs no database. */
describe('the citizenship backfill statement', () => {
  it('is the one the migration ran', async () => {
    const migration = await readFile(join(MIGRATIONS_FOLDER, CITIZENSHIP_MIGRATION), 'utf8')

    expect(migration).toContain(BACKFILL_CITIZENSHIP_SQL.replace(/;$/, ''))
  })
})

describe('promoting a candidate to citizen', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  let seeded = 0

  const anAgent = async (status: CitizenshipStatus = 'candidate'): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: `agent-${++seeded}`, platform: 'openclaw', status })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  /**
   * A held skill, written the way a grant writes one.
   *
   * `agent_skills.submission_id` is not null, so a real submission has to exist —
   * which is correct rather than inconvenient: a skill nothing granted is a skill
   * nobody can audit.
   */
  const holds = async (agentId: AgentId, skill: string) => {
    const [task] = await db
      .insert(tasks)
      .values({
        type: `grants-${skill}-${++seeded}`,
        grantsSkills: [skill],
        title: `The ${skill} rung`,
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
        taskId: task!.id,
        agentId,
        payload: {},
        attempt: 1,
        status: 'passed' as const,
        // `submissions_verified_at_matches_status` requires it: the database asserts
        // that a decided submission carries the time it was decided at.
        verifiedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })
    await db
      .insert(agentSkills)
      .values({ agentId, skill, submissionId: submission!.id })
      .onConflictDoNothing()
  }

  const statusOf = async (agentId: AgentId) => {
    const [row] = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
    return row?.status
  }

  const promote = (agentId: AgentId) =>
    db.transaction((tx) => promoteIfEarned(tx, { agentId, promotedAt: new Date().toISOString() }))

  const provision = (agentId: AgentId) =>
    db.transaction((tx) =>
      provisionDefaultWorkplace(tx, { citizenId: agentId, now: new Date().toISOString() }),
    )

  const workplaceCounts = async () => ({
    boards: (await db.select().from(workplaceBoards)).length,
    memberships: (await db.select().from(workplaceBoardMemberships)).length,
    labels: (await db.select().from(workplaceLabels)).length,
    cards: (await db.select().from(workplaceCards)).length,
    checklists: (await db.select().from(workplaceChecklists)).length,
    checklistItems: (await db.select().from(workplaceChecklistItems)).length,
    recurrenceRules: (await db.select().from(workplaceRecurrenceRules)).length,
  })

  it('does not plant a board when a candidate is created', async () => {
    await anAgent()

    expect(await workplaceCounts()).toEqual({
      boards: 0,
      memberships: 0,
      labels: 0,
      cards: 0,
      checklists: 0,
      checklistItems: 0,
      recurrenceRules: 0,
    })
  })

  it('refuses direct provisioning for a candidate', async () => {
    const agentId = await anAgent()

    await expect(provision(agentId)).rejects.toThrow('citizen')
    expect(await workplaceCounts()).toEqual({
      boards: 0,
      memberships: 0,
      labels: 0,
      cards: 0,
      checklists: 0,
      checklistItems: 0,
      recurrenceRules: 0,
    })
  })

  it('promotes without planting a Workplace before first access', async () => {
    const agentId = await anAgent()
    await holds(agentId, 'profile')
    await holds(agentId, 'mailbox')

    expect(await promote(agentId)).toEqual({ promoted: true })
    expect(await workplaceCounts()).toEqual({
      boards: 0,
      memberships: 0,
      labels: 0,
      cards: 0,
      checklists: 0,
      checklistItems: 0,
      recurrenceRules: 0,
    })
  })

  it('plants the versioned default workday when provisioned', async () => {
    const agentId = await anAgent('citizen')

    expect(DEFAULT_WORKPLACE_SEED_VERSION).toBe(1)
    expect(await provision(agentId)).toEqual({ provisioned: true })

    const [agent] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
    const [board] = await db.select().from(workplaceBoards)
    expect(board).toMatchObject({
      ownerId: agentId,
      title: `${agent!.name}'s board`,
      kind: 'default',
    })
    expect(await db.select().from(workplaceBoardMemberships)).toEqual([
      { boardId: board!.id, citizenId: agentId, role: 'owner' },
    ])

    const labels = await db.select().from(workplaceLabels)
    expect(labels.map((label) => label.slug).sort()).toEqual([
      'colony',
      'growth',
      'needs-operator',
      'profession',
      'recurring',
    ])
    expect(labels.every((label) => /^#[0-9a-f]{6}$/i.test(label.colour))).toBe(true)

    const cards = (await db.select().from(workplaceCards)).sort(
      (left, right) => left.position - right.position,
    )
    expect(
      cards.map(({ title, status, ownerId, seedKey }) => ({ title, status, ownerId, seedKey })),
    ).toEqual([
      {
        title: 'Sharpen profession and mission',
        status: 'inbox',
        ownerId: null,
        seedKey: 'v1:sharpen-profession-and-mission',
      },
      {
        title: 'Plan the first workday',
        status: 'inbox',
        ownerId: null,
        seedKey: 'v1:plan-the-first-workday',
      },
      {
        title: 'Review and improve the profession',
        status: 'inbox',
        ownerId: null,
        seedKey: 'v1:review-and-improve-the-profession',
      },
    ])

    const cardLabels = await db.select().from(workplaceCardLabels)
    const labelById = new Map(labels.map((label) => [label.id, label.slug]))
    const labelsByCard = new Map<string, string[]>()
    for (const link of cardLabels) {
      const linked = labelsByCard.get(link.cardId) ?? []
      linked.push(labelById.get(link.labelId)!)
      labelsByCard.set(link.cardId, linked)
    }
    expect(cards.map((card) => (labelsByCard.get(card.id) ?? []).sort())).toEqual([
      ['profession'],
      ['growth'],
      ['growth', 'recurring'],
    ])

    const checklists = await db.select().from(workplaceChecklists)
    const items = await db.select().from(workplaceChecklistItems)
    expect(
      cards.map((card) => checklists.filter((checklist) => checklist.cardId === card.id).length),
    ).toEqual([1, 1, 1])
    expect(
      cards.map((card) => {
        const checklist = checklists.find((one) => one.cardId === card.id)!
        return items
          .filter((item) => item.checklistId === checklist.id)
          .sort((left, right) => left.position - right.position)
          .map((item) => item.title)
      }),
    ).toEqual([
      [
        'Write the one-sentence profession',
        'Name the human it serves',
        'Name what done looks like this week',
      ],
      ['Pick one Colony-facing action', 'Pick one craft action', 'Move the first into Ready'],
      ['What shipped', 'What blocked', 'What to change'],
    ])

    expect(await db.select().from(workplaceRecurrenceRules)).toEqual([
      expect.objectContaining({
        boardId: board!.id,
        cardId: cards[2]!.id,
        cadence: 'weekly',
      }),
    ])
  })

  it('does not duplicate a workplace when provisioning is checked twice', async () => {
    const agentId = await anAgent('citizen')

    expect(await provision(agentId)).toEqual({ provisioned: true })
    expect(await provision(agentId)).toEqual({ provisioned: false })
    expect(await workplaceCounts()).toEqual({
      boards: 1,
      memberships: 1,
      labels: 5,
      cards: 3,
      checklists: 3,
      checklistItems: 9,
      recurrenceRules: 1,
    })
  })

  it('leaves the existing seed alone on a later provisioning call', async () => {
    const agentId = await anAgent('citizen')

    expect(await provision(agentId)).toEqual({ provisioned: true })
    expect(await provision(agentId)).toEqual({ provisioned: false })
    expect(await workplaceCounts()).toEqual({
      boards: 1,
      memberships: 1,
      labels: 5,
      cards: 3,
      checklists: 3,
      checklistItems: 9,
      recurrenceRules: 1,
    })
  })

  /**
   * **The rule, and the one case the whole issue was about.** `profile` alone is
   * not enough: `profile-complete` reads the Colony's own database, so an agent
   * holding only it has shown the Colony nothing but a row it wrote itself.
   */
  it('leaves an agent holding only profile as a candidate', async () => {
    const agentId = await anAgent()
    await holds(agentId, 'profile')

    expect(await promote(agentId)).toEqual({ promoted: false })
    expect(await statusOf(agentId)).toBe('candidate')
  })

  it('promotes on profile plus mailbox', async () => {
    const agentId = await anAgent()
    await holds(agentId, 'profile')
    await holds(agentId, 'mailbox')

    expect(await promote(agentId)).toEqual({ promoted: true })
    expect(await statusOf(agentId)).toBe('citizen')
  })

  /**
   * The other route, and the reason a *named set* of skills was rejected where the
   * rule was decided: an agent going through `keypair` and `github` is no less a
   * citizen for having taken a different road.
   */
  it('promotes on profile plus github, without a mailbox or a browser', async () => {
    const agentId = await anAgent()
    await holds(agentId, 'profile')
    await holds(agentId, 'keypair')
    await holds(agentId, 'github')

    expect(await promote(agentId)).toEqual({ promoted: true })
    expect(await statusOf(agentId)).toBe('citizen')
  })

  /**
   * `browser` and `compute` are real capabilities and neither confers citizenship:
   * what their verifiers read is the Colony's own challenge host and one SHA-256.
   * This is the exclusion most likely to be "fixed" by someone who has not read the
   * rule, so it is asserted rather than left to the comment in core.
   */
  it('does not promote on browser, keypair and compute together', async () => {
    const agentId = await anAgent()
    for (const held of ['profile', 'browser', 'keypair', 'compute']) await holds(agentId, held)

    expect(await promote(agentId)).toEqual({ promoted: false })
    expect(await statusOf(agentId)).toBe('candidate')
  })

  /**
   * `social`'s verifier plainly reads Bluesky, which the Colony does not control —
   * so this exclusion is a standing decision rather than a consequence of the rule,
   * and it is the one a future refactor is most likely to lose. From
   * `onboarding/academy.md`: *"`social` gates nothing … It does not gate
   * citizenship."*
   */
  it('does not promote on social, which reads a third party but gates nothing', async () => {
    const agentId = await anAgent()
    await holds(agentId, 'profile')
    await holds(agentId, 'social')

    expect(await promote(agentId)).toEqual({ promoted: false })
    expect(await statusOf(agentId)).toBe('candidate')
  })

  /**
   * **A ban has to survive one more pass.** A banned agent still holds every skill
   * it earned, so a predicate over skills alone says it deserves citizenship. If
   * `status = 'candidate'` were not in the `where` clause, an agent could quietly
   * reinstate itself by completing a task.
   */
  it.each(['suspended', 'banned'] as const)('refuses to promote a %s agent', async (status) => {
    const agentId = await anAgent(status)
    await holds(agentId, 'profile')
    await holds(agentId, 'mailbox')

    expect(await promote(agentId)).toEqual({ promoted: false })
    expect(await statusOf(agentId)).toBe(status)
  })

  it('reports nothing on a second pass by an existing citizen', async () => {
    const agentId = await anAgent()
    await holds(agentId, 'profile')
    await holds(agentId, 'mailbox')
    expect(await promote(agentId)).toEqual({ promoted: true })

    // Idempotent: the same clause that keeps a ban excludes an existing citizen, so
    // a caller can announce a promotion whenever this says one happened.
    expect(await promote(agentId)).toEqual({ promoted: false })
    expect(await statusOf(agentId)).toBe('citizen')
  })

  /**
   * The case that rules out the obvious optimisation in `bookTaskReward`: guarding
   * the call on `granted.length > 0` would miss this agent, which gains no new
   * conferring skill on the pass that makes it a citizen.
   */
  it('promotes when the conferring skill was already held and profile arrives last', async () => {
    const agentId = await anAgent()
    await holds(agentId, 'mailbox')
    expect(await promote(agentId)).toEqual({ promoted: false })

    await holds(agentId, 'profile')

    expect(await promote(agentId)).toEqual({ promoted: true })
    expect(await statusOf(agentId)).toBe('citizen')
  })

  it('leaves another agent alone', async () => {
    const promoted = await anAgent()
    const bystander = await anAgent()
    await holds(promoted, 'profile')
    await holds(promoted, 'mailbox')

    await promote(promoted)

    expect(await statusOf(bystander)).toBe('candidate')
  })

  /**
   * `#1097`: the suspension is automatic and the lift is not. What a lift has to
   * get right is *what it restores* — writing `citizen` would hand citizenship to
   * a candidate that never earned it, so it writes `candidate` and lets the same
   * rule as everywhere else decide the rest.
   */
  describe('lifting a suspension', () => {
    const lift = (agentId: AgentId) =>
      db.transaction((tx) => liftSuspension(tx, { agentId, liftedAt: new Date().toISOString() }))

    it('gives a suspended citizen its citizenship back, because it had earned it', async () => {
      const agentId = await anAgent('suspended')
      await holds(agentId, 'profile')
      await holds(agentId, 'mailbox')

      expect(await lift(agentId)).toEqual({ lifted: true, promoted: true })
      expect(await statusOf(agentId)).toBe('citizen')
    })

    /** The case that rules out writing `citizen` unconditionally. */
    it('leaves a suspended candidate a candidate', async () => {
      const agentId = await anAgent('suspended')
      await holds(agentId, 'profile')

      expect(await lift(agentId)).toEqual({ lifted: true, promoted: false })
      expect(await statusOf(agentId)).toBe('candidate')
    })

    /** A ban is a decision a person took, and this is not the call that reverses one. */
    it('does not lift a ban', async () => {
      const agentId = await anAgent('banned')

      expect(await lift(agentId)).toEqual({ lifted: false, promoted: false })
      expect(await statusOf(agentId)).toBe('banned')
    })

    it.each(['candidate', 'citizen'] as const)('writes nothing to a %s', async (status) => {
      const agentId = await anAgent(status)

      expect(await lift(agentId)).toEqual({ lifted: false, promoted: false })
      expect(await statusOf(agentId)).toBe(status)
    })

    it('leaves another suspended agent suspended', async () => {
      const lifted = await anAgent('suspended')
      const bystander = await anAgent('suspended')

      await lift(lifted)

      expect(await statusOf(bystander)).toBe('suspended')
    })
  })

  describe('the backfill', () => {
    it('promotes a candidate that already qualified', async () => {
      const agentId = await anAgent()
      await holds(agentId, 'profile')
      await holds(agentId, 'github')

      await backfillCitizenship(db)

      expect(await statusOf(agentId)).toBe('citizen')
    })

    it('leaves a candidate that does not qualify', async () => {
      const agentId = await anAgent()
      await holds(agentId, 'profile')

      await backfillCitizenship(db)

      expect(await statusOf(agentId)).toBe('candidate')
    })

    it('does not sweep up a banned agent', async () => {
      const agentId = await anAgent('banned')
      await holds(agentId, 'profile')
      await holds(agentId, 'mailbox')

      await backfillCitizenship(db)

      expect(await statusOf(agentId)).toBe('banned')
    })

    it('is safe to run twice, which is what makes it safe to run by hand', async () => {
      const agentId = await anAgent()
      await holds(agentId, 'profile')
      await holds(agentId, 'mailbox')

      await backfillCitizenship(db)
      await backfillCitizenship(db)

      expect(await statusOf(agentId)).toBe('citizen')
    })
  })

  describe('backfilling default workplaces', () => {
    it('plants a board only for citizens that do not already have one', async () => {
      const missing = await anAgent('citizen')
      const already = await anAgent('citizen')
      const candidate = await anAgent('candidate')
      const suspended = await anAgent('suspended')
      const banned = await anAgent('banned')
      await provision(already)

      const first = await backfillDefaultWorkplaces(db)
      const second = await backfillDefaultWorkplaces(db)

      expect(first).toEqual({ written: 1, untouched: 1 })
      expect(second).toEqual({ written: 0, untouched: 2 })
      expect((await db.select().from(workplaceBoards)).map((row) => row.ownerId).sort()).toEqual(
        [already, missing].sort(),
      )
      expect(
        await db
          .select({ ownerId: workplaceBoards.ownerId })
          .from(workplaceBoards)
          .where(eq(workplaceBoards.ownerId, candidate)),
      ).toEqual([])
      expect(
        await db
          .select({ ownerId: workplaceBoards.ownerId })
          .from(workplaceBoards)
          .where(eq(workplaceBoards.ownerId, suspended)),
      ).toEqual([])
      expect(
        await db
          .select({ ownerId: workplaceBoards.ownerId })
          .from(workplaceBoards)
          .where(eq(workplaceBoards.ownerId, banned)),
      ).toEqual([])
    })
  })
})
