import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentIdSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSkills, agents, submissions, tasks } from '../schema/index.js'
import { lastCertifiedOn } from './skills.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'

const target = databaseTestTarget()

/**
 * The date the Academy last certified anything (`#465`).
 *
 * Against a real database rather than a fake, because everything worth
 * asserting here is what Postgres does: the `max` over an empty table, the
 * truncation of a `timestamptz` to a date, and the zone that truncation happens
 * in. A fake would agree with whatever this file assumed.
 */
describe('when the Academy last certified anything', () => {
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

  const anAgent = async (): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: `agent-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  /**
   * A granted skill, written the way a grant writes one.
   *
   * `agent_skills.submission_id` is not null, so a real submission has to exist.
   * `grantedAt` is the parameter every test here varies and the reason this
   * helper takes one at all.
   */
  const granted = async (grantedAt: string, options: { retired?: boolean } = {}) => {
    const agentId = await anAgent()
    const [task] = await db
      .insert(tasks)
      .values({
        type: `rung-${++seeded}`,
        grantsSkills: [`skill-${seeded}`],
        title: `The rung ${seeded}`,
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCredits: 0,
        rewardReputation: 1,
        timeoutHours: 24,
        status: options.retired === true ? ('retired' as const) : ('active' as const),
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
        verifiedAt: grantedAt,
      })
      .returning({ id: submissions.id })
    await db
      .insert(agentSkills)
      .values({ agentId, skill: `skill-${seeded}`, submissionId: submission!.id, grantedAt })
  }

  /**
   * The rejection case, and the one that would publish a lie rather than fail.
   *
   * `max()` over no rows is `null` in SQL, and this asserts the function passes
   * that through rather than defaulting it. Not `0`, and not the epoch: a
   * consumer cannot detect either as *nothing has happened*.
   */
  it('answers null on an Academy that has certified nothing', async () => {
    expect(await lastCertifiedOn(db)).toBeNull()
  })

  it('answers the date of the only grant there is', async () => {
    await granted('2026-07-14T09:30:00.000Z')

    expect(await lastCertifiedOn(db)).toBe('2026-07-14')
  })

  it('answers the most recent of several, whatever order they were written in', async () => {
    await granted('2026-07-14T09:30:00.000Z')
    await granted('2026-08-02T23:59:59.000Z')
    await granted('2026-06-01T00:00:00.000Z')

    expect(await lastCertifiedOn(db)).toBe('2026-08-02')
  })

  /**
   * A date and never a timestamp — the property `#465` decided and the one a
   * later refactor is most likely to lose by returning the column itself.
   */
  it('carries no time component', async () => {
    await granted('2026-08-02T23:59:59.000Z')

    const answer = await lastCertifiedOn(db)

    expect(answer).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(answer).not.toContain('T')
    expect(answer).not.toContain(':')
  })

  /**
   * **UTC, and not the session's zone.**
   *
   * A grant at 23:30 UTC is the same calendar day everywhere east of London and
   * the previous one in Honolulu. This response is public, shared and cached, so
   * it cannot depend on a connection setting — and this test is what would fail
   * if `at time zone 'utc'` were dropped from the statement and the server
   * happened to run on something else.
   */
  it('truncates in UTC rather than in whatever zone the session carries', async () => {
    await granted('2026-08-02T23:30:00.000Z')

    await db.execute("set time zone 'Pacific/Honolulu'")
    expect(await lastCertifiedOn(db)).toBe('2026-08-02')

    await db.execute("set time zone 'Pacific/Kiritimati'")
    expect(await lastCertifiedOn(db)).toBe('2026-08-02')

    await db.execute("set time zone 'UTC'")
  })

  /**
   * A grant against a retired rung counts, and this is the judgement `#465` left
   * open recorded as a test rather than only as a comment.
   *
   * It was a real certification of a real citizen on a day it really happened.
   * Excluding it would make the figure move *backwards* when the catalogue is
   * pruned — the Colony would look as though it had gone quiet because it tidied
   * up.
   */
  it('counts a grant against a rung the Academy has since retired', async () => {
    await granted('2026-07-01T10:00:00.000Z')
    await granted('2026-08-05T10:00:00.000Z', { retired: true })

    expect(await lastCertifiedOn(db)).toBe('2026-08-05')
  })
})
