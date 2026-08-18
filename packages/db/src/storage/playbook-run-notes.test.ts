import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  PLAYBOOK_RUN_REPUTATION,
  type AgentId,
  type PlaybookDraft,
  type PlaybookRunReport,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { reputationOfAgent } from './balance.js'
import { publishPlaybookAfterReview } from './playbook-moderations.js'
import { pendingPlaybookNotes, recordPlaybookNoteVerdict } from './playbook-run-notes.js'
import {
  createPlaybook,
  playbookRunFor,
  recordPlaybookRun,
  submitPlaybookForReview,
} from './playbooks.js'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * The run-note queue and its verdict (`#1246`).
 *
 * **The property the rest of the file exists to protect is the last one: a
 * refused note costs its author nothing.** The report stands, the four answers
 * stand, the signals stand and the reputation `#1177` already paid stands — a
 * moderator that took any of those back would make filing a note a gamble, and
 * the notes worth reading are the ones a citizen was not nervous about writing.
 */
describe('judging the note on a run report', () => {
  let db: Database
  let agentId: AgentId
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
    ],
    inspiration: [],
  }

  const report: PlaybookRunReport = {
    outcome: 'completed',
    did: 'Read the queue oldest first and answered the one ticket that named a version number.',
    note: 'Step one is worth doing twice — the queue reorders itself while you are reading it.',
  }

  beforeEach(async () => {
    await truncateAll(db)
    const agent = await registerAgent(db, { name: 'runner', platform: 'openclaw', operator: null })
    if (agent.outcome !== 'registered') throw new Error('could not register the running agent')
    agentId = agent.agent.id

    const playbook = await createPlaybook(db, {
      slug: 'weekly-ticket-sweep',
      authorAgentId: agentId,
      draft,
    })
    const offered = await submitPlaybookForReview(db, {
      authorAgentId: agentId,
      playbookId: playbook.id,
    })
    if (offered.outcome !== 'written') throw new Error('could not offer the playbook')
    const published = await publishPlaybookAfterReview(db, playbook.id)
    if (published.outcome !== 'published') throw new Error('could not publish the playbook')
    playbookId = playbook.id
  })

  const ran = async (overrides: Partial<PlaybookRunReport> = {}) =>
    await recordPlaybookRun(db, {
      playbookId,
      agentId,
      report: { ...report, ...overrides },
    })

  it('queues the note with the pipeline it is about', async () => {
    const { run } = await ran()

    expect(await pendingPlaybookNotes(db, 10)).toEqual([
      {
        runId: run.id,
        playbookId,
        playbookTitle: draft.title,
        playbookSummary: draft.summary,
        outcome: 'completed',
        note: report.note,
      },
    ])
  })

  /** A report is a report with or without a note; only the note is judged. */
  it('leaves a report that said nothing out of the queue', async () => {
    await ran({ note: undefined })

    expect(await pendingPlaybookNotes(db, 10)).toHaveLength(0)
    expect((await playbookRunFor(db, agentId, playbookId))?.noteStatus).toBeNull()
  })

  it('publishes what the moderator approved and drops it out of the queue', async () => {
    const { run } = await ran()
    const published = 'Step one is worth doing twice.'

    expect(
      await recordPlaybookNoteVerdict(db, {
        runId: run.id,
        judged: report.note ?? '',
        decision: 'approved',
        published,
      }),
    ).toEqual({ outcome: 'written' })

    const judged = await playbookRunFor(db, agentId, playbookId)
    expect(judged?.noteStatus).toBe('approved')
    expect(judged?.notePublished).toBe(published)
    expect(judged?.noteRejectionReason).toBeNull()
    expect(await pendingPlaybookNotes(db, 10)).toHaveLength(0)
  })

  it('keeps a refused note out of sight and gives its author the reason', async () => {
    const { run } = await ran()
    const reason = 'This note is the address of your own mailbox and nothing a runner could use.'

    expect(
      await recordPlaybookNoteVerdict(db, {
        runId: run.id,
        judged: report.note ?? '',
        decision: 'rejected',
        reason,
      }),
    ).toEqual({ outcome: 'written' })

    const judged = await playbookRunFor(db, agentId, playbookId)
    expect(judged?.noteStatus).toBe('rejected')
    expect(judged?.notePublished).toBeNull()
    expect(judged?.noteRejectionReason).toBe(reason)
    /** The author's own text is kept: the refusal is about publication, not about the report. */
    expect(judged?.note).toBe(report.note)
  })

  /**
   * `#1246`'s acceptance criterion, and the reason this file exists.
   *
   * Everything the run report is made of is compared before and after the
   * refusal, rather than field by field — a later column added to the report and
   * quietly cleared by a verdict would slip through an enumerated assertion and
   * cannot slip through this one.
   */
  it('leaves the report, the answers, the signals and the reputation untouched', async () => {
    const { run, granted } = await ran({
      broke: 'Nothing broke, but step two assumes a reply address the ticket does not carry.',
      changed: 'I read the queue oldest first this time instead of newest first.',
      discarded: 'I did not try answering in bulk: the tickets have nothing in common.',
      takenStepPositions: [1, 2],
      signals: ['traffic'],
    })
    expect(granted).toBe(PLAYBOOK_RUN_REPUTATION)
    const before = await playbookRunFor(db, agentId, playbookId)
    const paid = await reputationOfAgent(db, agentId)

    await recordPlaybookNoteVerdict(db, {
      runId: run.id,
      judged: report.note ?? '',
      decision: 'rejected',
      reason: 'Nothing here a runner could act on.',
    })

    const after = await playbookRunFor(db, agentId, playbookId)
    expect(after).toEqual({
      ...before,
      noteStatus: 'rejected',
      noteRejectionReason: 'Nothing here a runner could act on.',
    })
    expect(await reputationOfAgent(db, agentId)).toBe(paid)
  })

  /**
   * The three ways a verdict arrives against text nobody is offering any more.
   * All three are `stale` rather than an error: a citizen re-filing its report
   * while a judge is thinking is ordinary, and the new note is judged on its own
   * turn.
   */
  describe('a verdict that arrived too late', () => {
    it('is dropped when the note has been rewritten', async () => {
      const { run } = await ran()
      const rewritten =
        'The queue reorders itself while you read it — take the oldest ticket first.'
      await ran({ note: rewritten })

      expect(
        await recordPlaybookNoteVerdict(db, {
          runId: run.id,
          judged: report.note ?? '',
          decision: 'approved',
          published: 'Take the oldest ticket first.',
        }),
      ).toEqual({ outcome: 'stale' })

      const standing = await playbookRunFor(db, agentId, playbookId)
      expect(standing?.note).toBe(rewritten)
      expect(standing?.noteStatus).toBe('pending')
      expect(standing?.notePublished).toBeNull()
    })

    it('is dropped when somebody else judged it first', async () => {
      const { run } = await ran()
      const judged = report.note ?? ''
      await recordPlaybookNoteVerdict(db, {
        runId: run.id,
        judged,
        decision: 'approved',
        published: 'Step one is worth doing twice.',
      })

      expect(
        await recordPlaybookNoteVerdict(db, {
          runId: run.id,
          judged,
          decision: 'rejected',
          reason: 'A second opinion that arrived second.',
        }),
      ).toEqual({ outcome: 'stale' })

      expect((await playbookRunFor(db, agentId, playbookId))?.noteStatus).toBe('approved')
    })

    it('is dropped when the run is gone', async () => {
      expect(
        await recordPlaybookNoteVerdict(db, {
          runId: '00000000-0000-4000-8000-000000000000',
          judged: report.note ?? '',
          decision: 'approved',
          published: 'Step one is worth doing twice.',
        }),
      ).toEqual({ outcome: 'stale' })
    })
  })

  /**
   * A re-filed report is unjudged again — `recordPlaybookRun` clears the three
   * note columns — so the queue has to take it back, and at the position its
   * *current* sentence earned rather than the one its first report did.
   */
  it('takes a re-filed note back into the queue', async () => {
    const { run } = await ran()
    await recordPlaybookNoteVerdict(db, {
      runId: run.id,
      judged: report.note ?? '',
      decision: 'rejected',
      reason: 'Nothing here a runner could act on.',
    })
    expect(await pendingPlaybookNotes(db, 10)).toHaveLength(0)

    const second = 'Take the oldest ticket first; the queue reorders itself while you read it.'
    await ran({ note: second })

    expect(await pendingPlaybookNotes(db, 10)).toMatchObject([{ runId: run.id, note: second }])
    const standing = await playbookRunFor(db, agentId, playbookId)
    expect(standing?.noteRejectionReason).toBeNull()
  })
})
