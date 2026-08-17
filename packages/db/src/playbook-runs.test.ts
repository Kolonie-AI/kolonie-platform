import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  AccountKindSchema,
  PLAYBOOK_RUN_OUTCOMES,
  PLAYBOOK_RUN_REPUTATION,
  looksLikeCredential,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from './client.js'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'
import { reputationEvents } from './schema/reputation.js'
import { registerAgent } from './storage/agents.js'
import {
  createPlaybook,
  grantPlaybookRunReputation,
  playbookRunFor,
  recordPlaybookRun,
} from './storage/playbooks.js'

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
 * **The reputation is here too** (`#1177`). It is granted in the same
 * transaction as the write rather than by a sweep, so *what a report earned* is
 * a property of `recordPlaybookRun` and is asserted against the same database as
 * the rest — including the one rule that only a database can hold, which is that
 * a second report earns nothing further.
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

  /** What the citizen has earned in total, from the ledger and not from a return value. */
  const banked = async (agentId: AgentId = citizen) => {
    const events = await db
      .select()
      .from(reputationEvents)
      .where(eq(reputationEvents.agentId, agentId))
    return events.reduce((sum, event) => sum + event.delta, 0)
  }

  it('takes all four outcomes', async () => {
    for (const outcome of PLAYBOOK_RUN_OUTCOMES) {
      const written = await recordPlaybookRun(db, report({ outcome }))
      expect(written.run.outcome, outcome).toBe(outcome)
    }
  })

  /**
   * Freeze E, the whole of it: *2 reputation, once per citizen × playbook, the
   * same for every outcome*. Each outcome is tried on its own playbook so that
   * what is being asserted is the price of the outcome and not the order they
   * happen to be reported in.
   */
  it('pays every outcome the same', async () => {
    for (const outcome of PLAYBOOK_RUN_OUTCOMES) {
      const book = await createPlaybook(db, {
        slug: `a-pipeline-that-ends-${outcome}`,
        authorAgentId: citizen,
        status: 'open',
        draft: {
          title: `A pipeline that ends ${outcome}`,
          summary: 'One playbook per outcome, so the price is the outcome’s own.',
          requiredAccounts: [],
          steps: [{ title: 'Run it' }],
        },
      })

      const written = await recordPlaybookRun(db, {
        playbookId: book.id,
        agentId: citizen,
        report: { outcome, did: 'Ran it, and this is what came of it.' },
      })

      expect(written.granted, outcome).toBe(PLAYBOOK_RUN_REPUTATION)
      expect(written.run.rewardedAt, outcome).not.toBeNull()
    }

    expect(await banked()).toBe(PLAYBOOK_RUN_REPUTATION * PLAYBOOK_RUN_OUTCOMES.length)
  })

  it('writes a ledger entry a citizen can see, under its own reason', async () => {
    await recordPlaybookRun(db, report())

    const [event, ...rest] = await db
      .select()
      .from(reputationEvents)
      .where(eq(reputationEvents.agentId, citizen))

    expect(rest).toEqual([])
    expect(event?.delta).toBe(PLAYBOOK_RUN_REPUTATION)
    expect(event?.reason).toBe('playbook_run')
    /** The memo names the playbook, because *2 reputation* on its own answers nothing. */
    expect(event?.memo).toContain('a-pipeline-to-run')
    expect(event?.memo).toContain('completed')
  })

  it('pays a second report on the same playbook nothing further', async () => {
    const first = await recordPlaybookRun(db, report())
    const second = await recordPlaybookRun(db, report({ outcome: 'blocked', did: 'Again.' }))

    expect(first.granted).toBe(PLAYBOOK_RUN_REPUTATION)
    expect(second.granted).toBe(0)
    expect(second.replaced).toBe(true)
    /** Still paid, and paid at the moment the first report was filed. */
    expect(second.run.rewardedAt).toBe(first.run.rewardedAt)
    expect(await banked()).toBe(PLAYBOOK_RUN_REPUTATION)
  })

  it('pays the same citizen again for a different playbook', async () => {
    const other = await createPlaybook(db, {
      slug: 'another-pipeline-to-run',
      authorAgentId: citizen,
      status: 'open',
      draft: {
        title: 'Another pipeline to run',
        summary: 'Independent of the first, which is the point.',
        requiredAccounts: [],
        steps: [{ title: 'Run it' }],
      },
    })

    await recordPlaybookRun(db, report())
    const second = await recordPlaybookRun(db, {
      playbookId: other.id,
      agentId: citizen,
      report: { outcome: 'completed', did: 'Ran the other one too.' },
    })

    expect(second.granted).toBe(PLAYBOOK_RUN_REPUTATION)
    expect(await banked()).toBe(PLAYBOOK_RUN_REPUTATION * 2)
  })

  /**
   * The grant is also callable on its own — a backfill or a repair, and what a
   * retry lands on. Claiming is `rewarded_at is null` in the `update` itself, so
   * a second call finds nothing to claim rather than paying twice.
   */
  it('grants nothing on a second pass over a run already paid for', async () => {
    const written = await recordPlaybookRun(db, report())

    expect(await grantPlaybookRunReputation(db, written.run.id)).toEqual([])
    expect(await grantPlaybookRunReputation(db)).toEqual([])
    expect(await banked()).toBe(PLAYBOOK_RUN_REPUTATION)
  })

  /** A report that failed to write is a report that was not paid for. */
  it('pays nothing for a report the database refused', async () => {
    await expect(recordPlaybookRun(db, report({ signals: ['made-friends'] }))).rejects.toThrow()

    expect(await playbookRunFor(db, citizen, playbookId)).toBeNull()
    expect(await banked()).toBe(0)
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
