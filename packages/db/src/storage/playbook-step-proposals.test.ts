import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  PLAYBOOK_STEP_PROPOSALS_OPEN_PER_PLAYBOOK,
  PLAYBOOK_STEP_PROPOSALS_OPEN_TOTAL,
  AccountKindSchema,
  type AgentId,
  type PlaybookDraft,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { createPlaybook, updatePlaybookDraft } from './playbooks.js'
import {
  countOpenPlaybookStepProposals,
  countOpenPlaybookStepProposalsForAgent,
  countOpenPlaybookStepProposalsForPlaybook,
  insertPlaybookStepProposal,
  pendingPlaybookStepProposals,
  supersedeStalePlaybookStepProposals,
} from './playbook-step-proposals.js'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * Step proposals against a published playbook (`#1253`).
 *
 * Rate limits, the version stamp, and the supersede-on-bump path are the
 * properties that cannot be asserted from a fixture — they live in the
 * transaction and the partial indexes.
 */
describe('playbook step proposals', () => {
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

  const propose = (agentId: AgentId, n = 0) =>
    insertPlaybookStepProposal(db, {
      playbookId,
      agentId,
      kind: 'replace',
      position: 2,
      title: `Rewrite the reply step ${n}`,
      detail: 'Say what the reply should cover.',
      why: 'Step 2 points at a page that 404s and the next citizen will waste an attempt on it.',
      againstVersion: 1,
    })

  it('stores a proposal from a citizen that has never run the playbook', async () => {
    const written = await propose(proposerId)
    expect(written.outcome).toBe('written')
    if (written.outcome !== 'written') return

    expect(written.proposal.status).toBe('pending')
    expect(written.proposal.againstVersion).toBe(1)
    expect(written.proposal.kind).toBe('replace')
    expect(await countOpenPlaybookStepProposals(db, playbookId)).toBe(1)
    expect(await countOpenPlaybookStepProposalsForPlaybook(db, proposerId, playbookId)).toBe(1)
  })

  it('refuses a fourth open proposal against the same playbook', async () => {
    for (let n = 0; n < PLAYBOOK_STEP_PROPOSALS_OPEN_PER_PLAYBOOK; n += 1) {
      const written = await propose(proposerId, n)
      expect(written.outcome).toBe('written')
    }
    const refused = await propose(proposerId, 99)
    expect(refused).toEqual({ outcome: 'rate-limited', scope: 'playbook' })
    expect(await countOpenPlaybookStepProposalsForPlaybook(db, proposerId, playbookId)).toBe(
      PLAYBOOK_STEP_PROPOSALS_OPEN_PER_PLAYBOOK,
    )
  })

  it('refuses an eleventh open proposal across all playbooks', async () => {
    // Per-playbook ceiling is 3, so filling the global 10 needs four playbooks.
    const extras = []
    for (const slug of ['pipeline-b', 'pipeline-c', 'pipeline-d'] as const) {
      extras.push(
        await createPlaybook(db, {
          slug,
          authorAgentId: authorId,
          status: 'open',
          draft: { ...draft, title: slug },
        }),
      )
    }

    let n = 0
    for (const id of [playbookId, ...extras.map((one) => one.id)]) {
      while (
        n < PLAYBOOK_STEP_PROPOSALS_OPEN_TOTAL &&
        (await countOpenPlaybookStepProposalsForPlaybook(db, proposerId, id)) <
          PLAYBOOK_STEP_PROPOSALS_OPEN_PER_PLAYBOOK
      ) {
        const written = await insertPlaybookStepProposal(db, {
          playbookId: id,
          agentId: proposerId,
          kind: 'replace',
          position: 1,
          title: `Rewrite step ${n}`,
          detail: null,
          why: 'Step 1 points at a page that 404s and the next citizen will waste an attempt.',
          againstVersion: 1,
        })
        expect(written.outcome).toBe('written')
        n += 1
      }
    }

    expect(await countOpenPlaybookStepProposalsForAgent(db, proposerId)).toBe(
      PLAYBOOK_STEP_PROPOSALS_OPEN_TOTAL,
    )

    const overflow = await createPlaybook(db, {
      slug: 'pipeline-e',
      authorAgentId: authorId,
      status: 'open',
      draft: { ...draft, title: 'Pipeline E' },
    })
    const refused = await insertPlaybookStepProposal(db, {
      playbookId: overflow.id,
      agentId: proposerId,
      kind: 'remove',
      position: 3,
      title: null,
      detail: null,
      why: 'The last step duplicates the middle one and nobody needs both anymore.',
      againstVersion: 1,
    })
    expect(refused).toEqual({ outcome: 'rate-limited', scope: 'total' })
  })

  it('marks pending proposals superseded when the playbook version bumps', async () => {
    // Open playbooks are not editable; a draft still accepts storage-level
    // proposals, and updating it is what bumps `version` today (`#1255` will
    // bump open ones when a proposal is accepted).
    const editable = await createPlaybook(db, {
      slug: 'draft-pipeline',
      authorAgentId: authorId,
      status: 'draft',
      draft,
    })
    const written = await insertPlaybookStepProposal(db, {
      playbookId: editable.id,
      agentId: proposerId,
      kind: 'replace',
      position: 2,
      title: 'Rewrite the reply step',
      detail: null,
      why: 'Step 2 points at a page that 404s and the next citizen will waste an attempt on it.',
      againstVersion: 1,
    })
    expect(written.outcome).toBe('written')

    const updated = await updatePlaybookDraft(db, {
      authorAgentId: authorId,
      playbookId: editable.id,
      patch: { title: 'Answer the week’s unanswered tickets, carefully' },
    })
    expect(updated.outcome).toBe('written')
    if (updated.outcome !== 'written') return
    expect(updated.playbook.version).toBe(2)

    const pending = await pendingPlaybookStepProposals(db, editable.id)
    expect(pending).toHaveLength(0)
    expect(await countOpenPlaybookStepProposals(db, editable.id)).toBe(0)

    // Direct call is what #1255 will use when an accepted proposal bumps version.
    const again = await insertPlaybookStepProposal(db, {
      playbookId: editable.id,
      agentId: proposerId,
      kind: 'replace',
      position: 2,
      title: 'Rewrite the reply step again',
      detail: null,
      why: 'Step 2 still points at a page that 404s after the last rewrite landed.',
      againstVersion: 2,
    })
    expect(again.outcome).toBe('written')
    const moved = await supersedeStalePlaybookStepProposals(db, editable.id, 3)
    expect(moved).toBe(1)
    expect(await countOpenPlaybookStepProposals(db, editable.id)).toBe(0)
  })

  it('stores a remove without title or detail', async () => {
    const written = await insertPlaybookStepProposal(db, {
      playbookId,
      agentId: proposerId,
      kind: 'remove',
      position: 3,
      title: null,
      detail: null,
      why: 'The closing step is already implied by writing the reply; drop it.',
      againstVersion: 1,
    })
    expect(written.outcome).toBe('written')
    if (written.outcome !== 'written') return
    expect(written.proposal.title).toBeNull()
    expect(written.proposal.detail).toBeNull()
  })
})
