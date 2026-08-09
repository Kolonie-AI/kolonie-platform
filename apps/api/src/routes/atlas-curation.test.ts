import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import { AccountKindSchema, now, type AccountWalk, type EntryProposal } from '@kolonie-ai/core'

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
 * A section on pages that already exist, not a new tool — and reachable by a
 * steward as well as by the maintainer, because a catalogue only one person can
 * maintain is a catalogue that stops when that person is busy.
 */
describe('the curation section', () => {
  let app: FastifyInstance
  let colony: FakeColony

  const build = () => {
    colony = fakeColony()
    return buildApp({ ...colony })
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
        falling: [],
        entries: [],
        unpublished: [],
        divergences: [],
      }),
    ).toContain('an empty one is the good answer')
  })

  it('shows a complete 2000-character walk note to the steward', async () => {
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
      falling: [],
      entries: [],
      unpublished: [],
      divergences: [],
    })

    expect(rendered).toContain('caution')
    expect(rendered).toContain('I walked it on 2026-08-08.')
    expect(rendered).toContain('citizen')
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

  describe('who may reach it', () => {
    /**
     * Behind the **steward** gate rather than the maintainer's, because `#549`
     * requires that stewards curate. A caller with no credential gets the same
     * 401 every other privileged route answers with — `stewardFor`'s convention,
     * not a new one.
     */
    it('refuses the decision routes to a caller with no credential', async () => {
      colony.recipes.propose(proposal())

      for (const decision of ['accept', 'refuse']) {
        const response = await app.inject({
          method: 'POST',
          url: `/curation/${proposal().id}/${decision}`,
        })

        /**
         * **401 or 404 depending on the host**, which is the console's existing
         * shape rather than something this issue introduced: on the console's
         * own host an unauthorised caller is told the route is not there, and
         * elsewhere `stewardFor` answers 401. Both are refusals and neither is
         * a success — asserting the pair rather than one of them is what keeps
         * this test about the gate instead of about the hostname.
         */
        expect([401, 404]).toContain(response.statusCode)
      }

      // The property that actually matters: nothing was decided.
      expect(await colony.recipes.proposals()).toHaveLength(1)
    })
  })
})
