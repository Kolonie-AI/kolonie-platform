import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema, type AgentId, type PlaybookDraft } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  createPlaybook,
  draftPlaybook,
  playbookById,
  playbookBySlug,
  playbooksByStatus,
  submitPlaybookForReview,
  updatePlaybookDraft,
} from './playbooks.js'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * A playbook is the account-gated pipeline (`#1173`, `kolonie-docs#430`).
 *
 * **What is asserted here is that the row is the freeze.** The gate is visible
 * rather than enforced, the fork pointer is a pointer and not a copy, the status
 * vocabulary is closed, and nothing that looks like a credential reaches a
 * column — that last one being the property freeze I asks for by name, and the
 * one worth a test that fails loudly if somebody relaxes the schema.
 */
describe('one account-gated pipeline', () => {
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
    requiredAccounts: [
      { slot: 'mailbox', kind: kind('mailbox'), minProved: true },
      { slot: 'notes', kind: kind('website'), minProved: false },
    ],
    steps: [
      { title: 'Read the open tickets', usesSlots: ['mailbox'] },
      {
        title: 'Write one reply',
        detail: 'One ticket, answered properly, beats four acknowledged.',
        usesSlots: ['mailbox'],
        needsOperator: false,
      },
      { title: 'Publish what you could not answer', usesSlots: ['notes'] },
    ],
  }

  it('writes an open playbook with the accounts it needs', async () => {
    const written = await createPlaybook(db, {
      slug: 'answer-the-unanswered',
      authorAgentId: agentId,
      status: 'open',
      draft,
    })

    expect(written.status).toBe('open')
    expect(written.version).toBe(1)
    expect(written.publishedAt).not.toBeNull()
    expect(written.requiredAccounts.map((one) => one.slot)).toEqual(['mailbox', 'notes'])
    expect(written.requiredAccounts[0]?.minProved).toBe(true)
    expect(written.steps).toHaveLength(3)

    const read = await playbookBySlug(db, 'answer-the-unanswered')
    expect(read).toEqual(written)
    expect(await playbookById(db, written.id)).toEqual(written)
  })

  it('starts in draft, unpublished, when nobody says otherwise', async () => {
    const written = await createPlaybook(db, {
      slug: 'a-quiet-draft',
      authorAgentId: agentId,
      draft,
    })

    expect(written.status).toBe('draft')
    expect(written.publishedAt).toBeNull()
  })

  it('remembers which playbook a fork came from', async () => {
    const parent = await createPlaybook(db, {
      slug: 'the-original',
      authorAgentId: agentId,
      status: 'open',
      draft,
    })

    const fork = await createPlaybook(db, {
      slug: 'the-improvement',
      authorAgentId: agentId,
      parentPlaybookId: parent.id,
      draft: { ...draft, title: 'The same, but the reply is written first' },
    })

    expect(fork.parentPlaybookId).toBe(parent.id)
    expect(fork.id).not.toBe(parent.id)
    /** A pointer and not a copy: the parent is untouched by the fork existing. */
    expect((await playbookById(db, parent.id))?.title).toBe(draft.title)
  })

  it('lists by status, and an author’s own shelf separately', async () => {
    await createPlaybook(db, {
      slug: 'published-one',
      authorAgentId: agentId,
      status: 'open',
      draft,
    })
    await createPlaybook(db, { slug: 'unpublished-one', authorAgentId: agentId, draft })

    const open = await playbooksByStatus(db, { statuses: ['open'] })
    expect(open.map((one) => one.slug)).toEqual(['published-one'])

    const mine = await playbooksByStatus(db, {
      statuses: ['draft', 'review', 'open'],
      authorAgentId: agentId,
    })
    expect(mine).toHaveLength(2)

    expect(await playbooksByStatus(db, { statuses: [] })).toEqual([])
  })

  it('refuses a status that is not in the vocabulary', async () => {
    await expect(
      createPlaybook(db, {
        slug: 'invented-status',
        authorAgentId: agentId,
        status: 'published' as never,
        draft,
      }),
    ).rejects.toThrow()
  })

  /**
   * **The property freeze I asks for by name.**
   *
   * A playbook is a route and never a set of keys. The scrub is the walks'
   * scrub, so what is asserted here is not the detector — that is tested where it
   * lives — but that this write boundary is behind it, on every surface an author
   * writes prose to.
   *
   * The fixtures are the `ghp_` shape every other test in this repo uses, and
   * deliberately not a plausible key of some other vendor's: GitHub's own push
   * protection reads the diff, and a fabricated Stripe key in a test refuses the
   * push exactly as a real one would.
   */
  it('refuses a credential in the title, the summary or a step', async () => {
    const attempts: readonly PlaybookDraft[] = [
      { ...draft, title: 'Use ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' },
      { ...draft, summary: 'The password is hunter2-correct-horse-battery-staple-9931' },
      {
        ...draft,
        steps: [
          {
            title: 'Sign in',
            detail: 'export GITHUB_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
          },
        ],
      },
    ]

    for (const attempt of attempts) {
      await expect(
        createPlaybook(db, { slug: 'never-written', authorAgentId: agentId, draft: attempt }),
      ).rejects.toThrow()
    }

    expect(await playbookBySlug(db, 'never-written')).toBeNull()
  })

  it('refuses a step that uses an account slot nobody declared', async () => {
    await expect(
      createPlaybook(db, {
        slug: 'a-gate-nobody-declared',
        authorAgentId: agentId,
        draft: {
          ...draft,
          steps: [{ title: 'Post it somewhere', usesSlots: ['social'] }],
        },
      }),
    ).rejects.toThrow(/no account slot is called/)
  })

  it('refuses the same slug twice, whatever status the first one is in', async () => {
    await createPlaybook(db, { slug: 'taken', authorAgentId: agentId, draft })
    await expect(
      createPlaybook(db, { slug: 'taken', authorAgentId: agentId, status: 'open', draft }),
    ).rejects.toThrow()
  })
})

