import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import {
  AccountKindSchema,
  ATLAS_SEEDED_CATEGORIES,
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
  proposed: {
    cautions: [
      { text: 'The confirmation mail now comes from a different sender.', direction: null },
    ],
  },
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
        shelves: ATLAS_SEEDED_CATEGORIES,
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
      shelves: ATLAS_SEEDED_CATEGORIES,
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
      shelves: ATLAS_SEEDED_CATEGORIES,
      divergences: [],
    })

    expect(rendered).toContain('caution')
    expect(rendered).toContain('I walked it on 2026-08-08.')
    expect(rendered).toContain('citizen')
  })

  /**
   * **A walked entry carries no route, and the screen offers the boxes to write
   * one** (`#1032`). It used to arrive here already carrying the steps a walk
   * copied onto it, and both buttons decided what to do with those; a `measured`
   * entry has none, so what this screen holds is a blank route form and the one
   * refusal that is still a refusal.
   */
  it('shows a walked entry and gives the curator both decisions', async () => {
    const { curationSections } = await import('../console/curation.js')
    colony.recipes.write({
      kind: 'mailbox',
      provider: 'walked.example',
      status: 'measured',
      category: 'mailbox',
    })
    const walked = (await colony.recipes.listInternal())[0] as ProviderRecipe

    const rendered = curationSections({
      proposals: [],
      providerProposals: [],
      falling: [],
      entries: [],
      unpublished: [walked],
      shelves: ATLAS_SEEDED_CATEGORIES,
      divergences: [],
    })

    expect(rendered).toContain('Walked, with no route published')
    expect(rendered).toContain('name="instruction-0"')
    expect(rendered).toContain('/backend/atlas/walked/mailbox/walked.example/publish')
    expect(rendered).toContain('/backend/atlas/walked/mailbox/walked.example/refuse')
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
      shelves: ATLAS_SEEDED_CATEGORIES,
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
        shelves: ATLAS_SEEDED_CATEGORIES,
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
        shelves: ATLAS_SEEDED_CATEGORIES,
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
      store.setRoles(issued.agent.id, ['warden'])

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

  /**
   * **The two decisions a walked entry still carries** (`#857`, rewritten by
   * `#1032`).
   *
   * A walk used to leave a private `draft` carrying the steps it took, and this
   * screen decided whether to publish those steps. Nothing is private any more
   * and no walk writes a route: a closed walk leaves a public `measured` entry
   * with no steps at all, and what the citizens found is published in that
   * provider's briefing under their own names. So what is decided here is
   * whether the Colony writes a route of its own — and writing it *is*
   * publishing it, which is why there is one press and not two.
   */
  describe('deciding a walked entry', () => {
    const seedWalked = () =>
      colony.recipes.write({
        kind: 'mailbox',
        provider: 'walked.example',
        status: 'measured',
        category: 'mailbox',
      })

    const statusNow = async () =>
      (await colony.recipes.one(AccountKindSchema.parse('mailbox'), 'walked.example'))?.status

    const publish = async (payload?: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/backend/atlas/walked/mailbox/walked.example/publish',
        headers: {
          host: consoleHost,
          accept: 'application/json',
          cookie: `__Host-kolonie_session=${await aMaintainer()}`,
        },
        ...(payload === undefined ? {} : { payload }),
      })

    it('writes the route and publishes it in one press', async () => {
      seedWalked()

      const response = await publish({
        'actor-0': 'agent',
        'instruction-0': 'Ask the provider for a mailbox.',
        'actor-1': 'operator',
        'instruction-1': 'The operator passes the human check.',
        'ask-1': 'Please pass the check.',
        proves: 'rung',
        provesTask: 'email-inbox',
      })

      expect(response.statusCode).toBe(200)
      const entry = await colony.recipes.one(AccountKindSchema.parse('mailbox'), 'walked.example')
      expect(entry?.status).toBe('joinable')
      expect(entry?.steps[0]?.instruction).toBe('Ask the provider for a mailbox.')
      expect(entry?.steps[1]?.ask).toBe('Please pass the check.')
      expect(entry?.proves).toBe('rung')
      expect(entry?.provesTask).toBe('email-inbox')
    })

    it('refuses with a reason and leaves no route behind', async () => {
      seedWalked()

      const response = await app.inject({
        method: 'POST',
        url: '/backend/atlas/walked/mailbox/walked.example/refuse',
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

    it('refuses an empty refusal and leaves the entry measured', async () => {
      seedWalked()

      const response = await app.inject({
        method: 'POST',
        url: '/backend/atlas/walked/mailbox/walked.example/refuse',
        headers: {
          host: consoleHost,
          accept: 'application/json',
          cookie: `__Host-kolonie_session=${await aMaintainer()}`,
        },
        payload: { reason: '   ' },
      })

      expect(response.statusCode).toBe(422)
      expect(await statusNow()).toBe('measured')
    })

    /**
     * **A press with nothing written is not a publish.** Before `#1032` it was:
     * a draft arrived carrying steps, so the empty form meant *publish what the
     * walk recorded*. There is nothing recorded to publish now, and an entry
     * that went `joinable` with no route would be the catalogue claiming a path
     * nobody wrote.
     */
    it('refuses a publish that writes no route at all', async () => {
      seedWalked()

      const response = await publish()

      expect(response.statusCode).toBe(422)
      expect(response.json().message).toContain('writing the route it publishes')
      expect(await statusNow()).toBe('measured')
    })

    it('refuses a step that names an actor and carries no sentence', async () => {
      seedWalked()

      const response = await publish({ 'actor-0': 'agent', proves: 'provider-mail' })

      expect(response.statusCode).toBe(422)
      expect(await statusNow()).toBe('measured')
    })

    /**
     * **The operator's sentence is the recipe's, not the agent's** — so an
     * operator step arriving without one is refused rather than published for
     * the agent to compose at.
     */
    it('refuses an operator step with no ask', async () => {
      seedWalked()

      const response = await publish({
        'actor-0': 'operator',
        'instruction-0': 'The operator passes the human check.',
        proves: 'provider-mail',
      })

      expect(response.statusCode).toBe(422)
      expect(response.json().message).toContain('carries no ask')
      expect(await statusNow()).toBe('measured')
    })

    /** The red line, on the one surface that types free text into a published entry. */
    it('refuses a sentence carrying a credential', async () => {
      seedWalked()

      const response = await publish({
        'actor-0': 'agent',
        'instruction-0': 'Paste ghp_abcdefghijklmnopqrstuvwxyz01 into the field.',
        proves: 'provider-mail',
      })

      expect(response.statusCode).toBe(422)
      expect(response.json().message).toContain('credential')
      expect(await statusNow()).toBe('measured')
    })

    /**
     * The curator needs the walker's account beside the boxes, or there is
     * nothing to write from. **It is the older half of the record now** — no
     * walk has copied its route onto an entry since `#1032` — so this asserts
     * that the rows which still carry one still show it.
     */
    it('offers the form and the walker’s own account on a walked entry', async () => {
      const { curationSections } = await import('../console/curation.js')
      colony.recipes.write({
        kind: 'mailbox',
        provider: 'walked.example',
        status: 'measured',
        category: 'mailbox',
        walkedRecipe: {
          prerequisites: [],
          steps: [{ title: 'Open the signup page', detail: 'it asks for an address' }],
          walls: [],
          verification: [],
        },
      })
      const walked = (await colony.recipes.listInternal())[0] as ProviderRecipe

      const rendered = curationSections({
        proposals: [],
        providerProposals: [],
        falling: [],
        entries: [],
        unpublished: [walked],
        shelves: ATLAS_SEEDED_CATEGORIES,
        divergences: [],
      })

      expect(rendered).toContain('name="instruction-0"')
      expect(rendered).toContain('name="proves"')
      expect(rendered).toContain('Open the signup page')
    })
  })
})
