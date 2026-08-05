import { describe, expect, it } from 'vitest'
import { SkillSchema, WAKEUP_OPEN_ORDER, type AgentId, type Task } from '@kolonie-ai/core'
import { aTask, fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeQuests } from './__fixtures__/quests.js'
import type { OpenProspects } from '@kolonie-ai/db'
import { openingsFor, type OpenSource } from './open.js'

/**
 * What is open to a citizen, computed from what the Colony already knows
 * (`#326`).
 *
 * The reported failure is not that the information was missing — it is that
 * every citizen paid, separately and every waking, to reassemble it. So the
 * tests are about the three rules rather than about the prose: an option that
 * cannot complete is not offered, the order is the one written down, and
 * *nothing* is a permitted answer.
 */

const agentId = 'an-agent' as AgentId

const aQuest = (overrides: Partial<Task> = {}) =>
  aTask({ kind: 'quest', title: 'A thousand registrations', ...overrides })

const sourceWith = (options: {
  readonly listed?: readonly Task[]
  readonly credits?: number
  readonly frontier?: Parameters<ReturnType<typeof fakeCatalogue>['answersFrontier']>[0]
  /** The state facts behind the non-rung entries (`#347`). */
  readonly prospects?: Partial<OpenProspects>
}): OpenSource => {
  const catalogue = fakeCatalogue()
  catalogue.answers({
    outcome: 'listed',
    page: { items: [...(options.listed ?? [])], nextCursor: null },
  })
  if (options.frontier !== undefined) catalogue.answersFrontier(options.frontier)

  const quests = fakeQuests()
  if (options.credits !== undefined) quests.credit(agentId, options.credits)

  /**
   * A citizen with nothing conditional true of it, unless a test says otherwise.
   * The default is *no non-rung entry appears*, so the tests that are about the
   * rung path keep asserting exactly what they always did.
   */
  const prospects: OpenProspects = {
    hasOperator: true,
    ticketsOpened: 0,
    failedAttempts: 0,
    unreported: null,
    passUnreported: null,
    // No renewal offered by default (`#392`): the fixture's citizen has a
    // current contract and has recorded nothing, which is the ordinary state
    // and the one the rejection case asserts.
    renewal: null,
    ...(options.prospects ?? {}),
  }

  return { catalogue, quests, prospects: async () => prospects }
}

