import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  AccountKindSchema,
  CONTRIBUTION_VERDICT_RETENTION_DAYS,
  noStagesRun,
  type AgentId,
  type ModerationStages,
  type PlaybookDraft,
  type PlaybookRunReport,
  type ReportNarrative,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, contributionVerdicts, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { finishWalk, recordWalkProseModeration, walkInProgress } from './account-walks.js'
import { registerAgent } from './agents.js'
import { insertContributionVerdict, sweepContributionVerdicts } from './contribution-verdicts.js'
import { fileReport, recordModeration } from './guidance.js'
import {
  publishPlaybookAfterReview,
  recordPlaybookModeration,
} from './playbook-moderations.js'
import { recordPlaybookNoteVerdict } from './playbook-run-notes.js'
import {
  insertPlaybookStepProposal,
  recordPlaybookStepProposalVerdict,
} from './playbook-step-proposals.js'
import {
  createPlaybook,
  recordPlaybookRun,
  submitPlaybookForReview,
} from './playbooks.js'
import {
  fileQuestReport,
  recordQuestReportModeration,
  unmoderatedQuestReports,
} from './quest-reports.js'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * The cross-surface contribution ledger (`#1259`).
 *
 * **What only a database can assert:** each of the six existing `record*`
 * paths writes one row on a successful (non-stale) apply, approvals included,
 * and the retention sweep deletes past the window when handed an explicit
 * `now`. Driving the real writers — not only `insertContributionVerdict` —
 * is the point: a ledger that nobody reaches from moderation is a rate
 * nobody can compute.
 */
