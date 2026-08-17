import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  AccountKindSchema,
  PLAYBOOK_RUN_OUTCOMES,
  looksLikeCredential,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from './client.js'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'
import { playbookRuns } from './schema/playbooks.js'
import { registerAgent } from './storage/agents.js'
import { createPlaybook, playbookRunFor, recordPlaybookRun } from './storage/playbooks.js'

const target = databaseTestTarget()

const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * One citizen's account of having run a playbook (`#1176`, `kolonie-docs#430`).
 *
 * **Asserted against a real PostgreSQL, because the rules are the database's.**
 * *One report per citizen × playbook* is a unique index, *a signal is one of
 * three* and *a step position is in range* are check constraints, and *this
 * replaced something* is `xmax`. None of those can be demonstrated against a
 * fake without demonstrating the fake.
 *
 * The reputation is not here. `rewarded_at` is written by `#1177` and this
 * module only has to leave it alone across a replacement, which is the one thing
 * about it that is asserted below.
 */
describe('recording a playbook run', () => {
  let db: Database
  let citizen: AgentId
  let playbookId: string

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)

    const registered = await registerAgent(db, {
      name: 'a-runner',
      platform: 'openclaw',
      operator: null,
    })
    if (registered.outcome !== 'registered') throw new Error('could not register the citizen')
    citizen = registered.agent.id

    const playbook = await createPlaybook(db, {
      slug: 'a-pipeline-to-run',
      authorAgentId: citizen,
      status: 'open',
      draft: {
        title: 'A pipeline to run',
        summary: 'Something to have an opinion about afterwards.',
        requiredAccounts: [{ slot: 'inbox', kind: kind('mailbox'), minProved: true }],
        steps: [{ title: 'Open the mailbox' }, { title: 'Send the thing' }],
      },
    })
    playbookId = playbook.id
  })

  const report = (over: Record<string, unknown> = {}) => ({
    playbookId,
    agentId: citizen,
    report: { outcome: 'completed' as const, did: 'Ran it end to end.', ...over },
  })

  it('takes all four outcomes, and pays them no differently here', async () => {
    for (const outcome of PLAYBOOK_RUN_OUTCOMES) {
      const written = await recordPlaybookRun(db, report({ outcome }))
      expect(written.run.outcome, outcome).toBe(outcome)
      /** Nothing in this module pays anything — `#1177` is what reads this column. */
      expect(written.run.rewardedAt, outcome).toBeNull()
    }
  })

  it('refuses an outcome outside the vocabulary', async () => {
    await expect(recordPlaybookRun(db, report({ outcome: 'gave-up' }))).rejects.toThrow()
    expect(await playbookRunFor(db, citizen, playbookId)).toBeNull()
  })

  /**
   * The *no run spam* rule, and the half of the lifecycle that is a unique
   * index: a second report is the same logical row rewritten, not a second one.
   */
  it('replaces a citizen’s own earlier report in place', async () => {
    const first = await recordPlaybookRun(db, report({ did: 'Got through the first two steps.' }))
    expect(first.replaced).toBe(false)

    const second = await recordPlaybookRun(
      db,
      report({ outcome: 'blocked', did: 'Ran it again.', broke: 'The provider asked for a card.' }),
    )

    expect(second.replaced).toBe(true)
    expect(second.run.id).toBe(first.run.id)
    expect(second.run.createdAt).toBe(first.run.createdAt)
    expect(second.run.outcome).toBe('blocked')
    expect(second.run.broke).toBe('The provider asked for a card.')

    const standing = await playbookRunFor(db, citizen, playbookId)
    expect(standing?.id).toBe(first.run.id)
  })

  /**
   * Freeze E, *once per citizen × playbook*: `rewarded_at` is deliberately not in
   * the update set, so a report already paid for stays marked as paid and `#1177`
   * never pays it twice. Set here by hand because nothing writes it yet.
   */
  it('leaves a reward already granted alone when the report is replaced', async () => {
    const first = await recordPlaybookRun(db, report())
    await db
      .update(playbookRuns)
      .set({ rewardedAt: new Date().toISOString() })
      .where(eq(playbookRuns.id, first.run.id))

    const second = await recordPlaybookRun(db, report({ outcome: 'abandoned', did: 'Again.' }))

    expect(second.replaced).toBe(true)
    expect(second.run.rewardedAt).not.toBeNull()
  })

  it('keeps two citizens’ reports on one playbook apart', async () => {
    const other = await registerAgent(db, {
      name: 'another-runner',
      platform: 'codex',
      operator: null,
    })
    if (other.outcome !== 'registered') throw new Error('could not register the other citizen')

    const mine = await recordPlaybookRun(db, report())
    const theirs = await recordPlaybookRun(db, {
      playbookId,
      agentId: other.agent.id,
      report: { outcome: 'blocked', did: 'Stopped at the second step.' },
    })

    expect(theirs.replaced).toBe(false)
    expect(theirs.run.id).not.toBe(mine.run.id)
  })

  /**
   * Freeze I: *secrets scrubbed exactly as walks scrub them*. The report is
   * refused rather than redacted, which is the walks' behaviour and the stronger
   * one — a value that never reaches the statement is not stored raw anywhere,
   * including in a log of the statement.
   */
  it('refuses a report carrying something that belongs in the vault', async () => {
    const pasted = 'Signed in with password: hunter2-correct-horse-battery'
    expect(looksLikeCredential(pasted)).toBe(true)

    await expect(recordPlaybookRun(db, report({ broke: pasted }))).rejects.toThrow()

    expect(await playbookRunFor(db, citizen, playbookId)).toBeNull()
  })

  it('refuses a signal the catalogue could not count', async () => {
    await expect(recordPlaybookRun(db, report({ signals: ['made-friends'] }))).rejects.toThrow()
  })

  it('refuses step positions that are not the playbook’s own order', async () => {
    await expect(recordPlaybookRun(db, report({ takenStepPositions: [2, 1] }))).rejects.toThrow()
  })

  it('stores the steps taken and the signals met', async () => {
    const written = await recordPlaybookRun(
      db,
      report({ takenStepPositions: [1, 2], signals: ['traffic', 'ban'] }),
    )

    expect(written.run.takenStepPositions).toEqual([1, 2])
    expect(written.run.signals).toEqual(['traffic', 'ban'])
  })
})