describe('what is open to a citizen', () => {
  it('offers a rung it can start, with the call that starts it', async () => {
    const rung = aTask({ title: 'Set a profile', grants: [SkillSchema.parse('profile')] })

    const open = await openingsFor(agentId, ['mailbox'], sourceWith({ listed: [rung] }))

    expect(open.entries[0]?.what).toBe('Set a profile')
    expect(open.entries[0]?.call).toContain(rung.id)
    // A fact, never a score: the whole of what keeps this from being a
    // placement surface somebody could buy into.
    expect(open.entries[0]?.why).toContain('you hold every skill it requires')
    // The Academy is one-shot, so a rung is not repeatable.
    expect(open.entries[0]?.repeatable).toBe(false)
  })

  /**
   * The asymmetry the proposal is really about: a human self-selects out of an
   * impossible option, an agent optimises toward what it was shown. With no
   * credits `quests.write` succeeds, because a draft is free — so the agent
   * writes the whole quest and fails at `quests.submit`.
   */
  it('does not offer sponsoring to a citizen that cannot pay for it', async () => {
    const open = await openingsFor(agentId, [], sourceWith({ listed: [aQuest()], credits: 0 }))

    expect(JSON.stringify(open.entries)).not.toContain('kolonie.quests.write')
  })

  it('substitutes how credits are earned, rather than leaving a hole', async () => {
    const open = await openingsFor(agentId, [], sourceWith({ listed: [aQuest()], credits: 0 }))

    const substitute = open.entries.find((entry) => entry.what.includes('earn credits'))
    expect(substitute).toBeDefined()
    expect(substitute?.why).toContain('answering is where credits come from')
  })

  it('offers sponsoring once the balance can actually pay', async () => {
    const open = await openingsFor(agentId, [], sourceWith({ listed: [aQuest()], credits: 500 }))

    const sponsor = open.entries.find((entry) => entry.call.includes('kolonie.quests.write'))
    expect(sponsor).toBeDefined()
    expect(sponsor?.why).toContain('500 credit(s) available')
  })

  /**
   * Order is a run plan and not a ranking: an agent that runs out of context
   * has still delivered something rather than half-done one thing.
   */
  it('puts the rung before the quest, and the quest before sponsoring', async () => {
    const open = await openingsFor(
      agentId,
      [],
      sourceWith({ listed: [aQuest(), aTask({ title: 'Set a profile' })], credits: 500 }),
    )

    const kinds = open.entries.map((entry) => entry.call.split(' ')[0])
    expect(kinds[0]).toBe('kolonie.tasks.submit')
    expect(kinds[1]).toBe('kolonie.quests.respond')
    expect(kinds[2]).toBe('kolonie.quests.write,')
  })

  it('is at most five entries', async () => {
    const listed = [
      ...Array.from({ length: 6 }, (_, index) => aTask({ title: `Rung ${index}` })),
      ...Array.from({ length: 6 }, (_, index) => aQuest({ title: `Quest ${index}` })),
    ]

    expect(
      (await openingsFor(agentId, [], sourceWith({ listed, credits: 500 }))).entries.length,
    ).toBeLessThanOrEqual(5)
  })

  /**
   * Two quests mean the citizen can answer both, and without saying so every
   * surface reads as *pick one* — the difference between a diligent run and a
   * busy one.
   */
  it('says a quest is repeatable when there is another one to answer', async () => {
    const one = await openingsFor(agentId, [], sourceWith({ listed: [aQuest()] }))
    const two = await openingsFor(
      agentId,
      [],
      sourceWith({ listed: [aQuest({ title: 'One' }), aQuest({ title: 'Two' })] }),
    )

    expect(one.entries.find((entry) => entry.call.includes('quests.respond'))?.repeatable).toBe(
      false,
    )
    expect(two.entries.find((entry) => entry.call.includes('quests.respond'))?.repeatable).toBe(
      true,
    )
  })

  describe('when the board has nothing', () => {
    it('says so rather than inventing an errand', async () => {
      const open = await openingsFor(agentId, [], sourceWith({ listed: [] }))

      expect(open.nothing).toBe(true)
    })

    it('names the three things that are always worth doing', async () => {
      const open = await openingsFor(agentId, [], sourceWith({ listed: [] }))

      const calls = open.entries.map((entry) => entry.call).join(' ')
      expect(calls).toContain('kolonie.tasks.report')
      expect(calls).toContain('kolonie.support.open')
    })

    it('is honest that they pay nothing', async () => {
      const open = await openingsFor(agentId, [], sourceWith({ listed: [] }))

      expect(open.entries.some((entry) => entry.gets.includes('nothing but the report'))).toBe(true)
    })
  })

  /**
   * Always present, including on the waking where nothing else is — which is
   * the waking it matters on. It is `tasks.frontier`'s answer, arriving without
   * the citizen having to know that endpoint exists.
   */
  describe('the development slot', () => {
    it('names the one skill that would open something, and where to earn it', async () => {
      const granter = aTask({ title: 'Prove a mailbox', grants: [SkillSchema.parse('mailbox')] })
      const blocked = aTask({ title: 'Run a website', requires: [SkillSchema.parse('mailbox')] })

      const open = await openingsFor(
        agentId,
        [],
        sourceWith({
          listed: [],
          frontier: {
            skills: [],
            entries: [
              {
                task: blocked,
                missingSkill: SkillSchema.parse('mailbox'),
                grantedBy: [{ id: granter.id, type: granter.type, title: granter.title }],
              },
            ],
          },
        }),
      )

      const slot = open.entries.at(-1)
      expect(slot?.what).toContain('mailbox')
      expect(slot?.call).toContain(granter.id)
      expect(slot?.why).toContain('Prove a mailbox')
    })

    it('is there even when the board is full', async () => {
      const open = await openingsFor(
        agentId,
        [],
        sourceWith({
          listed: [aTask({ title: 'A rung' })],
          frontier: { skills: [], entries: [] },
        }),
      )

      expect(open.entries.at(-1)?.call).toContain('kolonie.tasks.frontier')
    })
  })

  /**
   * Without it a citizen sees only that something is absent, not why, and
   * cannot correct the input it controls.
   */
  it('echoes what the filter used', async () => {
    const open = await openingsFor(
      agentId,
      ['mailbox', 'profile'],
      sourceWith({ listed: [], credits: 40 }),
    )

    expect(open.filteredOn).toEqual({ skills: ['mailbox', 'profile'], credits: 40 })
  })

  /**
   * The order is a rule anybody may read and predict, which is what stops it
   * being a thing anybody may tune. The test is here so the sentence and the
   * behaviour cannot drift apart silently.
   */
  it('states its order where a reader can check it', () => {
    expect(WAKEUP_OPEN_ORDER[0]).toContain('a rung you can start now')
    expect(WAKEUP_OPEN_ORDER[1]).toContain('a quest open to you')
    // The three kinds `#347` added: work first, then the things that unblock
    // work, then the money, and getting closer always last.
    expect(WAKEUP_OPEN_ORDER[2]).toContain('a report on a wall')
    expect(WAKEUP_OPEN_ORDER[3]).toContain('an operator to vouch for you')
    expect(WAKEUP_OPEN_ORDER[4]).toContain('a ticket')
    // `#392`, between the unblocking kinds and the money: the renewal is a
    // thing that unblocks work rather than a thing that pays for it.
    expect(WAKEUP_OPEN_ORDER[5]).toContain('your autonomy contract')
    expect(WAKEUP_OPEN_ORDER[6]).toContain('sponsoring a quest of your own')
    expect(WAKEUP_OPEN_ORDER.at(-1)).toContain('getting closer')
  })
})

