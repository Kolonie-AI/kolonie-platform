import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { AgentIdSchema, type AgentId, type CitizenshipStatus } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSkills, agents, submissions, tasks } from '../schema/index.js'
import {
  BACKFILL_CITIZENSHIP_SQL,
  backfillCitizenship,
  CITIZENSHIP_MIGRATION,
  promoteIfEarned,
} from './citizenship.js'
import { connectForTests, databaseTestTarget, MIGRATIONS_FOLDER, truncateAll } from '../testing.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

/** The copy check, and it needs no database. */
describe('the citizenship backfill statement', () => {
  it('is the one the migration ran', async () => {
    const migration = await readFile(join(MIGRATIONS_FOLDER, CITIZENSHIP_MIGRATION), 'utf8')

    expect(migration).toContain(BACKFILL_CITIZENSHIP_SQL.replace(/;$/, ''))
  })
})

describe.skipIf(!target.available)('promoting a candidate to citizen', () => {
  let db: Database

  beforeAll(async () => {
    if (!target.available) return
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
        rewardCoins: 0,
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
})
