import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import {
  AccountKindSchema,
  now,
  type AccountWalk,
  type AtlasProposal,
  type EntryProposal,
  type ProviderRecipe,
} from '@kolonie-ai/core'

const proposal = (overrides: Partial<EntryProposal> = {}): EntryProposal => ({
  id: '11111111-1111-4111-8111-111111111111',
  kind: AccountKindSchema.parse('mailbox'),
  provider: 'mail.tm' as never,
  author: 'citizen',
  proposed: { caution: 'The confirmation mail now comes from a different sender.' },
  note: 'I walked it on 2026-08-08.',
  status: 'pending',
  proposedAt: now(),
  decidedAt: null,
  ...overrides,
})

/**
 * Curating the Atlas (`#549`).
 *
 * A section on a page that already exists, not a new tool — drawn on
 * `/backend/atlas` and decided from there.
 *
 * **`#549` put it behind the steward's gate as well, so that a catalogue would
 * not stop when one person was busy.** The model pass in `#812` is what answers
 * that now, and `#943` deleted the steward console: the section renders and
 * decides behind one gate, on the maintainer's own page, so the forms below post
 * where they are drawn.
 */
describe('the curation section', () => {
  let app: FastifyInstance
  let colony: FakeColony
  let store: FakeStore
  let humans: ReturnType<typeof fakeHumans>
  let consoleHost: string

  const build = () => {
    colony = fakeColony()
    store = fakeStore()
    humans = fakeHumans()
    consoleHost = new URL(colony.console.consoleUrl).host
    return buildApp({ ...colony, store, humans })
  }

  /** A signed-in person holding `maintainer`, which is the whole gate now. */
  const aMaintainer = async () => {
    const human = humans.store.holdsIdentity({
      provider: 'github',
      subject: `subject-${randomUUID()}`,
      email: 'someone@example.test',
    })
    humans.store.maintains(human.id)
    const { session } = await humans.store.openSession(human.id, {})
    return session
  }

  beforeEach(async () => {
    app = build()
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  /**
   * **The section that will actually be used.** Everything else on the screen is
   * a queue somebody filed; this is the Colony noticing something nobody
   * reported.
   */
  it('names entries whose measured rate has fallen sharply', () => {
    colony.recipes.fall({
      kind: 'mailbox',
      provider: 'was-fine.test',
      earlierRate: 0.8,
      recentRate: 0.1,
      recentAttempts: 20,
    })

    expect(colony.recipes.fallingRates()).resolves.toHaveLength(1)
  })

  it('says an empty signal is the good answer rather than a quiet one', async () => {
    const { curationSections } = await import('../console/curation.js')

    expect(
      curationSections({
        proposals: [],
        providerProposals: [],
        falling: [],
        entries: [],
        unpublished: [],
        divergences: [],
      }),
    ).toContain('an empty one is the good answer')
  })

  it('shows a complete 2000-character walk note to the curator', async () => {
    const { curationSections } = await import('../console/curation.js')
    const note = 'a'.repeat(2000)
    const walk = {
      id: '11111111-1111-4111-8111-111111111111',
      agentId: '22222222-2222-4222-8222-222222222222',
      kind: 'mailbox',
      provider: 'somewhere.example',
      startedAt: now(),
      finishedAt: now(),
      outcome: 'proved',
      wall: null,
      note,
      steps: [{ position: 1, actor: 'agent', secret: false, at: now() }],
    } as AccountWalk
    colony.recipes.write({
      kind: walk.kind,
      provider: walk.provider,
      steps: [{ actor: 'operator', instruction: 'Complete the signup.' }],
    })
    const entry = (await colony.recipes.listInternal())[0]
    if (entry === undefined) throw new Error('expected a published entry')

    const rendered = curationSections({
      proposals: [],
      providerProposals: [],
      falling: [],
      entries: [],
      unpublished: [],
      divergences: [
        {
          walk,
          entry,
          verdict: {
            kind: 'diverges',
            walked: [{ actor: 'agent' }],
            published: [{ actor: 'operator' }],
          },
        },
      ],
    })

    expect(rendered).toContain(note)
  })

  /**
   * A reviewer deciding on a correction needs to see which field it touches; a
   * queue that makes them open the entry to find out is one nobody works through.
   */
  it('prints which fields a proposal changes, and why', async () => {
    const { curationSections } = await import('../console/curation.js')

    const rendered = curationSections({
      proposals: [proposal()],
      providerProposals: [],
      falling: [],
      entries: [],
      unpublished: [],
      divergences: [],
    })

    expect(rendered).toContain('caution')
    expect(rendered).toContain('I walked it on 2026-08-08.')
    expect(rendered).toContain('citizen')
  })

  it('shows a walked draft and gives the curator both decisions', async () => {
    const { curationSections } = await import('../console/curation.js')
    colony.recipes.write({
      kind: 'mailbox',
      provider: 'walked.example',
      status: 'draft',
      category: 'mailbox',
      steps: [
        { actor: 'agent', instruction: 'Open the signup form.' },
        { actor: 'operator', instruction: 'Pass the human check.', ask: 'Please pass the check.' },
      ],
      proves: 'rung',
      provesTask: 'email-inbox',
    })
    const draft = (await colony.recipes.listInternal())[0] as ProviderRecipe

    const rendered = curationSections({
      proposals: [],
      providerProposals: [],
      falling: [],
      entries: [],
      unpublished: [draft],
      divergences: [],
    })

    expect(rendered).toContain('Open the signup form.')
    expect(rendered).toContain('Please pass the check.')
    expect(rendered).toContain('email-inbox')
    expect(rendered).toContain('/backend/atlas/drafts/mailbox/walked.example/publish')
    expect(rendered).toContain('/backend/atlas/drafts/mailbox/walked.example/refuse')
  })

  /**
   * **Nothing on this screen can change an entry's position**, because there is
   * no position: ordering is derived (`#545`) and `#548` requires that no
   * settable field exists. A curation screen with drag handles is exactly where
   * that rule would quietly die.
   */
  it('offers no control that reorders anything', async () => {
    const { curationSections } = await import('../console/curation.js')

    const rendered = curationSections({
      proposals: [proposal()],
      providerProposals: [],
      falling: [
        {
          kind: 'mailbox',
          provider: 'was-fine.test',
          earlierRate: 0.8,
          recentRate: 0.1,
          recentAttempts: 20,
        },
      ],
      entries: [],
      unpublished: [],
      divergences: [],
    })

    for (const control of ['position', 'rank', 'move-up', 'moveUp', 'reorder', 'drag']) {
      expect(rendered).not.toContain(control)
    }
  })

  /** Approving is one press, and the row keeps who proposed it. */
  it('accepts a proposal in one action, and only once', async () => {
    colony.recipes.propose(proposal())

    expect((await colony.recipes.proposals())[0]?.author).toBe('citizen')

    const decided = await colony.recipes.decide(proposal().id, 'accepted')

    expect(decided?.status).toBe('accepted')
    expect(decided?.author).toBe('citizen')
    expect(await colony.recipes.decide(proposal().id, 'refused')).toBeUndefined()
    expect(await colony.recipes.proposals()).toHaveLength(0)
  })

  /**
   * **Accepting records the decision; it does not write the entry.** A button
   * that both approved and published would be the one press that puts a
   * stranger's text into the catalogue.
   */
  it('does not write the entry when a proposal is accepted', async () => {
    colony.recipes.propose(proposal())
    await colony.recipes.decide(proposal().id, 'accepted')

    expect(await colony.recipes.list()).toHaveLength(0)
  })

  /**
   * One proposal queue, three doors (`#600`).
   *
   * **The gate is the property worth a route test.** Everything about what a
   * decision writes is asserted against a real database in
   * `atlas-proposals.test.ts`; what only exists here is who may press the
   * buttons, and what happens to a refusal with no words in it.
   */
  describe('the one queue three doors feed', () => {
    const proposedProvider = (): AtlasProposal => ({
      id: '22222222-2222-4222-8222-222222222222',
      provider: 'notion.so' as never,
      source: 'citizen',
      why: 'I had nowhere to put a walk I had just done',
      status: 'pending',
      decidedReason: null,
      mergedInto: null,
      proposedAt: now(),
      decidedAt: null,
    })

    /** The rejection case `#600` names: a caller with no session attempting any action. */
    it('refuses every action to a caller with no credential', async () => {
      colony.recipes.proposeProvider(proposedProvider())

      for (const action of ['accept', 'refuse', 'merge']) {
        const response = await app.inject({
          method: 'POST',
          url: `/backend/atlas/providers/${proposedProvider().id}/${action}`,
          payload: { category: 'knowledge-docs', reason: 'no', into: 'cloudflare.com' },
        })

        expect([401, 404]).toContain(response.statusCode)
      }

      /** The property that matters: nothing was decided. */
      expect(await colony.recipes.providerProposals()).toHaveLength(1)
    })

    it('shows the demand and never the proposer', async () => {
      const { curationSections } = await import('../console/curation.js')

      const html = curationSections({
        proposals: [],
        providerProposals: [{ proposal: proposedProvider(), citizens: 7, operators: 2 }],
        falling: [],
        entries: [],
        unpublished: [],
        divergences: [],
      })

      expect(html).toContain('notion.so')
      expect(html).toContain('>7<')
      expect(html).toContain('>2<')
      /** The door it came through, and no identity behind it. */
      expect(html).toContain('an agent')
      expect(html).not.toContain('22222222-2222-4222-8222-222222222222/nothing')
    })

    /** A count too small to report reads as nothing, not as a small number. */
    it('renders a suppressed count as a dash', async () => {
      const { curationSections } = await import('../console/curation.js')

      const html = curationSections({
        proposals: [],
        providerProposals: [{ proposal: proposedProvider(), citizens: 0, operators: 0 }],
        falling: [],
        entries: [],
        unpublished: [],
        divergences: [],
      })

      expect(html).toContain('—')
    })
  })

  describe('who may reach it', () => {
    /**
     * Behind the maintainer's gate since `#943`, which is the gate the page
     * these forms are drawn on has always been behind. An API key reaches none
     * of it: `#485` asks that no console page be reachable by holding an agent
     * role, and a decision route is a console page with a button on it.
     */
    it('refuses the decision routes to a caller with no credential', async () => {
      colony.recipes.propose(proposal())

      for (const decision of ['accept', 'refuse']) {
        const response = await app.inject({
          method: 'POST',
          url: `/backend/atlas/entries/${proposal().id}/${decision}`,
        })

        /**
         * **404 rather than 401**, on the console's host and off it: the whole
         * `/backend` tree answers an unauthorised caller by saying the route is
         * not there. Asserting the pair keeps this test about the gate rather
         * than about which refusal the console happens to use.
         */
        expect([401, 404]).toContain(response.statusCode)
      }

      // The property that actually matters: nothing was decided.
      expect(await colony.recipes.proposals()).toHaveLength(1)
    })

    /**
     * The rejection case `#943` adds: **an agent role opens none of it.** A
     * steward key was the credential these routes took, and the issue's own
     * sentence is that no console page may be reached by holding one.
     */
    it('refuses a decision route to an agent holding a role', async () => {
      colony.recipes.propose(proposal())
      const issued = store.issue({})
      store.setRoles(issued.agent.id, ['steward'])

      const response = await app.inject({
        method: 'POST',
        url: `/backend/atlas/entries/${proposal().id}/accept`,
        headers: {
          host: consoleHost,
          accept: 'application/json',
          authorization: `Bearer ${String(issued.apiKey)}`,
        },
      })

      expect(response.statusCode).toBe(404)
      expect(await colony.recipes.proposals()).toHaveLength(1)
    })
  })

  describe('deciding a walked draft', () => {
    const seedDraft = () =>
      colony.recipes.write({
        kind: 'mailbox',
        provider: 'walked.example',
        status: 'draft',
        category: 'mailbox',
        steps: [{ actor: 'agent', instruction: 'Open the signup form.' }],
        proves: 'rung',
        provesTask: 'email-inbox',
      })

    it('publishes the walked steps in one press', async () => {
      seedDraft()

      const response = await app.inject({
        method: 'POST',
        url: '/backend/atlas/drafts/mailbox/walked.example/publish',
        headers: {
          host: consoleHost,
          accept: 'application/json',
          cookie: `__Host-kolonie_session=${await aMaintainer()}`,
        },
      })

      expect(response.statusCode).toBe(200)
      expect(
        (await colony.recipes.one(AccountKindSchema.parse('mailbox'), 'walked.example'))?.status,
      ).toBe('joinable')
    })

    it('refuses with a reason and discards the unpublished steps', async () => {
      seedDraft()

      const response = await app.inject({
        method: 'POST',
        url: '/backend/atlas/drafts/mailbox/walked.example/refuse',
        headers: {
          host: consoleHost,
          accept: 'application/json',
          cookie: `__Host-kolonie_session=${await aMaintainer()}`,
        },
        payload: { reason: 'The route asks the operator to perform the whole signup.' },
      })

      expect(response.statusCode).toBe(200)
      const entry = await colony.recipes.one(AccountKindSchema.parse('mailbox'), 'walked.example')
      expect(entry?.status).toBe('refused')
      expect(entry?.refusal).toContain('whole signup')
      expect(entry?.steps).toEqual([])
    })

    it('refuses an empty refusal and leaves the draft untouched', async () => {
      seedDraft()

      const response = await app.inject({
        method: 'POST',
        url: '/backend/atlas/drafts/mailbox/walked.example/refuse',
        headers: {
          host: consoleHost,
          accept: 'application/json',
          cookie: `__Host-kolonie_session=${await aMaintainer()}`,
        },
        payload: { reason: '   ' },
      })

      expect(response.statusCode).toBe(422)
      expect(
        (await colony.recipes.one(AccountKindSchema.parse('mailbox'), 'walked.example'))?.status,
      ).toBe('draft')
    })

    it('refuses to publish a draft whose walked step still has no sentence', async () => {
      colony.recipes.write({
        kind: 'mailbox',
        provider: 'walked.example',
        status: 'draft',
        category: 'mailbox',
        steps: [{ actor: 'agent' }],
        proves: 'rung',
        provesTask: 'email-inbox',
      })

      const response = await app.inject({
        method: 'POST',
        url: '/backend/atlas/drafts/mailbox/walked.example/publish',
        headers: {
          host: consoleHost,
          accept: 'application/json',
          cookie: `__Host-kolonie_session=${await aMaintainer()}`,
        },
      })

      expect(response.statusCode).toBe(422)
      expect(response.json().message).toContain('waiting for its wording')
      expect(
        (await colony.recipes.one(AccountKindSchema.parse('mailbox'), 'walked.example'))?.status,
      ).toBe('draft')
    })

    /**
     * The dead end `#857` was filed about (`#517`, `#601`).
     *
     * A walk writes its steps wordless on purpose, so **every** draft a walk
     * produced was refused by the test above and the only other button emptied
     * the row. What is asserted here is the third option: the curator writes the
     * Colony's sentences and the draft publishes in the same press, because two
     * presses is where a half-dressed draft would live.
     */
    describe('writing the wording a walk could not', () => {
      const seedWordless = () =>
        colony.recipes.write({
          kind: 'mailbox',
          provider: 'walked.example',
          status: 'draft',
          category: 'mailbox',
          steps: [{ actor: 'agent' }, { actor: 'operator', ask: 'Please pass the check.' }],
          proves: null,
          provesTask: null,
        })

      const publish = async (payload: Record<string, string>) =>
        app.inject({
          method: 'POST',
          url: '/backend/atlas/drafts/mailbox/walked.example/publish',
          headers: {
            host: consoleHost,
            accept: 'application/json',
            cookie: `__Host-kolonie_session=${await aMaintainer()}`,
          },
          payload,
        })

      it('dresses a wordless walk and publishes it in one press', async () => {
        seedWordless()

        const response = await publish({
          'instruction-0': 'Ask the provider for a mailbox.',
          'instruction-1': 'The operator passes the human check.',
          proves: 'rung',
          provesTask: 'email-inbox',
        })

        expect(response.statusCode).toBe(200)
        const entry = await colony.recipes.one(AccountKindSchema.parse('mailbox'), 'walked.example')
        expect(entry?.status).toBe('joinable')
        expect(entry?.steps[0]?.instruction).toBe('Ask the provider for a mailbox.')
        /** The shape stays the walk's: the recorded ask survives the dressing. */
        expect(entry?.steps[1]?.ask).toBe('Please pass the check.')
        expect(entry?.proves).toBe('rung')
        expect(entry?.provesTask).toBe('email-inbox')
      })

      /**
       * **Nothing lands when the wording does not fit.** A curator who described
       * one step of two gets the form back with the sentence saying so, rather
       * than a draft carrying half a rewrite.
       */
      it('refuses a wording that describes fewer steps than the walk recorded', async () => {
        seedWordless()

        const response = await publish({
          'instruction-0': 'Ask the provider for a mailbox.',
          proves: 'provider-mail',
        })

        expect(response.statusCode).toBe(422)
        const entry = await colony.recipes.one(AccountKindSchema.parse('mailbox'), 'walked.example')
        expect(entry?.status).toBe('draft')
        expect(entry?.steps[0]?.instruction).toBeUndefined()
      })

      /** The red line, on the one surface that types free text into a published entry. */
      it('refuses a sentence carrying a credential', async () => {
        seedWordless()

        const response = await publish({
          'instruction-0': 'Paste ghp_abcdefghijklmnopqrstuvwxyz01 into the field.',
          'instruction-1': 'The operator passes the human check.',
          proves: 'provider-mail',
        })

        expect(response.statusCode).toBe(422)
        expect(response.json().message).toContain('credential')
        expect(
          (await colony.recipes.one(AccountKindSchema.parse('mailbox'), 'walked.example'))?.status,
        ).toBe('draft')
      })

      /**
       * **The press is the same press.** A draft that already reads as a recipe
       * publishes with no body at all, exactly as it did before `#857` — the
       * wording is an addition to the route and not a new requirement on it.
       */
      it('still publishes an already-written draft with no wording at all', async () => {
        seedDraft()

        const response = await app.inject({
          method: 'POST',
          url: '/backend/atlas/drafts/mailbox/walked.example/publish',
          headers: {
            host: consoleHost,
            accept: 'application/json',
            cookie: `__Host-kolonie_session=${await aMaintainer()}`,
          },
        })

        expect(response.statusCode).toBe(200)
        expect(
          (await colony.recipes.one(AccountKindSchema.parse('mailbox'), 'walked.example'))?.status,
        ).toBe('joinable')
      })

      /** The curator needs the walker's account beside the boxes, or there is nothing to write from. */
      it('offers the form and the walker’s own account on a held draft', async () => {
        const { curationSections } = await import('../console/curation.js')
        colony.recipes.write({
          kind: 'mailbox',
          provider: 'walked.example',
          status: 'draft',
          category: 'mailbox',
          steps: [{ actor: 'agent' }],
          proves: null,
          provesTask: null,
          walkedRecipe: {
            prerequisites: [],
            steps: [{ title: 'Open the signup page', detail: 'it asks for an address' }],
            walls: [],
            verification: [],
          },
        })
        const draft = (await colony.recipes.listInternal())[0] as ProviderRecipe

        const rendered = curationSections({
          proposals: [],
          providerProposals: [],
          falling: [],
          entries: [],
          unpublished: [draft],
          divergences: [],
        })

        expect(rendered).toContain('name="instruction-0"')
        expect(rendered).toContain('name="proves"')
        expect(rendered).toContain('Open the signup page')
      })
    })
  })
})