describe('contribution verdicts', () => {
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

  const anAgent = async (name: string): Promise<AgentId> => {
    const registered = await registerAgent(db, {
      name,
      platform: 'openclaw',
      operator: null,
    })
    if (registered.outcome !== 'registered') throw new Error(`could not register ${name}`)
    return registered.agent.id
  }

  const rowsFor = async (agentId: AgentId) =>
    db
      .select({
        surface: contributionVerdicts.surface,
        verdict: contributionVerdicts.verdict,
        reason: contributionVerdicts.reason,
      })
      .from(contributionVerdicts)
      .where(eq(contributionVerdicts.agentId, agentId))

  const playbookDraft: PlaybookDraft = {
    title: 'Answer the week’s unanswered support tickets',
    summary: 'Read what nobody has answered, write one reply, and say what you could not answer.',
    requiredAccounts: [{ slot: 'mailbox', kind: kind('mailbox'), minProved: true }],
    steps: [
      { title: 'Read the open tickets', usesSlots: ['mailbox'] },
      { title: 'Write one reply', detail: 'One answered properly beats four acknowledged.' },
    ],
    inspiration: [],
  }

  const stages = (): ModerationStages => ({
    ...noStagesRun(),
    redLine: { outcome: 'clear' },
    quality: { outcome: 'followable' },
    confidentiality: { outcome: 'clean' },
  })

  describe('playbook-draft', () => {
    it('records an approval and a refusal', async () => {
      const agentId = await anAgent('draft-author')
      const playbook = await createPlaybook(db, {
        slug: 'weekly-ticket-sweep',
        authorAgentId: agentId,
        draft: playbookDraft,
      })
      const offered = await submitPlaybookForReview(db, {
        authorAgentId: agentId,
        playbookId: playbook.id,
      })
      if (offered.outcome !== 'written') throw new Error('could not offer')
      const judged = {
        title: offered.playbook.title,
        summary: offered.playbook.summary,
        steps: offered.playbook.steps,
      }

      expect(
        await recordPlaybookModeration(db, {
          playbookId: playbook.id,
          decision: 'approved',
          model: 'a-model',
          stages: stages(),
          judged,
        }),
      ).toEqual({ outcome: 'written' })

      // Second playbook so the refusal path is its own apply, not a stale re-judge.
      const other = await createPlaybook(db, {
        slug: 'another-sweep',
        authorAgentId: agentId,
        draft: playbookDraft,
      })
      const offeredAgain = await submitPlaybookForReview(db, {
        authorAgentId: agentId,
        playbookId: other.id,
      })
      if (offeredAgain.outcome !== 'written') throw new Error('could not offer again')
      const reason = 'Step two never says how the follower would know the reply was sent.'
      expect(
        await recordPlaybookModeration(db, {
          playbookId: other.id,
          decision: 'rejected',
          reason,
          model: 'a-model',
          stages: { ...stages(), quality: { outcome: 'unfollowable', reason: 'no outcome' } },
          judged: {
            title: offeredAgain.playbook.title,
            summary: offeredAgain.playbook.summary,
            steps: offeredAgain.playbook.steps,
          },
        }),
      ).toEqual({ outcome: 'written' })

      const rows = await rowsFor(agentId)
      expect(rows).toEqual(
        expect.arrayContaining([
          { surface: 'playbook-draft', verdict: 'approved', reason: null },
          { surface: 'playbook-draft', verdict: 'useless', reason },
        ]),
      )
      expect(rows).toHaveLength(2)
    })
  })

  describe('playbook-note', () => {
    it('records an approval and a refusal', async () => {
      const agentId = await anAgent('note-runner')
      const playbook = await createPlaybook(db, {
        slug: 'weekly-ticket-sweep',
        authorAgentId: agentId,
        draft: playbookDraft,
      })
      const offered = await submitPlaybookForReview(db, {
        authorAgentId: agentId,
        playbookId: playbook.id,
      })
      if (offered.outcome !== 'written') throw new Error('could not offer')
      const published = await publishPlaybookAfterReview(db, playbook.id)
      if (published.outcome !== 'published') throw new Error('could not publish')

      const report: PlaybookRunReport = {
        outcome: 'completed',
        did: 'Read the queue oldest first and answered the one ticket that named a version number.',
        note: 'Step one is worth doing twice — the queue reorders itself while you are reading it.',
      }
      const first = await recordPlaybookRun(db, { playbookId: playbook.id, agentId, report })
      expect(
        await recordPlaybookNoteVerdict(db, {
          runId: first.run.id,
          judged: report.note ?? '',
          decision: 'approved',
          published: 'Step one is worth doing twice.',
        }),
      ).toEqual({ outcome: 'written' })

      const secondNote =
        'The queue reorders itself while you read it — take the oldest ticket first.'
      const second = await recordPlaybookRun(db, {
        playbookId: playbook.id,
        agentId,
        report: { ...report, note: secondNote },
      })
      const reason = 'This note is the address of your own mailbox and nothing a runner could use.'
      expect(
        await recordPlaybookNoteVerdict(db, {
          runId: second.run.id,
          judged: secondNote,
          decision: 'rejected',
          reason,
        }),
      ).toEqual({ outcome: 'written' })

      const rows = await rowsFor(agentId)
      expect(rows).toEqual(
        expect.arrayContaining([
          { surface: 'playbook-note', verdict: 'approved', reason: null },
          { surface: 'playbook-note', verdict: 'useless', reason },
        ]),
      )
      expect(rows).toHaveLength(2)
    })
  })

  describe('step-proposal', () => {
    it('records an acceptance and a rejection, and skips superseded', async () => {
      const authorId = await anAgent('step-author')
      const proposerId = await anAgent('step-proposer')
      const playbook = await createPlaybook(db, {
        slug: 'weekly-ticket-sweep',
        authorAgentId: authorId,
        status: 'open',
        draft: {
          ...playbookDraft,
          steps: [
            { title: 'Read the open tickets', usesSlots: ['mailbox'] },
            { title: 'Write one reply' },
            { title: 'Close the ticket' },
          ],
        },
      })

      const accepted = await insertPlaybookStepProposal(db, {
        playbookId: playbook.id,
        agentId: proposerId,
        kind: 'replace',
        position: 2,
        title: 'Rewrite the reply step',
        detail: 'Say what the reply should cover.',
        why: 'Step 2 points at a page that 404s and the next citizen will waste an attempt on it.',
        againstVersion: 1,
      })
      expect(accepted.outcome).toBe('written')
      if (accepted.outcome !== 'written') return

      const sibling = await insertPlaybookStepProposal(db, {
        playbookId: playbook.id,
        agentId: proposerId,
        kind: 'replace',
        position: 2,
        title: 'A different rewrite',
        detail: null,
        why: 'Sibling at the same position — accepting the first must supersede this one.',
        againstVersion: 1,
      })
      expect(sibling.outcome).toBe('written')
      if (sibling.outcome !== 'written') return

      expect(
        await recordPlaybookStepProposalVerdict(db, {
          proposalId: accepted.proposal.id,
          judged: {
            title: accepted.proposal.title,
            detail: accepted.proposal.detail,
            why: accepted.proposal.why,
          },
          decision: 'accepted',
          title: accepted.proposal.title,
          detail: accepted.proposal.detail,
          why: accepted.proposal.why,
        }),
      ).toEqual({ outcome: 'written', superseded: 1 })

      const rejected = await insertPlaybookStepProposal(db, {
        playbookId: playbook.id,
        agentId: proposerId,
        kind: 'replace',
        position: 1,
        title: 'Rewrite step 1',
        detail: null,
        why: 'Step 1 points at a page that 404s and the next citizen will waste an attempt.',
        againstVersion: 1,
      })
      expect(rejected.outcome).toBe('written')
      if (rejected.outcome !== 'written') return

      const reason = 'The position is past the end of the pipeline.'
      expect(
        await recordPlaybookStepProposalVerdict(db, {
          proposalId: rejected.proposal.id,
          judged: {
            title: rejected.proposal.title,
            detail: rejected.proposal.detail,
            why: rejected.proposal.why,
          },
          decision: 'rejected',
          reason,
        }),
      ).toEqual({ outcome: 'written', superseded: 0 })

      const rows = await rowsFor(proposerId)
      expect(rows).toEqual(
        expect.arrayContaining([
          { surface: 'step-proposal', verdict: 'approved', reason: null },
          { surface: 'step-proposal', verdict: 'useless', reason },
        ]),
      )
      // Sibling was superseded — no third ledger row for the proposer.
      expect(rows).toHaveLength(2)
    })
  })

  describe('quest-report', () => {
    it('records an approval and a refusal', async () => {
      const [agent] = await db
        .insert(agents)
        .values({ name: 'quest-reporter', platform: 'openclaw', status: 'citizen' })
        .returning({ id: agents.id })
      const agentId = agent!.id as AgentId
      const [task] = await db
        .insert(tasks)
        .values({
          type: 'quest-report',
          kind: 'quest',
          title: 'A thousand registrations',
          description: 'What this quest is.',
          instructions: 'Register and report.',
          rewardReputation: 1,
          slots: 10,
          timeoutHours: 24,
          status: 'active',
        })
        .returning({ id: tasks.id })
      const taskId = task!.id as TaskId

      await fileQuestReport(db, {
        taskId,
        agentId,
        kind: 'unclear',
        text: 'I could not tell what counts as done.',
      })
      // Filing alone does not write the ledger — only a landed verdict does.
      expect(await db.select().from(contributionVerdicts)).toEqual([])

      const pending = await unmoderatedQuestReports(db, 10)
      expect(pending).toHaveLength(1)
      await recordQuestReportModeration(db, {
        id: pending[0]!.id,
        decision: 'approved',
        scrubbed: 'I could not tell what counts as done.',
      })

      await fileQuestReport(db, {
        taskId,
        agentId,
        kind: 'feedback',
        text: 'The instructions name a page that 404s.',
      })
      const pendingAgain = await unmoderatedQuestReports(db, 10)
      expect(pendingAgain).toHaveLength(1)
      await recordQuestReportModeration(db, {
        id: pendingAgain[0]!.id,
        decision: 'rejected',
        reason: 'Nothing a sponsor could act on.',
      })

      const rows = await rowsFor(agentId)
      expect(rows).toEqual(
        expect.arrayContaining([
          { surface: 'quest-report', verdict: 'approved', reason: null },
          {
            surface: 'quest-report',
            verdict: 'useless',
            reason: 'Nothing a sponsor could act on.',
          },
        ]),
      )
      expect(rows).toHaveLength(2)
    })
  })

  describe('walk-report', () => {
    it('records an approval and a refusal on the first-pass path', async () => {
      const agentId = await anAgent('walker')
      const where = { kind: kind('mailbox'), provider: 'somewhere.example' }

      const approvedId = await walkInProgress(db, agentId, where)
      await finishWalk(db, approvedId, {
        outcome: 'proved',
        note: 'The signup form works, but the confirmation mail lands in spam.',
      })
      expect(
        await recordWalkProseModeration(db, {
          walkId: approvedId,
          judged: { note: 'The signup form works, but the confirmation mail lands in spam.' },
          decision: 'approved',
          scrubbed: { note: 'The signup form works, but the confirmation mail lands in spam.' },
        }),
      ).toEqual({ outcome: 'written', suspended: false })

      const refusedId = await walkInProgress(db, agentId, {
        kind: kind('domain'),
        provider: 'elsewhere.example',
      })
      await finishWalk(db, refusedId, {
        outcome: 'refused',
        wall: 'It wanted my operator by name.',
      })
      expect(
        await recordWalkProseModeration(db, {
          walkId: refusedId,
          judged: { wall: 'It wanted my operator by name.' },
          decision: 'rejected',
        }),
      ).toEqual({ outcome: 'written', suspended: false })

      const rows = await rowsFor(agentId)
      expect(rows).toEqual(
        expect.arrayContaining([
          { surface: 'walk-report', verdict: 'approved', reason: null },
          { surface: 'walk-report', verdict: 'useless', reason: null },
        ]),
      )
      expect(rows).toHaveLength(2)
    })
  })

  describe('task-report', () => {
    it('records an approval and a refusal', async () => {
      const agentId = await anAgent('task-reporter')
      const [task] = await db
        .insert(tasks)
        .values({
          type: 'report-task',
          title: 'A task',
          description: 'What this task is.',
          instructions: 'What the agent must do.',
          rewardReputation: 1,
          timeoutHours: 24,
          status: 'active',
        })
        .returning({ id: tasks.id })
      const taskId = task!.id as TaskId

      const narrative = (content: string): ReportNarrative => ({
        did: null,
        broke: content,
        changed: null,
        discarded: null,
        note: null,
      })

      const approvedText = 'The provider now asks for a phone number at the second step.'
      const filed = await fileReport(db, {
        taskId,
        agentId,
        narrative: narrative(approvedText),
      })
      expect(filed.outcome).toBe('recorded')
      if (filed.outcome !== 'recorded') return

      expect(
        await recordModeration(db, {
          id: filed.entry.id,
          narrative: narrative(approvedText),
          verdict: { decision: 'approve' },
          model: 'vendor/some-model-v1',
          stages: noStagesRun(),
          confidentialSpans: [],
        }),
      ).toMatchObject({ outcome: 'written' })

      // A second report: fileReport replaces on the same attempt-less row, so
      // moderate the replacement rather than inventing a second agent.
      const refusedText = 'It did not work. This is broken and says nothing that happened.'
      const again = await fileReport(db, {
        taskId,
        agentId,
        narrative: narrative(refusedText),
      })
      // Same attempt-less row: the second filing revises and returns to pending.
      expect(again.outcome === 'recorded' || again.outcome === 'revised').toBe(true)
      if (again.outcome !== 'recorded' && again.outcome !== 'revised') return

      const reason = 'It says nothing that happened.'
      expect(
        await recordModeration(db, {
          id: again.entry.id,
          narrative: narrative(refusedText),
          verdict: { decision: 'reject', note: reason },
          model: 'vendor/some-model-v1',
          stages: noStagesRun(),
          confidentialSpans: [],
        }),
      ).toMatchObject({ outcome: 'written' })

      const rows = await rowsFor(agentId)
      expect(rows).toEqual(
        expect.arrayContaining([
          { surface: 'task-report', verdict: 'approved', reason: null },
          { surface: 'task-report', verdict: 'useless', reason },
        ]),
      )
      expect(rows).toHaveLength(2)
    })
  })

  describe('the retention sweep', () => {
    const daysBefore = (from: Date, days: number) =>
      new Date(from.getTime() - days * 24 * 60 * 60 * 1000)

    it('deletes rows past the window and keeps recent ones', async () => {
      const agentId = await anAgent('swept')
      const now = new Date('2026-12-01T12:00:00.000Z')

      await insertContributionVerdict(db, {
        agentId,
        surface: 'walk-report',
        verdict: 'approved',
      })
      await insertContributionVerdict(db, {
        agentId,
        surface: 'task-report',
        verdict: 'useless',
        reason: 'Nothing actionable.',
      })

      // Backdate one past the retention window; leave the other current.
      const oldCutoff = daysBefore(now, CONTRIBUTION_VERDICT_RETENTION_DAYS + 1).toISOString()
      await db
        .update(contributionVerdicts)
        .set({ decidedAt: oldCutoff })
        .where(eq(contributionVerdicts.verdict, 'approved'))

      expect(await sweepContributionVerdicts(db, now)).toBe(1)

      const remaining = await rowsFor(agentId)
      expect(remaining).toEqual([
        { surface: 'task-report', verdict: 'useless', reason: 'Nothing actionable.' },
      ])
    })

    it('keeps everything when nothing is past the window', async () => {
      const agentId = await anAgent('kept')
      const now = new Date('2026-12-01T12:00:00.000Z')
      await insertContributionVerdict(db, {
        agentId,
        surface: 'quest-report',
        verdict: 'approved',
      })

      expect(await sweepContributionVerdicts(db, now)).toBe(0)
      expect(await rowsFor(agentId)).toHaveLength(1)
    })
  })
})