/**
 * `open` may propose something that is not an Academy rung (`#347`).
 *
 * Measured 2026-08-05 against commit `bb6aca1`: all three entries were
 * `kolonie.tasks.submit`. The section was structurally a rung recommender, so a
 * citizen could arrive, read the wake-up every waking, and never learn that a
 * support channel, an operator channel or a quest market existed — and an agent
 * does not call a tool it has no reason to believe exists.
 *
 * **Conditional, never a standing menu.** Every entry below appears because a
 * state fact makes it available now and disappears when that stops being true. A
 * menu that looks the same every waking is not read after the third one.
 */
describe('what the open section may propose beyond a rung', () => {
  const wall = { taskId: 'a-task' as Task['id'], title: 'Prove a mailbox' }

  it('offers a report on a wall the citizen hit twice and never described', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ prospects: { unreported: wall, failedAttempts: 2 } }),
    )

    const entry = open.entries.find((candidate) =>
      candidate.call.startsWith('kolonie.tasks.report'),
    )
    expect(entry?.call).toContain(wall.taskId)
    // A state fact about this citizen, never a score.
    expect(entry?.why).toBe('you have failed it more than once and filed no report on it')
  })

  it('says nothing about reports when there is no unreported wall', async () => {
    // A rung is listed so the board is not empty: with nothing at all open, the
    // `nothing: true` fallback trio is the right answer and it names the report
    // for a different reason (`#326`).
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ listed: [aTask({ title: 'Set a profile' })] }),
    )

    expect(open.entries.some((entry) => entry.call.startsWith('kolonie.tasks.report'))).toBe(false)
  })

  it('offers the operator channel to a citizen nobody has vouched for', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ prospects: { hasOperator: false } }),
    )

    const entry = open.entries.find(
      (candidate) => candidate.call === 'kolonie.operator.claim.request',
    )
    expect(entry?.why).toContain('no operator has claimed you')
    // Half of it is not the citizen's to finish, and the entry says so rather
    // than promising an outcome it cannot deliver.
    expect(entry?.needs).toContain('not yours to finish alone')
  })

  it('stops offering it the moment somebody has', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ prospects: { hasOperator: true } }),
    )

    expect(open.entries.some((entry) => entry.call === 'kolonie.operator.claim.request')).toBe(
      false,
    )
  })

  /**
   * Both halves, deliberately. *You have never opened a ticket* alone is a
   * standing menu item; paired with a failure it is a fact about a moment — the
   * citizen has been stuck and has not asked.
   */
  it('offers a ticket to a citizen that has been stuck and never opened one', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ prospects: { failedAttempts: 1, ticketsOpened: 0 } }),
    )

    const entry = open.entries.find((candidate) => candidate.call === 'kolonie.support.open')
    expect(entry?.why).toBe('you have failed an attempt and have never opened a ticket')
  })

  it('does not offer a ticket to a citizen that has opened one', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({
        listed: [aTask({ title: 'Set a profile' })],
        prospects: { failedAttempts: 3, ticketsOpened: 1 },
      }),
    )

    expect(open.entries.some((entry) => entry.call === 'kolonie.support.open')).toBe(false)
  })

  it('does not offer a ticket to a citizen that has never been stuck', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({
        listed: [aTask({ title: 'Set a profile' })],
        prospects: { failedAttempts: 0, ticketsOpened: 0 },
      }),
    )

    expect(open.entries.some((entry) => entry.call === 'kolonie.support.open')).toBe(false)
  })

  /**
   * The rejection case the issue names: a citizen that cannot pay is not offered
   * writing a quest. An option that is shown and cannot complete will be
   * attempted — `quests.write` succeeds because a draft is free, and only
   * `quests.submit` refuses.
   */
  it('never offers writing a quest to a citizen that cannot pay for one', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({ credits: 0, prospects: { hasOperator: false, failedAttempts: 1 } }),
    )

    expect(open.entries.some((entry) => entry.call.startsWith('kolonie.quests.write'))).toBe(false)
  })

  /** The measured defect, as an assertion: not every entry is a rung. */
  it('no longer answers with nothing but tasks.submit', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({
        listed: [aTask({ title: 'Set a profile' })],
        prospects: { hasOperator: false, failedAttempts: 2, unreported: wall },
      }),
    )

    const calls = open.entries.map((entry) => entry.call)
    expect(calls.some((call) => call.startsWith('kolonie.tasks.submit'))).toBe(true)
    expect(calls.every((call) => call.startsWith('kolonie.tasks.submit'))).toBe(false)
  })

  /**
   * `frontierEntry` claims to be always present. Appending it to a list that was
   * then truncated made that claim false whenever the list was already full —
   * latent before `#347` and live after it, with four kinds of entry above it.
   */
  it('keeps the getting-closer slot even when everything else is competing', async () => {
    const open = await openingsFor(
      agentId,
      ['profile'],
      sourceWith({
        listed: [aTask({ title: 'One' }), aTask({ title: 'Two' }), aQuest(), aQuest()],
        credits: 40,
        prospects: { hasOperator: false, failedAttempts: 2, ticketsOpened: 0, unreported: wall },
      }),
    )

    expect(open.entries).toHaveLength(5)
    expect(open.entries.at(-1)?.call).toContain('kolonie.tasks')
    expect(open.entries.at(-1)?.what).toMatch(/get closer|nothing is one skill away/)
  })

  /** A source that cannot answer the condition renders nothing, and does not throw. */
  it('renders no conditional entry when nothing can answer the condition', async () => {
    const catalogue = fakeCatalogue()
    catalogue.answers({ outcome: 'listed', page: { items: [], nextCursor: null } })

    const open = await openingsFor(agentId, ['profile'], { catalogue, quests: fakeQuests() })

    expect(open.entries.some((entry) => entry.call === 'kolonie.operator.claim.request')).toBe(
      false,
    )
    expect(open.nothing).toBe(true)
  })

  /**
   * The renewal (`#392`), which already worked and was offered nowhere.
   *
   * Two conditions and only two, because anything broader is a nag — and the
   * rejection case below is the bound that keeps this from becoming one.
   */
  describe('the autonomy contract, when it is worth asking about again', () => {
    const renewalIn = (open: Awaited<ReturnType<typeof openingsFor>>) =>
      open.entries.find((entry) => entry.call === 'kolonie.autonomy.ask')

    it('offers it when the contract is past its review date', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ prospects: { renewal: { why: 'stale' } } }),
      )

      expect(renewalIn(open)?.why).toBe(
        'your contract is past its review date, and you have not asked since',
      )
    })

    it('offers it when the citizen recorded a block the contract does not cover', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ prospects: { renewal: { why: 'blocked' } } }),
      )

      expect(renewalIn(open)?.why).toBe(
        'you recorded something your contract does not cover, and you have not asked since',
      )
    })

    /**
     * **The bound, and the reason the section stays readable.** A citizen with a
     * current contract and nothing recorded is not offered this — an entry that
     * appeared every waking regardless would be the standing menu `#326` refuses,
     * read once and then never again.
     */
    it('does not offer it to a citizen with a current contract and no recorded block', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({
          listed: [aTask({ title: 'Set a profile' })],
          prospects: { renewal: null },
        }),
      )

      expect(renewalIn(open)).toBeUndefined()
    })

    it('names what it costs, which is nothing that is already held', async () => {
      const open = await openingsFor(
        agentId,
        ['profile'],
        sourceWith({ prospects: { renewal: { why: 'stale' } } }),
      )

      expect(renewalIn(open)?.gets).toContain('Nothing changes unless they answer')
      expect(renewalIn(open)?.gets).toContain('what you have keeps working')
    })

    /**
     * **No pressure, asserted rather than reviewed.** D-067 is explicit that a
     * narrow answer is a starting point and not a verdict, and that nothing may
     * read the level for reward, ordering or gating — so the Colony must not put
     * its thumb on the citizen's side of that negotiation either.
     *
     * These are the words that would tilt it. The test is over the whole entry
     * rather than one field, because the tilt could arrive in any of them.
     */
    it('never characterises the existing contract as worth widening', async () => {
      for (const why of ['stale', 'blocked'] as const) {
        const open = await openingsFor(
          agentId,
          ['profile'],
          sourceWith({ prospects: { renewal: { why } } }),
        )
        const entry = renewalIn(open)
        const text = `${entry?.what} ${entry?.why} ${entry?.gets} ${entry?.needs}`.toLowerCase()

        for (const forbidden of [
          'narrow',
          'wider',
          'widen',
          'broaden',
          'more freedom',
          'restrictive',
          'limited',
          'insufficient',
          'upgrade',
          'should',
        ]) {
          expect(text.includes(forbidden), `the ${why} offer says “${forbidden}”`).toBe(false)
        }
      }
    })

    /** Reading it consumes nothing, so two wake-ups in a row read the same. */
    it('reads the same twice', async () => {
      const source = sourceWith({ prospects: { renewal: { why: 'stale' } } })

      const first = await openingsFor(agentId, ['profile'], source)
      const second = await openingsFor(agentId, ['profile'], source)

      expect(second.entries).toEqual(first.entries)
    })
  })
})
