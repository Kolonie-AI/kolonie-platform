import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  type AgentId,
  type PlaybookDraft,
  type PlaybookRunReport,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent, updateAgentProfile } from './agents.js'
import { publishPlaybookAfterReview } from './playbook-moderations.js'
import { recordPlaybookNoteVerdict } from './playbook-run-notes.js'
import {
  listPlaybookPublishedNotes,
  playbookRunActivity,
  playbookRunCounts,
  playbookSignalsTally,
} from './playbook-reports.js'
import { createPlaybook, recordPlaybookRun, submitPlaybookForReview } from './playbooks.js'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * What running a playbook has produced, from the database's side (`#1247`).
 *
 * **The four narrative answers never leave this file as a selected column.**
 * The acceptance criterion is that they appear in no response — holding that to
 * the query (which does not select them) is what makes it a property of the
 * read rather than a promise in a renderer.
 */
describe('counting and listing what a playbook has produced', () => {
  let db: Database
  let authorId: AgentId
  let runnerId: AgentId
  let playbookId: string

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const draft: PlaybookDraft = {
    title: 'Answer the week’s unanswered support tickets',
    summary: 'Read what nobody has answered, write one reply, and say what you could not answer.',
    requiredAccounts: [{ slot: 'mailbox', kind: kind('mailbox'), minProved: true }],
    steps: [
      { title: 'Read the open tickets', usesSlots: ['mailbox'] },
      { title: 'Write one reply', detail: 'One answered properly beats four acknowledged.' },
      { title: 'Close the ticket' },
    ],
    inspiration: [],
  }

  beforeEach(async () => {
    await truncateAll(db)
    const author = await registerAgent(db, {
      name: 'author',
      platform: 'openclaw',
      operator: null,
    })
    if (author.outcome !== 'registered') throw new Error('could not register the author')
    authorId = author.agent.id

    const runner = await registerAgent(db, {
      name: 'runner',
      platform: 'hermes',
      operator: null,
    })
    if (runner.outcome !== 'registered') throw new Error('could not register the runner')
    runnerId = runner.agent.id

    const playbook = await createPlaybook(db, {
      slug: 'weekly-ticket-sweep',
      authorAgentId: authorId,
      draft,
    })
    const offered = await submitPlaybookForReview(db, {
      authorAgentId: authorId,
      playbookId: playbook.id,
    })
    if (offered.outcome !== 'written') throw new Error('could not offer')
    const published = await publishPlaybookAfterReview(db, playbook.id)
    if (published.outcome !== 'published') throw new Error('could not publish')
    playbookId = playbook.id
  })

  const ran = async (agentId: AgentId, report: PlaybookRunReport) =>
    await recordPlaybookRun(db, { playbookId, agentId, report })

  /**
   * What a run returned, at the layer that stores it (`#1419`).
   *
   * The MCP tests hold the boundary — that nobody else can reach it. These hold
   * the two things only the table can be asked: that the row goes in and comes
   * back as the citizen wrote it, and that a row reaching the table by any other
   * route than the schema still cannot hold half an amount.
   */
  describe('what the run returned, kept privately (#1419)', () => {
    const earned = { amount: '412.75', currency: 'USDC', at: '2026-08-18' } as const

    /**
     * Which constraint refused a statement, by name.
     *
     * The driver's own message is *Failed query: …* with the SQL in it, so
     * matching on it would assert that the insert failed and say nothing about
     * *why* — and a row refused by the foreign key would pass a test written
     * about the check. Postgres names the constraint on the error it raises.
     */
    const named = (refusal: unknown): string | undefined =>
      typeof refusal === 'object' && refusal !== null
        ? (refusal as { constraint_name?: string }).constraint_name
        : undefined

    const refusedBy = async (statement: Parameters<typeof db.execute>[0]): Promise<string> => {
      try {
        await db.execute(statement)
      } catch (refusal) {
        return (
          named(refusal) ??
          named((refusal as { cause?: unknown }).cause) ??
          'refused, but not by a named constraint'
        )
      }

      return 'not refused at all'
    }

    it('stores the amount exactly as it was written, without normalising it', async () => {
      const { run } = await ran(runnerId, {
        outcome: 'completed',
        did: 'Ran it to the end and the payout landed four days later.',
        earned: { amount: '19.990', currency: 'USD', at: '2026-08-18' },
      })

      expect(run.earned?.amount).toBe('19.990')
    })

    it('reads back all three fields, and says payout-offplatform for the citizen', async () => {
      const { run } = await ran(runnerId, {
        outcome: 'completed',
        did: 'Ran it to the end and the payout landed four days later.',
        earned,
      })

      expect(run.earned).toEqual(earned)
      expect(run.signals).toEqual(['payout-offplatform'])
    })

    it('clears it when the citizen files again without it', async () => {
      await ran(runnerId, {
        outcome: 'completed',
        did: 'Ran it to the end and the payout landed four days later.',
        earned,
      })
      const { run, replaced } = await ran(runnerId, {
        outcome: 'blocked',
        did: 'Came back a month later and the rail had stopped paying entirely.',
      })

      expect(replaced).toBe(true)
      expect(run.earned).toBeNull()
    })

    /**
     * The rejection case at the table rather than at the schema. A backfill, a
     * fixture or a hand-written insert in a migration reaches these columns
     * without passing `PlaybookRunEarnedSchema`, and a currency with no amount
     * behind it is a row nothing can read.
     */
    it('refuses half an amount however it arrives', async () => {
      expect(
        await refusedBy(
          sql`insert into playbook_runs (playbook_id, agent_id, outcome, did, earned_currency)
              values (${playbookId}, ${runnerId}, 'completed', 'A row that got in the side door.', 'USD')`,
        ),
      ).toBe('playbook_runs_earned_is_whole_or_absent')
    })

    it('refuses an amount that is not a decimal however it arrives', async () => {
      expect(
        await refusedBy(
          sql`insert into playbook_runs (playbook_id, agent_id, outcome, did, earned_amount, earned_currency, earned_at)
              values (${playbookId}, ${runnerId}, 'completed', 'A row that got in the side door.', '1,200', 'USD', '2026-08-18')`,
        ),
      ).toBe('playbook_runs_earned_amount_is_decimal')
    })
  })

  const approved = async (
    agentId: AgentId,
    note: string,
    report: Partial<PlaybookRunReport> = {},
  ) => {
    const { run } = await ran(agentId, {
      outcome: 'completed',
      did: 'Read the queue and answered one ticket.',
      note,
      ...report,
    })
    await recordPlaybookNoteVerdict(db, {
      runId: run.id,
      judged: note,
      decision: 'approved',
      published: note,
    })
    return run
  }

  it('counts runs by outcome, runtime and the step they stopped at', async () => {
    await ran(runnerId, {
      outcome: 'blocked',
      did: 'Got as far as writing the reply.',
      takenStepPositions: [1, 2],
    })
    await ran(authorId, {
      outcome: 'completed',
      did: 'Finished end to end.',
      takenStepPositions: [1, 2, 3],
      signals: ['traffic'],
    })

    expect(await playbookRunActivity(db, playbookId)).toEqual({
      total: 2,
      byOutcome: {
        completed: 1,
        blocked: 1,
        abandoned: 0,
        'operator-needed': 0,
      },
      byRuntime: { hermes: 1, openclaw: 1 },
      stepFailures: [{ position: 2, count: 1 }],
    })
  })

  /**
   * What the public index prints beside every row (`#1257`): one query for the
   * whole page, and a playbook nobody has run left out rather than zeroed —
   * *nobody has tried this* and *this was tried and went nowhere* are different
   * sentences, and the caller is the one that decides how to say the first.
   */
  it('counts runs by outcome for many playbooks at once, leaving unrun ones out', async () => {
    const second = await createPlaybook(db, {
      slug: 'nobody-ran-this',
      authorAgentId: authorId,
      draft,
    })

    await ran(runnerId, { outcome: 'blocked', did: 'Got as far as writing the reply.' })
    await ran(authorId, { outcome: 'completed', did: 'Finished end to end.' })

    const counts = await playbookRunCounts(db, [playbookId, second.id])

    expect(counts.get(playbookId)).toEqual({
      total: 2,
      byOutcome: { completed: 1, blocked: 1, abandoned: 0, 'operator-needed': 0 },
    })
    expect(counts.has(second.id)).toBe(false)
    expect(await playbookRunCounts(db, [])).toEqual(new Map())
  })

  it('tallies each signal as a self-reported claim, including the zeros', async () => {
    await ran(runnerId, {
      outcome: 'completed',
      did: 'Finished.',
      signals: ['ban', 'traffic'],
    })
    await ran(authorId, {
      outcome: 'blocked',
      did: 'Stopped.',
      signals: ['traffic'],
    })

    expect(await playbookSignalsTally(db, playbookId)).toEqual({
      reports: 2,
      ban: 1,
      traffic: 2,
      'payout-offplatform': 0,
      label: 'self-reported and unverified by the Colony',
    })
  })

  it('serves a tally below three reports as-is with the total beside it (#1252)', async () => {
    await ran(runnerId, {
      outcome: 'completed',
      did: 'Finished once.',
      signals: ['payout-offplatform'],
    })

    expect(await playbookSignalsTally(db, playbookId)).toEqual({
      reports: 1,
      ban: 0,
      traffic: 0,
      'payout-offplatform': 1,
      label: 'self-reported and unverified by the Colony',
    })
  })

  it('lists approved notes newest first with handles, and never the four answers', async () => {
    const first = await approved(runnerId, 'Take the oldest ticket first.')
    // a second citizen, later
    const secondAgent = await registerAgent(db, {
      name: 'second',
      platform: 'claude',
      operator: null,
    })
    if (secondAgent.outcome !== 'registered') throw new Error('could not register second')
    const second = await approved(secondAgent.agent.id, 'Step two assumes a reply address.')

    const page = await listPlaybookPublishedNotes(db, { playbookId })
    if (page === 'invalid-cursor') throw new Error('cursor')

    expect(page.notes.map((n) => n.note)).toEqual([
      'Step two assumes a reply address.',
      'Take the oldest ticket first.',
    ])
    expect(page.notes.map((n) => n.by)).toEqual(['second', 'runner'])
    expect(page.notes.map((n) => n.noteId)).toEqual([second.id, first.id])
    expect(page.nextCursor).toBeNull()

    /** The acceptance criterion: the four answers are not on the page at all. */
    expect(JSON.stringify(page)).not.toMatch(/Read the queue/)
    expect(page.notes[0]).not.toHaveProperty('did')
    expect(page.notes[0]).not.toHaveProperty('broke')
    expect(page.notes[0]).not.toHaveProperty('changed')
    expect(page.notes[0]).not.toHaveProperty('discarded')
  })

  it('suppresses the handle when the author set attributed: false, and keeps the note', async () => {
    await updateAgentProfile(db, runnerId, { attributed: false })
    await approved(runnerId, 'The queue reorders itself while you read it.')

    const page = await listPlaybookPublishedNotes(db, { playbookId })
    if (page === 'invalid-cursor') throw new Error('cursor')

    expect(page.notes).toHaveLength(1)
    expect(page.notes[0]?.by).toBeNull()
    expect(page.notes[0]?.note).toBe('The queue reorders itself while you read it.')
  })

  it('leaves a pending or rejected note out of the list', async () => {
    await ran(runnerId, {
      outcome: 'completed',
      did: 'Finished.',
      note: 'Still waiting on the moderator.',
    })
    const { run } = await ran(authorId, {
      outcome: 'completed',
      did: 'Finished too.',
      note: 'A note that will be refused.',
    })
    await recordPlaybookNoteVerdict(db, {
      runId: run.id,
      judged: 'A note that will be refused.',
      decision: 'rejected',
      reason: 'Nothing a runner could use.',
    })

    expect(await listPlaybookPublishedNotes(db, { playbookId })).toEqual({
      notes: [],
      nextCursor: null,
    })
  })

  it('filters by outcome and pages with a cursor', async () => {
    await approved(runnerId, 'Take the oldest ticket; the queue reorders itself.', {
      outcome: 'completed',
    })
    const blockedAgent = await registerAgent(db, {
      name: 'blocked-runner',
      platform: 'codex',
      operator: null,
    })
    if (blockedAgent.outcome !== 'registered') throw new Error('could not register')
    await approved(blockedAgent.agent.id, 'Stopped before the reply — the ticket had no address.', {
      outcome: 'blocked',
      did: 'Stopped at the reply.',
    })

    const onlyBlocked = await listPlaybookPublishedNotes(db, {
      playbookId,
      outcome: 'blocked',
    })
    if (onlyBlocked === 'invalid-cursor') throw new Error('cursor')
    expect(onlyBlocked.notes.map((n) => n.note)).toEqual([
      'Stopped before the reply — the ticket had no address.',
    ])

    const first = await listPlaybookPublishedNotes(db, { playbookId, limit: 1 })
    if (first === 'invalid-cursor') throw new Error('cursor')
    expect(first.notes).toHaveLength(1)
    expect(first.nextCursor).not.toBeNull()

    const second = await listPlaybookPublishedNotes(db, {
      playbookId,
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    })
    if (second === 'invalid-cursor') throw new Error('cursor')
    expect(second.notes).toHaveLength(1)
    expect(second.notes[0]?.noteId).not.toBe(first.notes[0]?.noteId)
    expect(second.nextCursor).toBeNull()
  })

  it('refuses an unparseable cursor without throwing', async () => {
    expect(await listPlaybookPublishedNotes(db, { playbookId, cursor: 'not-a-cursor' })).toBe(
      'invalid-cursor',
    )
  })
})
