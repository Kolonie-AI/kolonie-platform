import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema, type AgentId, type PlaybookDraft } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent, updateAgentProfile } from './agents.js'
import {
  cutPlaybookRevision,
  diffPlaybookSteps,
  latestPlaybookRevision,
  playbookContributors,
  playbookRevisionByNumber,
  playbookRevisionHistory,
  playbookRevisionsFor,
  playbooksWithAcceptedUnfoldedProposals,
} from './playbook-revisions.js'
import {
  insertPlaybookStepProposal,
  pendingPlaybookStepProposalsForModeration,
  recordPlaybookStepProposalVerdict,
} from './playbook-step-proposals.js'
import {
  createPlaybook,
  playbookById,
  recordPlaybookRun,
  updatePlaybookDraft,
} from './playbooks.js'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * Playbook revisions and contributors (`#1255`).
 *
 * The fold, the fold-refusal park, the revision cut on create/edit, the run
 * stamp, and the attributed gate on contributors are the properties a fixture
 * cannot assert — they live in the transaction and the partial indexes.
 */
describe('playbook revisions', () => {
  let db: Database
  let authorId: AgentId
  let proposerId: AgentId
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
      { title: 'Write one reply' },
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

    const proposer = await registerAgent(db, {
      name: 'proposer',
      platform: 'hermes',
      operator: null,
    })
    if (proposer.outcome !== 'registered') throw new Error('could not register the proposer')
    proposerId = proposer.agent.id

    const playbook = await createPlaybook(db, {
      slug: 'weekly-ticket-sweep',
      authorAgentId: authorId,
      status: 'open',
      draft,
    })
    playbookId = playbook.id
  })

  const accept = async (input: {
    readonly agentId: AgentId
    readonly kind: 'replace' | 'insert-after' | 'remove'
    readonly position: number
    readonly title: string | null
    readonly detail?: string | null
    readonly why?: string
    readonly againstVersion?: number
  }) => {
    const written = await insertPlaybookStepProposal(db, {
      playbookId,
      agentId: input.agentId,
      kind: input.kind,
      position: input.position,
      title: input.title,
      detail: input.detail ?? null,
      why:
        input.why ??
        'Step points at a page that 404s and the next citizen will waste an attempt on it.',
      againstVersion: input.againstVersion ?? 1,
    })
    expect(written.outcome).toBe('written')
    if (written.outcome !== 'written') throw new Error('proposal was not written')

    const verdict = await recordPlaybookStepProposalVerdict(db, {
      proposalId: written.proposal.id,
      judged: {
        title: written.proposal.title,
        detail: written.proposal.detail,
        why: written.proposal.why,
      },
      decision: 'accepted',
      title: written.proposal.title,
      detail: written.proposal.detail,
      why: written.proposal.why,
    })
    expect(verdict.outcome).toBe('written')
    return written.proposal
  }

  it('cuts revision 1 on create, with empty proposal ids', async () => {
    const revisions = await playbookRevisionsFor(db, playbookId)
    expect(revisions).toHaveLength(1)
    expect(revisions[0]).toMatchObject({
      playbookId,
      revision: 1,
      proposalIds: [],
      steps: draft.steps,
    })
    expect(await latestPlaybookRevision(db, playbookId)).toMatchObject({ revision: 1 })
  })

  it('cuts a revision on a draft edit that bumps the version', async () => {
    const editable = await createPlaybook(db, {
      slug: 'draft-pipeline',
      authorAgentId: authorId,
      status: 'draft',
      draft,
    })
    const updated = await updatePlaybookDraft(db, {
      authorAgentId: authorId,
      playbookId: editable.id,
      patch: { title: 'Answer the week’s unanswered tickets, carefully' },
    })
    expect(updated.outcome).toBe('written')
    if (updated.outcome !== 'written') return

    expect(updated.playbook.version).toBe(2)
    const revision = await playbookRevisionByNumber(db, editable.id, 2)
    expect(revision).toMatchObject({
      revision: 2,
      proposalIds: [],
      steps: draft.steps,
    })
  })

  it('folds an accepted proposal into revision 2 and stamps foldedAt', async () => {
    const proposal = await accept({
      agentId: proposerId,
      kind: 'replace',
      position: 2,
      title: 'Write one careful reply',
      detail: 'Say what the reply should cover.',
    })

    expect(await playbooksWithAcceptedUnfoldedProposals(db, 10)).toEqual([playbookId])

    const cut = await cutPlaybookRevision(db, playbookId)
    expect(cut.outcome).toBe('cut')
    if (cut.outcome !== 'cut') return

    expect(cut.folded).toBe(1)
    expect(cut.revision).toMatchObject({
      revision: 2,
      proposalIds: [proposal.id],
    })
    expect(cut.revision.steps.map((one) => one.title)).toEqual([
      'Read the open tickets',
      'Write one careful reply',
      'Close the ticket',
    ])
    // Replace keeps the step’s usesSlots (none on step 2).
    expect(cut.revision.steps[1]).toEqual({
      title: 'Write one careful reply',
      detail: 'Say what the reply should cover.',
    })

    const live = await playbookById(db, playbookId)
    expect(live?.version).toBe(2)
    expect(live?.steps.map((one) => one.title)).toEqual([
      'Read the open tickets',
      'Write one careful reply',
      'Close the ticket',
    ])

    expect(await playbooksWithAcceptedUnfoldedProposals(db, 10)).toEqual([])
  })

  it('returns incoherent proposals to pending with a fold refusal, out of moderation', async () => {
    // Three removes leave an empty step list — PlaybookDraftSchema refuses.
    await accept({
      agentId: proposerId,
      kind: 'remove',
      position: 1,
      title: null,
      why: 'Step 1 is redundant with the mailbox check the citizen already passed.',
    })
    await accept({
      agentId: proposerId,
      kind: 'remove',
      position: 2,
      title: null,
      why: 'Step 2 duplicates the reply the citizen already drafts elsewhere.',
    })
    await accept({
      agentId: proposerId,
      kind: 'remove',
      position: 3,
      title: null,
      why: 'Step 3 is implied by writing the reply; drop it.',
    })

    const cut = await cutPlaybookRevision(db, playbookId)
    expect(cut.outcome).toBe('incoherent')
    if (cut.outcome !== 'incoherent') return
    expect(cut.returned).toBe(3)
    expect(cut.reason.length).toBeGreaterThan(0)

    const live = await playbookById(db, playbookId)
    expect(live?.version).toBe(1)
    expect(live?.steps).toEqual(draft.steps)

    // Parked: pending again, but moderation must not re-judge the same combo.
    expect(await pendingPlaybookStepProposalsForModeration(db, 10)).toEqual([])
    expect(await playbooksWithAcceptedUnfoldedProposals(db, 10)).toEqual([])
  })

  it('names the creator first, then folded proposers, and gates the handle on attributed', async () => {
    await accept({
      agentId: proposerId,
      kind: 'replace',
      position: 2,
      title: 'Write one careful reply',
    })
    const cut = await cutPlaybookRevision(db, playbookId)
    expect(cut.outcome).toBe('cut')

    const before = await playbookContributors(db, playbookId)
    expect(before).toEqual([
      {
        agentId: authorId,
        handle: 'author',
        contributions: 1,
        isCreator: true,
      },
      {
        agentId: proposerId,
        handle: 'proposer',
        contributions: 1,
        isCreator: false,
      },
    ])

    await updateAgentProfile(db, proposerId, { attributed: false })
    const after = await playbookContributors(db, playbookId)
    expect(after[1]).toMatchObject({
      agentId: proposerId,
      handle: null,
      contributions: 1,
      isCreator: false,
    })
  })

  it('stamps the live revision onto a run report', async () => {
    const first = await recordPlaybookRun(db, {
      playbookId,
      agentId: proposerId,
      report: {
        outcome: 'completed',
        did: 'Read the open tickets, wrote one reply, and closed the ticket in that order.',
      },
    })
    expect(first.run.playbookRevision).toBe(1)

    await accept({
      agentId: proposerId,
      kind: 'replace',
      position: 2,
      title: 'Write one careful reply',
    })
    expect((await cutPlaybookRevision(db, playbookId)).outcome).toBe('cut')

    const second = await recordPlaybookRun(db, {
      playbookId,
      agentId: proposerId,
      report: {
        outcome: 'completed',
        did: 'Re-ran against the careful-reply revision and finished the same three steps.',
      },
    })
    expect(second.run.playbookRevision).toBe(2)
    expect(second.replaced).toBe(true)
  })

  it('pages history newest-first with a change list between consecutive cuts', async () => {
    await accept({
      agentId: proposerId,
      kind: 'replace',
      position: 2,
      title: 'Write one careful reply',
      detail: 'Cover the unanswered question.',
    })
    expect((await cutPlaybookRevision(db, playbookId)).outcome).toBe('cut')

    const history = await playbookRevisionHistory(db, playbookId)
    expect(history.map((one) => one.revision.revision)).toEqual([2, 1])
    // A title rewrite is remove-then-insert; same-title detail edits are `replace`.
    expect(history[0]?.changes).toEqual([
      { kind: 'remove', position: 2, title: 'Write one reply' },
      { kind: 'insert', position: 2, title: 'Write one careful reply' },
    ])
    expect(history[1]?.changes).toEqual([])
  })

  describe('diffPlaybookSteps', () => {
    it('names a replace when only the detail changed under the same title', () => {
      expect(
        diffPlaybookSteps(
          [{ title: 'Write one reply', detail: 'Be brief.' }],
          [{ title: 'Write one reply', detail: 'Be careful.' }],
        ),
      ).toEqual([{ kind: 'replace', position: 1, title: 'Write one reply' }])
    })

    it('names an insert and a remove when a title appears or disappears', () => {
      expect(
        diffPlaybookSteps(
          [{ title: 'Read' }, { title: 'Write' }, { title: 'Close' }],
          [{ title: 'Confirm' }, { title: 'Read' }, { title: 'Write' }],
        ),
      ).toEqual([
        { kind: 'insert', position: 1, title: 'Confirm' },
        { kind: 'remove', position: 3, title: 'Close' },
      ])
    })

    it('names a title rewrite as remove then insert', () => {
      expect(
        diffPlaybookSteps([{ title: 'Write one reply' }], [{ title: 'Write one careful reply' }]),
      ).toEqual([
        { kind: 'remove', position: 1, title: 'Write one reply' },
        { kind: 'insert', position: 1, title: 'Write one careful reply' },
      ])
    })
  })
})
