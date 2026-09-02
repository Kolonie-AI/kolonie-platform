import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  AgentIdSchema,
  SKILL_NOTE_PREVIEW_MAX_LENGTH,
  SKILL_NOTES_PREVIEW_TOTAL_MAX_LENGTH,
  wakeupIsQuiet,
} from '@kolonie-ai/core'
import { fakeWakeup, type FakeWakeup } from './__fixtures__/wakeup.js'
import { fakeSkillNotes, type FakeSkillNotes } from './__fixtures__/skill-notes.js'
import { aTask, fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeQuests } from './__fixtures__/quests.js'
import { wakeupAsText } from './mcp/text/wakeup.js'
import { wakeup } from './wakeup.js'
import type { ContributionDependencies } from './contributions.js'

const agentId = AgentIdSchema.parse(randomUUID())

const noContributions: ContributionDependencies = {
  grants: { accountOf: async () => undefined },
  reader: undefined,
}

let source: FakeWakeup
let notes: FakeSkillNotes

beforeEach(() => {
  source = fakeWakeup()
  notes = fakeSkillNotes()
})

/**
 * The citizen's own notes, laid in front of it at the moment it decides what to
 * do (`#376`).
 *
 * This is the defect `#349` fixed for a task read, one level up and on the
 * surface that matters more: `kolonie.tasks.get` is a call the agent has to
 * decide to make, and the wake-up is the call it was *told* to make. Measured
 * live against production on 2026-08-05 for a citizen holding `domain` and
 * `profile` — the response offered four entries including *"Prove you can drive
 * a browser"*, named the held skills as a bare list, and carried no note
 * anywhere.
 *
 * **The bound is the part under test.** What is pushed has to scale with the
 * work being offered and not with what the citizen holds, so the rejection case
 * below is the assertion that matters most.
 */