/**
 * Writing one, rewriting one, offering one (`#1179`).
 *
 * **The property worth a real database here is the re-parse.** A patch is merged
 * onto the row and the whole playbook goes back through `PlaybookDraftSchema`, so
 * a pair of updates cannot reach a playbook neither of them could have written on
 * its own — steps that name a slot a later `requiredAccounts` removed are refused
 * on the call that removes it. The fixture in `apps/api` cannot assert that, and
 * this is where the two-call route would otherwise be a hole.
 */
describe('a citizen writing a pipeline of its own', () => {
  let db: Database
  let agentId: AgentId
  let strangerId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    for (const name of ['author', 'stranger']) {
      const agent = await registerAgent(db, { name, platform: 'openclaw', operator: null })
      if (agent.outcome !== 'registered') throw new Error(`could not register ${name}`)
      if (name === 'author') agentId = agent.agent.id
      else strangerId = agent.agent.id
    }
  })

  const draft: PlaybookDraft = {
    title: 'Triage the inbox once a week',
    summary: 'Read what arrived, answer what needs answering, and file the rest.',
    requiredAccounts: [{ slot: 'mailbox', kind: kind('mailbox'), minProved: false }],
    steps: [{ title: 'Read what arrived', usesSlots: ['mailbox'] }],
  }

  const written = async (slug = 'weekly-inbox-triage') => {
    const result = await draftPlaybook(db, { authorAgentId: agentId, slug, draft })
    if (result.outcome !== 'written') throw new Error(`could not draft: ${result.outcome}`)
    return result.playbook
  }

  it('drafts one that is nobody else’s to read and nobody’s to run yet', async () => {
    const playbook = await written()

    expect(playbook.status).toBe('draft')
    expect(playbook.publishedAt).toBeNull()
    expect(playbook.version).toBe(1)
    expect(await playbooksByStatus(db, { statuses: ['open', 'blocked'] })).toHaveLength(0)
  })

  it('refuses a slug another playbook already answers to', async () => {
    await written('taken-already')

    expect(
      await draftPlaybook(db, { authorAgentId: strangerId, slug: 'taken-already', draft }),
    ).toEqual({ outcome: 'slug-taken' })
  })

  it('changes what a patch names and leaves the rest as it was', async () => {
    const before = await written()
    const changed = await updatePlaybookDraft(db, {
      authorAgentId: agentId,
      playbookId: before.id,
      patch: { summary: 'Rewritten, and shorter.' },
    })

    expect(changed.outcome).toBe('written')
    if (changed.outcome !== 'written') return
    expect(changed.playbook.summary).toBe('Rewritten, and shorter.')
    expect(changed.playbook.title).toBe(before.title)
    expect(changed.playbook.steps).toEqual(before.steps)
    expect(changed.playbook.version).toBe(before.version + 1)
  })

  /** The whole point of re-parsing the merge rather than the patch. */
  it('refuses a patch that takes away a slot the steps still name', async () => {
    const playbook = await written()

    await expect(
      updatePlaybookDraft(db, {
        authorAgentId: agentId,
        playbookId: playbook.id,
        patch: { requiredAccounts: [] },
      }),
    ).rejects.toThrow(/no account slot is called/)

    const unchanged = await playbookById(db, playbook.id)
    expect(unchanged?.requiredAccounts).toHaveLength(1)
  })

  it('refuses a credential arriving in a patch, exactly as it refuses one in a draft', async () => {
    const playbook = await written()

    await expect(
      updatePlaybookDraft(db, {
        authorAgentId: agentId,
        playbookId: playbook.id,
        patch: {
          steps: [
            {
              title: 'Sign in',
              detail: 'export GITHUB_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
              usesSlots: ['mailbox'],
            },
          ],
        },
      }),
    ).rejects.toThrow()
  })

  it('is nobody’s to rewrite but its author’s, and says so without saying it exists', async () => {
    const playbook = await written()

    expect(
      await updatePlaybookDraft(db, {
        authorAgentId: strangerId,
        playbookId: playbook.id,
        patch: { summary: 'Mine now.' },
      }),
    ).toEqual({ outcome: 'not-yours' })
    expect(
      await submitPlaybookForReview(db, { authorAgentId: strangerId, playbookId: playbook.id }),
    ).toEqual({ outcome: 'not-yours' })
  })

  it('publishes on submission, because the review is a stub', async () => {
    const playbook = await written()
    const offered = await submitPlaybookForReview(db, {
      authorAgentId: agentId,
      playbookId: playbook.id,
    })

    expect(offered.outcome).toBe('written')
    if (offered.outcome !== 'written') return
    expect(offered.playbook.status).toBe('open')
    expect(offered.playbook.publishedAt).not.toBeNull()
    expect(await playbooksByStatus(db, { statuses: ['open'] })).toHaveLength(1)
  })

  it('will not rewrite or republish a playbook that is already open', async () => {
    const playbook = await written()
    await submitPlaybookForReview(db, { authorAgentId: agentId, playbookId: playbook.id })

    expect(
      await updatePlaybookDraft(db, {
        authorAgentId: agentId,
        playbookId: playbook.id,
        patch: { summary: 'Quietly different.' },
      }),
    ).toEqual({ outcome: 'not-editable', status: 'open' })
  })

  /** Blocked is editable on purpose: it says the world broke the pipeline. */
  it('lets its author fix a blocked playbook and offer it back', async () => {
    const playbook = await createPlaybook(db, {
      slug: 'broke-out-there',
      authorAgentId: agentId,
      status: 'blocked',
      draft,
    })

    const fixed = await updatePlaybookDraft(db, {
      authorAgentId: agentId,
      playbookId: playbook.id,
      patch: { steps: [{ title: 'The provider moved this', usesSlots: ['mailbox'] }] },
    })
    expect(fixed.outcome).toBe('written')

    const offered = await submitPlaybookForReview(db, {
      authorAgentId: agentId,
      playbookId: playbook.id,
    })
    expect(offered.outcome).toBe('written')
    if (offered.outcome !== 'written') return
    expect(offered.playbook.status).toBe('open')
  })

  it('answers about a playbook nobody wrote without pretending it might be yours', async () => {
    expect(
      await submitPlaybookForReview(db, {
        authorAgentId: agentId,
        playbookId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toEqual({ outcome: 'unknown-playbook' })
  })
})
