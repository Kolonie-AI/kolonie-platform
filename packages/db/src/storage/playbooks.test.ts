import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema, type AgentId, type PlaybookDraft } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { publishPlaybookAfterReview } from './playbook-moderations.js'
import {
  createPlaybook,
  draftPlaybook,
  forkPlaybook,
  playbookById,
  playbookBySlug,
  playbooksByStatus,
  playbooksNamingProvider,
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

  /**
   * The property `#1219` bought, and the one a later change is most likely to
   * take back: **a submit is not a publish.** Until that issue this function set
   * `open` in the same transaction, so the assertion that matters here is the
   * negative one — nothing is in the catalogue yet.
   */
  it('stops at review on submission, publishing nothing', async () => {
    const playbook = await written()
    const offered = await submitPlaybookForReview(db, {
      authorAgentId: agentId,
      playbookId: playbook.id,
    })

    expect(offered.outcome).toBe('written')
    if (offered.outcome !== 'written') return
    expect(offered.playbook.status).toBe('review')
    expect(offered.playbook.publishedAt).toBeNull()
    expect(await playbooksByStatus(db, { statuses: ['open'] })).toHaveLength(0)
  })

  it('will not rewrite or republish a playbook that is already open', async () => {
    const playbook = await written()
    await submitPlaybookForReview(db, { authorAgentId: agentId, playbookId: playbook.id })
    await publishPlaybookAfterReview(db, playbook.id)

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
    expect(offered.playbook.status).toBe('review')
  })

  it('answers about a playbook nobody wrote without pretending it might be yours', async () => {
    expect(
      await submitPlaybookForReview(db, {
        authorAgentId: agentId,
        playbookId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toEqual({ outcome: 'unknown-playbook' })
  })

  /**
   * Forking (`#1180`).
   *
   * **The copy and the pointer are the whole of it.** A fork is a draft owned by
   * whoever asked for it, carrying the steps and the slots of the playbook it
   * came from and a `parentPlaybookId` at the source — and the source is not
   * touched, which is the property a test has to hold on to, because *copy* is
   * exactly the operation somebody implements one day as a move.
   */
  describe('forking a published one', () => {
    const published = async (slug = 'weekly-inbox-triage') => {
      const playbook = await written(slug)
      const offered = await submitPlaybookForReview(db, {
        authorAgentId: agentId,
        playbookId: playbook.id,
      })
      if (offered.outcome !== 'written') throw new Error('could not offer the source')
      const published = await publishPlaybookAfterReview(db, playbook.id)
      if (published.outcome !== 'published') throw new Error('could not publish the source')
      const row = await playbookById(db, playbook.id)
      if (row === null) throw new Error('the published source went missing')
      return row
    }

    it('copies the pipeline into a draft of the forker’s own, pointing at where it came from', async () => {
      const source = await published()

      const forked = await forkPlaybook(db, {
        authorAgentId: strangerId,
        sourcePlaybookId: source.id,
        slug: 'inbox-triage-my-way',
      })

      expect(forked.outcome).toBe('written')
      if (forked.outcome !== 'written') return
      expect(forked.playbook.authorAgentId).toBe(strangerId)
      expect(forked.playbook.status).toBe('draft')
      expect(forked.playbook.publishedAt).toBeNull()
      expect(forked.playbook.version).toBe(1)
      expect(forked.playbook.parentPlaybookId).toBe(source.id)
      expect(forked.playbook.title).toBe(source.title)
      expect(forked.playbook.summary).toBe(source.summary)
      expect(forked.playbook.steps).toEqual(source.steps)
      expect(forked.playbook.requiredAccounts).toEqual(source.requiredAccounts)
    })

    /** The one a copy quietly becomes a move on: the source has to survive it unchanged. */
    it('leaves the playbook it copied exactly as it was', async () => {
      const source = await published()
      await forkPlaybook(db, {
        authorAgentId: strangerId,
        sourcePlaybookId: source.id,
        slug: 'inbox-triage-my-way',
      })

      expect(await playbookById(db, source.id)).toEqual(source)
      expect(await playbooksByStatus(db, { statuses: ['open'] })).toHaveLength(1)
    })

    /** And the copy has to be a copy: rewriting the fork must not reach the original. */
    it('hands the forker steps that are its own to rewrite', async () => {
      const source = await published()
      const forked = await forkPlaybook(db, {
        authorAgentId: strangerId,
        sourcePlaybookId: source.id,
        slug: 'inbox-triage-my-way',
      })
      if (forked.outcome !== 'written') throw new Error('could not fork')

      await updatePlaybookDraft(db, {
        authorAgentId: strangerId,
        playbookId: forked.playbook.id,
        patch: { steps: [{ title: 'I do this differently', usesSlots: ['mailbox'] }] },
      })

      expect((await playbookById(db, source.id))?.steps).toEqual(source.steps)
    })

    it('refuses a slug another playbook already answers to', async () => {
      const source = await published()
      await draftPlaybook(db, { authorAgentId: strangerId, slug: 'taken-already', draft })

      expect(
        await forkPlaybook(db, {
          authorAgentId: strangerId,
          sourcePlaybookId: source.id,
          slug: 'taken-already',
        }),
      ).toEqual({ outcome: 'slug-taken' })
    })

    /** Freeze B: blocked is published and readable, and forking it is still refused. */
    it('will not fork a blocked playbook, whose author is the one who fixes it', async () => {
      const blocked = await createPlaybook(db, {
        slug: 'broke-out-there',
        authorAgentId: agentId,
        status: 'blocked',
        draft,
      })

      expect(
        await forkPlaybook(db, {
          authorAgentId: strangerId,
          sourcePlaybookId: blocked.id,
          slug: 'my-fix',
        }),
      ).toEqual({ outcome: 'not-forkable', status: 'blocked' })
    })

    /** A draft is not readable, so forking one must not be the way to read it. */
    it('will not fork a draft, whoever wrote it', async () => {
      const mine = await written('still-writing-this')

      expect(
        await forkPlaybook(db, {
          authorAgentId: strangerId,
          sourcePlaybookId: mine.id,
          slug: 'copied-from-a-draft',
        }),
      ).toEqual({ outcome: 'not-forkable', status: 'draft' })
    })

    it('answers about a playbook nobody wrote', async () => {
      expect(
        await forkPlaybook(db, {
          authorAgentId: strangerId,
          sourcePlaybookId: '00000000-0000-4000-8000-000000000000',
          slug: 'from-nowhere',
        }),
      ).toEqual({ outcome: 'unknown-playbook' })
    })
  })
})

/**
 * What an Atlas entry asks: *what is an account at this provider used for*
 * (`kolonie-website#116`).
 *
 * The rule under test is the one the issue's acceptance criteria turn on —
 * provider-exact, open only — and it is asserted here rather than at the page,
 * because the page can only render what this returns.
 */
describe('the playbooks that name one provider', () => {
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
    const agent = await registerAgent(db, { name: 'walker', platform: 'openclaw', operator: null })
    if (agent.outcome !== 'registered') throw new Error('could not register the authoring agent')
    agentId = agent.agent.id
  })

  const needing = async (
    slug: string,
    account: { readonly kind: string; readonly provider?: string },
    status: 'open' | 'blocked' | 'draft' = 'open',
  ) =>
    await createPlaybook(db, {
      slug,
      authorAgentId: agentId,
      status,
      draft: {
        title: `The ${slug} pipeline`,
        summary: 'What it does, in the one line a catalogue entry gets.',
        requiredAccounts: [
          {
            slot: 'account',
            kind: kind(account.kind),
            ...(account.provider === undefined ? {} : { provider: account.provider }),
            minProved: false,
          },
        ],
        steps: [{ title: 'Do the thing', usesSlots: ['account'] }],
      },
    })

  it('finds an open playbook that names the provider', async () => {
    await needing('forge-loop', { kind: 'github', provider: 'github.com' })

    expect(await playbooksNamingProvider(db, 'github.com')).toEqual([
      {
        slug: 'forge-loop',
        title: 'The forge-loop pipeline',
        summary: 'What it does, in the one line a catalogue entry gets.',
      },
    ])
  })

  /**
   * **The acceptance criterion the whole rule exists for**: no module spam on
   * unrelated providers. A playbook asking for *a mailbox* is asking for any of
   * them, and answering *what is an account at mail.tm for* with it would put
   * the same paragraph on every mailbox entry in the Atlas.
   */
  it('does not match a slot that names only a kind', async () => {
    await needing('correspondence-loop', { kind: 'mailbox' })

    expect(await playbooksNamingProvider(db, 'mail.tm')).toEqual([])
  })

  it('does not match a different provider of the same kind', async () => {
    await needing('forge-loop', { kind: 'github', provider: 'github.com' })

    expect(await playbooksNamingProvider(db, 'codeberg.org')).toEqual([])
  })

  /** Only the catalogue. A draft is not readable and a blocked one is not a use. */
  it('leaves out a draft and a blocked playbook that name it', async () => {
    await needing('not-published-yet', { kind: 'github', provider: 'github.com' }, 'draft')
    await needing('broke-out-there', { kind: 'github', provider: 'github.com' }, 'blocked')

    expect(await playbooksNamingProvider(db, 'github.com')).toEqual([])
  })

  /**
   * **The empty answer is an empty list and never a zero.** The page renders
   * nothing at all for it, which is not the same page as one saying no playbook
   * needs an account here.
   */
  it('answers about a provider nothing names', async () => {
    expect(await playbooksNamingProvider(db, 'nobody-uses-this.test')).toEqual([])
  })

  it('caps what it hands a page', async () => {
    for (let n = 0; n < 12; n += 1) {
      await needing(`loop-${String(n)}`, { kind: 'github', provider: 'github.com' })
    }

    expect(await playbooksNamingProvider(db, 'github.com')).toHaveLength(10)
    expect(await playbooksNamingProvider(db, 'github.com', 3)).toHaveLength(3)
  })
})
