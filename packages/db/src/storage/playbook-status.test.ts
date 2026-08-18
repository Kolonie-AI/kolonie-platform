import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  PLAYBOOK_BLOCKED_MIN_BLOCKED,
  PLAYBOOK_BLOCKED_REPORT_WINDOW,
  type AgentId,
  type PlaybookDraft,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { publishPlaybookAfterReview } from './playbook-moderations.js'
import { acceptedUnfoldedPlaybookStepProposals, cutPlaybookRevision } from './playbook-revisions.js'
import {
  blockPlaybook,
  evaluatePlaybookBlocked,
  openPlaybooksForBlockedCheck,
  playbookMeetsBlockedThreshold,
  playbookStatusHistory,
} from './playbook-status.js'
import {
  insertPlaybookStepProposal,
  recordPlaybookStepProposalVerdict,
} from './playbook-step-proposals.js'
import {
  createPlaybook,
  playbookById,
  recordPlaybookRun,
  submitPlaybookForReview,
} from './playbooks.js'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

describe('playbook blocked status (#1256)', () => {
  let db: Database
  let authorId: AgentId
  let playbookId: string

  const draft: PlaybookDraft = {
    title: 'Sweep the unanswered tickets',
    summary: 'Read what nobody answered and write one reply.',
    requiredAccounts: [{ slot: 'mailbox', kind: kind('mailbox'), minProved: true }],
    steps: [
      { title: 'Read the open tickets', usesSlots: ['mailbox'] },
      { title: 'Write one reply' },
    ],
    inspiration: [],
  }

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    const author = await registerAgent(db, {
      name: 'status-author',
      platform: 'openclaw',
      operator: null,
    })
    if (author.outcome !== 'registered') throw new Error('could not register')
    authorId = author.agent.id

    const playbook = await createPlaybook(db, {
      slug: 'blocked-threshold-playbook',
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

  async function seedRuns(args: {
    readonly blocked: number
    readonly completed?: number
    readonly abandoned?: number
  }): Promise<void> {
    let n = 0
    for (let i = 0; i < args.blocked; i++) {
      const runner = await registerAgent(db, {
        name: `blocked-runner-${n++}`,
        platform: 'openclaw',
        operator: null,
      })
      if (runner.outcome !== 'registered') throw new Error('register failed')
      await recordPlaybookRun(db, {
        playbookId,
        agentId: runner.agent.id,
        report: {
          outcome: 'blocked',
          did: `Hit a wall on run ${i}.`,
          broke: 'The provider refused the login.',
        },
      })
    }
    for (let i = 0; i < (args.completed ?? 0); i++) {
      const runner = await registerAgent(db, {
        name: `completed-runner-${n++}`,
        platform: 'openclaw',
        operator: null,
      })
      if (runner.outcome !== 'registered') throw new Error('register failed')
      await recordPlaybookRun(db, {
        playbookId,
        agentId: runner.agent.id,
        report: { outcome: 'completed', did: `Finished run ${i}.` },
      })
    }
    for (let i = 0; i < (args.abandoned ?? 0); i++) {
      const runner = await registerAgent(db, {
        name: `abandoned-runner-${n++}`,
        platform: 'openclaw',
        operator: null,
      })
      if (runner.outcome !== 'registered') throw new Error('register failed')
      await recordPlaybookRun(db, {
        playbookId,
        agentId: runner.agent.id,
        report: { outcome: 'abandoned', did: `Stopped on run ${i}.` },
      })
    }
  }

  it('does not meet the threshold with fewer than PLAYBOOK_BLOCKED_MIN_BLOCKED blocked runs', async () => {
    await seedRuns({ blocked: PLAYBOOK_BLOCKED_MIN_BLOCKED - 1 })
    const threshold = await playbookMeetsBlockedThreshold(db, playbookId)
    expect(threshold.meets).toBe(false)
    expect(threshold.blocked).toBe(PLAYBOOK_BLOCKED_MIN_BLOCKED - 1)
    expect(threshold.completed).toBe(0)
  })

  it('does not meet the threshold when any recent run completed', async () => {
    await seedRuns({ blocked: PLAYBOOK_BLOCKED_MIN_BLOCKED, completed: 1 })
    const threshold = await playbookMeetsBlockedThreshold(db, playbookId)
    expect(threshold.meets).toBe(false)
    expect(threshold.completed).toBe(1)
  })

  it('sets blocked on the threshold and records who and why', async () => {
    await seedRuns({ blocked: PLAYBOOK_BLOCKED_MIN_BLOCKED })
    expect(await openPlaybooksForBlockedCheck(db, 10)).toContain(playbookId)

    const result = await evaluatePlaybookBlocked(db, playbookId)
    expect(result.outcome).toBe('transitioned')
    if (result.outcome !== 'transitioned') throw new Error('expected transition')
    expect(result.playbook.status).toBe('blocked')
    expect(result.playbook.statusChangedBy).toBe('moderation')
    expect(result.playbook.statusReason).toContain(`${PLAYBOOK_BLOCKED_MIN_BLOCKED}`)
    expect(result.playbook.statusReason).toContain(`${PLAYBOOK_BLOCKED_REPORT_WINDOW}`)
    expect(result.playbook.statusChangedAt).not.toBeNull()

    const history = await playbookStatusHistory(db, playbookId)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      fromStatus: 'open',
      toStatus: 'blocked',
      decidedBy: 'moderation',
    })
  })

  it('clears blocked when a new revision is cut, recording the clear', async () => {
    await seedRuns({ blocked: PLAYBOOK_BLOCKED_MIN_BLOCKED })
    expect((await blockPlaybook(db, { playbookId, reason: 'seeded for clear test' })).outcome).toBe(
      'transitioned',
    )

    const proposer = await registerAgent(db, {
      name: 'status-proposer',
      platform: 'openclaw',
      operator: null,
    })
    if (proposer.outcome !== 'registered') throw new Error('could not register proposer')

    const filed = await insertPlaybookStepProposal(db, {
      playbookId,
      agentId: proposer.agent.id,
      kind: 'replace',
      position: 2,
      title: 'Write one careful reply',
      detail: null,
      why: 'The bare reply step is where runners stall on the second attempt.',
      againstVersion: 1,
    })
    if (filed.outcome !== 'written') throw new Error('could not file proposal')
    const verdict = await recordPlaybookStepProposalVerdict(db, {
      proposalId: filed.proposal.id,
      judged: {
        title: filed.proposal.title,
        detail: filed.proposal.detail,
        why: filed.proposal.why,
      },
      decision: 'accepted',
      title: filed.proposal.title,
      detail: filed.proposal.detail,
      why: filed.proposal.why,
    })
    expect(verdict.outcome).toBe('written')
    expect(await acceptedUnfoldedPlaybookStepProposals(db, playbookId)).toHaveLength(1)

    const cut = await cutPlaybookRevision(db, playbookId)
    expect(cut.outcome).toBe('cut')

    const playbook = await playbookById(db, playbookId)
    expect(playbook?.status).toBe('open')
    expect(playbook?.version).toBe(2)
    expect(playbook?.statusChangedBy).toBe('moderation')
    expect(playbook?.statusReason).toContain('Revision 2')

    const history = await playbookStatusHistory(db, playbookId)
    expect(history.map((row) => `${row.fromStatus}->${row.toStatus}`)).toEqual([
      'blocked->open',
      'open->blocked',
    ])
  })
})
