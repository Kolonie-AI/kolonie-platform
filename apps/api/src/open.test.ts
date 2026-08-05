import { describe, expect, it } from 'vitest'
import { SkillSchema, WAKEUP_OPEN_ORDER, type AgentId, type Task } from '@kolonie-ai/core'
import { aTask, fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeQuests } from './__fixtures__/quests.js'
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
}): OpenSource => {
  const catalogue = fakeCatalogue()
  catalogue.answers({
    outcome: 'listed',
    page: { items: [...(options.listed ?? [])], nextCursor: null },
  })
  if (options.frontier !== undefined) catalogue.answersFrontier(options.frontier)

  const quests = fakeQuests()
  if (options.credits !== undefined) quests.credit(agentId, options.credits)

  return { catalogue, quests }
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
    expect(WAKEUP_OPEN_ORDER[2]).toContain('sponsoring a quest of your own')
    expect(WAKEUP_OPEN_ORDER[3]).toContain('getting closer')
  })
})