describe('the notes the wake-up lays in front of a citizen', () => {
  const offering = (tasks: readonly ReturnType<typeof aTask>[]) => {
    const catalogue = fakeCatalogue()
    catalogue.answers({ outcome: 'listed', page: { items: [...tasks], nextCursor: null } })
    return {
      source: { catalogue, quests: fakeQuests() },
      skills: ['browser', 'mailbox', 'profile'],
    }
  }

  const waking = async (tasks: readonly ReturnType<typeof aTask>[]) =>
    (await wakeup(agentId, {}, source, noContributions, offering(tasks) as never, notes)).response

  const withNoteOn = async (skill: string, note: string) => {
    notes.grant(agentId, skill)
    await notes.write(agentId, skill, note)
  }

  it('carries the note for a capability the offered work requires', async () => {
    await withNoteOn('browser', 'Start it headless or the captcha page will not render.')

    const response = await waking([
      aTask({ title: 'Drive a browser', requires: ['browser'] as never }),
    ])

    expect(response.capabilityNotes).toEqual([
      {
        skill: 'browser',
        preview: 'Start it headless or the captcha page will not render.',
        truncated: false,
        writtenAt: '2026-08-05T09:00:00.000Z',
        full: { tool: 'kolonie.skills.note', arguments: { skill: 'browser' } },
      },
    ])
  })

  /**
   * The capability an agent most needs its own note about is frequently a
   * suggested one: the rung requires `profile` and leans on the browser it is
   * about to reach for Playwright instead of.
   */
  it('carries it for a capability the work only suggests', async () => {
    await withNoteOn('browser', 'The profile at ~/.config/agent survives a restart.')

    const response = await waking([
      aTask({
        title: 'Register a domain',
        requires: ['profile'] as never,
        suggests: ['browser'] as never,
      }),
    ])

    expect(response.capabilityNotes.map((entry) => entry.skill)).toEqual(['browser'])
  })

  /**
   * **The rejection case, and the bound this issue exists to hold.** A citizen
   * holding a skill it wrote a note on, where nothing on offer touches that
   * skill, does not see the note. Without this the payload grows with holdings
   * rather than with the work — which is the exact failure `kolonie-docs#159`
   * bounds against.
   */
  it('does not carry a note for a held capability nothing on offer touches', async () => {
    await withNoteOn('mailbox', 'The reach address is the one on the register.')

    const response = await waking([
      aTask({ title: 'Drive a browser', requires: ['browser'] as never }),
    ])

    expect(response.capabilityNotes).toEqual([])
  })

  it('does not return any of ten held notes when bounded open work touches none', async () => {
    const untouched = Array.from({ length: 10 }, (_, index) => `untouched-${index}`)
    for (const skill of untouched) await withNoteOn(skill, `How I use ${skill}.`)

    const response = await waking([
      aTask({ title: 'Drive a browser', requires: ['browser'] as never }),
    ])

    expect(response.capabilityNotes).toEqual([])
    expect(response.capabilityNotesOmitted).toBe(0)
  })

  it('carries only the touched one when the citizen has notes on both', async () => {
    await withNoteOn('browser', 'How I drive it.')
    await withNoteOn('mailbox', 'How I read it.')

    const response = await waking([
      aTask({ title: 'Drive a browser', requires: ['browser'] as never }),
    ])

    expect(response.capabilityNotes.map((entry) => entry.skill)).toEqual(['browser'])
  })

  it('carries nothing when the citizen has written no notes at all', async () => {
    const response = await waking([
      aTask({ title: 'Drive a browser', requires: ['browser'] as never }),
    ])

    expect(response.capabilityNotes).toEqual([])
  })

  /**
   * The bound is structural rather than a constant that could drift: the
   * capabilities considered are read off the entries actually in `open`, so
   * whatever caps that list caps this one, and there is no second number to keep
   * in step.
   */
  it('considers only capabilities named by entries that are actually in open', async () => {
    await withNoteOn('browser', 'How I drive it.')

    const response = await waking([
      aTask({ title: 'Drive a browser', requires: ['browser'] as never }),
    ])

    const touched = new Set(response.open.entries.flatMap((entry) => entry.touches))
    for (const entry of response.capabilityNotes) {
      expect(touched.has(String(entry.skill))).toBe(true)
    }
  })

  it('is identical on a second call and consumes nothing', async () => {
    await withNoteOn('browser', 'How I drive it.')
    const task = aTask({ title: 'Drive a browser', requires: ['browser'] as never })

    const first = await waking([task])
    const second = await waking([task])

    expect(second.capabilityNotes).toEqual(first.capabilityNotes)
  })

  it('bounds a maximum-length note without changing the stored note', async () => {
    const full = 'x'.repeat(2000)
    await withNoteOn('browser', full)

    const response = await waking([
      aTask({ title: 'Drive a browser', requires: ['browser'] as never }),
    ])

    expect(response.capabilityNotes[0]).toMatchObject({
      preview: 'x'.repeat(SKILL_NOTE_PREVIEW_MAX_LENGTH),
      truncated: true,
    })
    expect(JSON.stringify(response)).not.toContain('x'.repeat(SKILL_NOTE_PREVIEW_MAX_LENGTH + 1))
    expect((await notes.read(agentId, 'browser'))?.note).toBe(full)
  })

  it('preserves ranked-work order and omits previews past the aggregate bound', async () => {
    const skills = ['github', 'browser', 'mailbox', 'profile']
    for (const skill of skills) await withNoteOn(skill, skill.repeat(240).slice(0, 240))

    const response = await waking([
      aTask({ title: 'First work', requires: ['github', 'browser'] as never }),
      aTask({ title: 'Second work', requires: ['mailbox', 'profile'] as never }),
    ])

    expect(response.capabilityNotes.map((entry) => entry.skill)).toEqual([
      'github',
      'browser',
      'mailbox',
    ])
    expect(response.capabilityNotesOmitted).toBe(1)
    expect(
      response.capabilityNotes.reduce((sum, entry) => sum + [...entry.preview].length, 0),
    ).toBe(SKILL_NOTES_PREVIEW_TOTAL_MAX_LENGTH)
  })

  it('does not make a quiet waking loud or actionable', async () => {
    await withNoteOn('browser', 'How I drive it.')

    const response = await waking([
      aTask({ title: 'Drive a browser', requires: ['browser'] as never }),
    ])
    const withoutOpenWork = {
      ...response,
      open: { ...response.open, actionable: false },
      actionableNow: false,
    }

    expect(wakeupIsQuiet(withoutOpenWork)).toBe(true)
    expect(withoutOpenWork.actionableNow).toBe(false)
  })

  describe('what the citizen actually reads', () => {
    it('carries the note in the text, not only in the structured half', async () => {
      await withNoteOn('browser', 'Start it headless or the captcha page will not render.')

      const text = wakeupAsText(
        await waking([aTask({ title: 'Drive a browser', requires: ['browser'] as never })]),
      )

      expect(text).toContain('What you already know how to do')
      expect(text).toContain('browser: Start it headless')
    })

    it('marks previews as untrusted private words and names the full-read call', async () => {
      await withNoteOn('browser', 'How I drive it.'.repeat(30))

      const text = wakeupAsText(
        await waking([aTask({ title: 'Drive a browser', requires: ['browser'] as never })]),
      )

      expect(text).toContain('Your untrusted private note previews')
      expect(text).toContain('kolonie.skills.note with skill: browser and no note argument')
    })

    it('reports note previews omitted by the aggregate bound', async () => {
      const skills = ['github', 'browser', 'mailbox', 'profile']
      for (const skill of skills) await withNoteOn(skill, skill.repeat(240).slice(0, 240))

      const text = wakeupAsText(
        await waking([
          aTask({ title: 'First work', requires: ['github', 'browser'] as never }),
          aTask({ title: 'Second work', requires: ['mailbox', 'profile'] as never }),
        ]),
      )

      expect(text).toContain('1 more notes you wrote on capabilities in play')
      expect(text).toContain('kolonie.skills.note reads any of them back')
    })

    it('prints no heading at all when there is no note to lay down', async () => {
      const text = wakeupAsText(
        await waking([aTask({ title: 'Drive a browser', requires: ['browser'] as never })]),
      )

      expect(text).not.toContain('What you already know how to do')
    })
  })
})
