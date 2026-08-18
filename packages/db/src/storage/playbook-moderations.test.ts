import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  noStagesRun,
  type AgentId,
  type ModerationStages,
  type PlaybookDraft,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  pendingPlaybookModerations,
  playbookTextDigest,
  playbooksClearedForPublication,
  publishPlaybookAfterReview,
  recordPlaybookModeration,
} from './playbook-moderations.js'
import {
  createPlaybook,
  playbookById,
  submitPlaybookForReview,
  updatePlaybookDraft,
} from './playbooks.js'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * The judged review pass, from the database's side (`#1219`).
 *
 * **What is asserted here is that a verdict cannot land on text nobody offered.**
 * Every other property in this file follows from that one: the queue skips what
 * has been judged, the record refuses a verdict whose digest has moved, and the
 * publish is a second transaction with its own retry queue so that a crash
 * between the two costs a poll rather than a playbook.
 */
describe('judging a playbook before it is published', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    const agent = await registerAgent(db, { name: 'author', platform: 'openclaw', operator: null })
    if (agent.outcome !== 'registered') throw new Error('could not register the authoring agent')
    agentId = agent.agent.id
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

  /** A playbook sitting in `review`, which is where every test here starts. */
  const offered = async (slug = 'weekly-ticket-sweep') => {
    const playbook = await createPlaybook(db, { slug, authorAgentId: agentId, draft })
    const submitted = await submitPlaybookForReview(db, {
      authorAgentId: agentId,
      playbookId: playbook.id,
    })
    if (submitted.outcome !== 'written') throw new Error('could not offer the playbook')
    return submitted.playbook
  }

  const stages = (): ModerationStages => ({
    ...noStagesRun(),
    redLine: { outcome: 'clear' },
    quality: { outcome: 'followable' },
    confidentiality: { outcome: 'clean' },
  })

  it('queues what is waiting and nothing else', async () => {
    const waiting = await offered()
    await createPlaybook(db, { slug: 'still-a-draft', authorAgentId: agentId, draft })

    const pending = await pendingPlaybookModerations(db, 10)
    expect(pending.map((row) => row.id)).toEqual([waiting.id])
    expect(pending[0]?.steps).toHaveLength(2)
  })

  /**
   * The queue is *unjudged*, not *unpublished*. A playbook whose verdict was
   * recorded and whose publish did not happen belongs to
   * {@link playbooksClearedForPublication}, and re-judging it would buy a second
   * model call and a second chance to answer differently.
   */
  it('drops a judged playbook out of the queue and into the retry', async () => {
    const playbook = await offered()
    const judged = { title: playbook.title, summary: playbook.summary, steps: playbook.steps }

    expect(
      await recordPlaybookModeration(db, {
        playbookId: playbook.id,
        decision: 'approved',
        model: 'a-model',
        stages: stages(),
        judged,
      }),
    ).toEqual({ outcome: 'written' })

    expect(await pendingPlaybookModerations(db, 10)).toHaveLength(0)
    expect(await playbooksClearedForPublication(db, 10)).toEqual([playbook.id])

    expect(await publishPlaybookAfterReview(db, playbook.id)).toEqual({
      outcome: 'published',
      slug: playbook.slug,
    })
    expect(await playbooksClearedForPublication(db, 10)).toHaveLength(0)

    const published = await playbookById(db, playbook.id)
    expect(published?.status).toBe('open')
    expect(published?.publishedAt).not.toBeNull()
  })

  it('returns a refused playbook to its author with something to act on', async () => {
    const playbook = await offered()

    expect(
      await recordPlaybookModeration(db, {
        playbookId: playbook.id,
        decision: 'rejected',
        reason: 'Step two never says how the follower would know the reply was sent.',
        model: 'a-model',
        stages: { ...stages(), quality: { outcome: 'unfollowable', reason: 'no outcome' } },
        judged: { title: playbook.title, summary: playbook.summary, steps: playbook.steps },
      }),
    ).toEqual({ outcome: 'written' })

    const refused = await playbookById(db, playbook.id)
    expect(refused?.status).toBe('draft')
    expect(refused?.refusalReason).toContain('know the reply was sent')
    expect(refused?.publishedAt).toBeNull()
  })

  /** The reason is about text the author has since rewritten, so it goes. */
  it('clears the refusal reason when the fixed playbook is offered again', async () => {
    const playbook = await offered()
    await recordPlaybookModeration(db, {
      playbookId: playbook.id,
      decision: 'rejected',
      reason: 'Step two has no observable outcome.',
      model: 'a-model',
      stages: stages(),
      judged: { title: playbook.title, summary: playbook.summary, steps: playbook.steps },
    })

    await updatePlaybookDraft(db, {
      authorAgentId: agentId,
      playbookId: playbook.id,
      patch: { steps: [{ title: 'Read the open tickets', usesSlots: ['mailbox'] }] },
    })
    await submitPlaybookForReview(db, { authorAgentId: agentId, playbookId: playbook.id })

    const again = await playbookById(db, playbook.id)
    expect(again?.status).toBe('review')
    expect(again?.refusalReason).toBeNull()
  })

  /**
   * The property the digest exists for. An author may rewrite while a judge is
   * thinking, and applying the old verdict would refuse a playbook for words it
   * no longer contains — or publish one nobody read.
   */
  it('drops a verdict about text that has moved', async () => {
    const playbook = await offered()
    const judged = { title: playbook.title, summary: playbook.summary, steps: playbook.steps }

    await recordPlaybookModeration(db, {
      playbookId: playbook.id,
      decision: 'rejected',
      reason: 'It says too much.',
      model: 'a-model',
      stages: stages(),
      judged,
    })
    await updatePlaybookDraft(db, {
      authorAgentId: agentId,
      playbookId: playbook.id,
      patch: { summary: 'Something else entirely, written while the judge was reading.' },
    })
    await submitPlaybookForReview(db, { authorAgentId: agentId, playbookId: playbook.id })

    expect(
      await recordPlaybookModeration(db, {
        playbookId: playbook.id,
        decision: 'approved',
        model: 'a-model',
        stages: stages(),
        judged,
      }),
    ).toEqual({ outcome: 'stale' })
    expect((await playbookById(db, playbook.id))?.status).toBe('review')
  })

  it('drops a verdict about a playbook that has left review', async () => {
    const playbook = await offered()
    const judged = { title: playbook.title, summary: playbook.summary, steps: playbook.steps }
    await publishPlaybookAfterReview(db, playbook.id)

    expect(
      await recordPlaybookModeration(db, {
        playbookId: playbook.id,
        decision: 'rejected',
        reason: 'Too late.',
        model: 'a-model',
        stages: stages(),
        judged,
      }),
    ).toEqual({ outcome: 'stale' })
    expect((await playbookById(db, playbook.id))?.status).toBe('open')
  })

  it('says what it did rather than throwing when there is nothing to publish', async () => {
    const playbook = await createPlaybook(db, {
      slug: 'never-offered',
      authorAgentId: agentId,
      draft,
    })

    expect(await publishPlaybookAfterReview(db, playbook.id)).toEqual({
      outcome: 'not-in-review',
      status: 'draft',
    })
    expect(await publishPlaybookAfterReview(db, '00000000-0000-4000-8000-000000000000')).toEqual({
      outcome: 'unknown-playbook',
    })
  })

  /** The digest covers the prose a judge read, and not the row around it. */
  it('digests the text and not the record', () => {
    const text = { title: 'A', summary: 'B', steps: [{ title: 'C', detail: 'D' }] }
    expect(playbookTextDigest(text)).toBe(playbookTextDigest({ ...text }))
    expect(playbookTextDigest(text)).not.toBe(
      playbookTextDigest({ ...text, steps: [{ title: 'C', detail: 'E' }] }),
    )
  })
})
