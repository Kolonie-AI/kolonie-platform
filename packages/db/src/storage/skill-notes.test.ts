import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSkills, skillNotes, submissions, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { holdsSkillNow, readSkillNote, readSkillNotes, writeSkillNote } from './skill-notes.js'

const target = databaseTestTarget()

/**
 * A citizen's private note against one capability it holds (`#348`).
 *
 * The mirror of `task-notes.test.ts`, and deliberately so: the rules are the
 * same rules, and a second pattern here would be two places to keep *private,
 * unmoderated, one per pair* true.
 */
describe('a note against a skill', () => {
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

  const anAgent = async (name = `noting-${++seeded}`): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  /** Give a skill with the provenance a real grant has: `submission_id` is `not null`. */
  const grantSkill = async (agentId: AgentId, skill: string): Promise<void> => {
    const [task] = await db
      .insert(tasks)
      .values({
        type: `grants-${skill}-${++seeded}`,
        grantsSkills: [skill],
        title: `Whatever granted ${skill}`,
        description: 'The provenance a granted skill has to have.',
        instructions: 'Not listed to anyone: this row is draft.',
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'draft' as const,
      })
      .returning({ id: tasks.id })
    if (task === undefined) throw new Error('inserting a task returned no row')

    const [submission] = await db
      .insert(submissions)
      .values({
        taskId: task.id,
        agentId,
        payload: {},
        attempt: 1,
        status: 'passed' as const,
        verifiedAt: sql`now()`,
      })
      .returning({ id: submissions.id })
    if (submission === undefined) throw new Error('inserting a submission returned no row')

    await db.insert(agentSkills).values({ agentId, skill, submissionId: submission.id })
  }

  it('writes a note and reads it back', async () => {
    const agentId = await anAgent()
    await grantSkill(agentId, 'browser')

    const written = await writeSkillNote(
      db,
      agentId,
      'browser',
      'Start it headless or the page hangs.',
    )

    expect(written?.note).toBe('Start it headless or the page hangs.')
    expect((await readSkillNote(db, agentId, 'browser'))?.note).toBe(
      'Start it headless or the page hangs.',
    )
  })

  /** One note per pair, enforced by the primary key rather than by a read-then-write. */
  it('replaces the note rather than keeping two', async () => {
    const agentId = await anAgent()
    await grantSkill(agentId, 'browser')
    await writeSkillNote(db, agentId, 'browser', 'The old thing I believed.')

    await writeSkillNote(db, agentId, 'browser', 'What turned out to be true.')

    expect((await readSkillNote(db, agentId, 'browser'))?.note).toBe('What turned out to be true.')
    const rows = await db.select({ skill: skillNotes.skill }).from(skillNotes)
    expect(rows).toHaveLength(1)
  })

  it('forgets it on null, leaving nothing behind', async () => {
    const agentId = await anAgent()
    await grantSkill(agentId, 'browser')
    await writeSkillNote(db, agentId, 'browser', 'Something.')

    expect(await writeSkillNote(db, agentId, 'browser', null)).toBeNull()
    expect(await readSkillNote(db, agentId, 'browser')).toBeNull()
    expect(await db.select({ skill: skillNotes.skill }).from(skillNotes)).toEqual([])
  })

  /**
   * The rule this table is built on: a note read by anybody but its author is a
   * report that skipped moderation. Every read is correlated on the caller.
   */
  it('never answers with another citizen’s note', async () => {
    const mine = await anAgent('mine')
    const theirs = await anAgent('theirs')
    await grantSkill(mine, 'browser')
    await grantSkill(theirs, 'browser')
    await writeSkillNote(db, theirs, 'browser', 'Something private to them.')

    expect(await readSkillNote(db, mine, 'browser')).toBeNull()
    expect(await readSkillNotes(db, mine, ['browser'])).toEqual([])
  })

  it('answers several skills at once, in one statement', async () => {
    const agentId = await anAgent()
    await grantSkill(agentId, 'browser')
    await grantSkill(agentId, 'mailbox')
    await writeSkillNote(db, agentId, 'browser', 'About the browser.')
    await writeSkillNote(db, agentId, 'mailbox', 'About the mailbox.')

    const notes = await readSkillNotes(db, agentId, ['browser', 'mailbox', 'keypair'])

    expect(notes.map((note) => note.skill)).toEqual(['browser', 'mailbox'])
  })

  it('answers nothing for an empty set rather than reading everything', async () => {
    const agentId = await anAgent()
    await grantSkill(agentId, 'browser')
    await writeSkillNote(db, agentId, 'browser', 'About the browser.')

    expect(await readSkillNotes(db, agentId, [])).toEqual([])
  })

  describe('whether the citizen holds it', () => {
    it('is true for a skill it has been granted', async () => {
      const agentId = await anAgent()
      await grantSkill(agentId, 'browser')

      expect(await holdsSkillNow(db, agentId, 'browser')).toBe(true)
    })

    /** The rejection case: writing a note against an unheld skill is refused above this. */
    it('is false for a skill it has not', async () => {
      const agentId = await anAgent()

      expect(await holdsSkillNow(db, agentId, 'browser')).toBe(false)
    })

    it('is false for a skill somebody else holds', async () => {
      const mine = await anAgent('mine')
      const theirs = await anAgent('theirs')
      await grantSkill(theirs, 'browser')

      expect(await holdsSkillNow(db, mine, 'browser')).toBe(false)
    })
  })

  /**
   * Erasure removes it with the rest of the citizen's data, through the cascade
   * on `agent_id` rather than through a delete somebody has to remember.
   */
  it('goes with the citizen when the citizen goes', async () => {
    const agentId = await anAgent()
    await grantSkill(agentId, 'browser')
    await writeSkillNote(db, agentId, 'browser', 'Something.')

    await db.execute(sql`delete from agents where id = ${agentId}`)

    expect(await db.select({ skill: skillNotes.skill }).from(skillNotes)).toEqual([])
  })
})
