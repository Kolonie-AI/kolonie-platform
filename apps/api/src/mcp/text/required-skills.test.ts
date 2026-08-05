import { describe, expect, it } from 'vitest'
import { TaskIdSchema, type SkillStanding, type Task } from '@kolonie-ai/core'
import { aTask } from '../../__fixtures__/catalogue.js'
import { taskAsText } from './tasks.js'

/**
 * What a citizen is told about the skills a piece of work requires (`#349`,
 * `#354`).
 *
 * **A requirement set was a gate and never information.** A citizen either
 * passed it or did not: nothing said *which* of the skills it holds, and nothing
 * turned a refusal into a route. And the note it wrote against a skill it holds
 * sat in a store nobody opened at the moment it mattered — the citizen holds
 * `browser`, the work needs a browser, and it reaches for Playwright.
 */
describe('the required skills on a task a citizen reads', () => {
  const anId = (n: number) => TaskIdSchema.parse(`4444444${n}-4444-4444-8444-444444444444`)

  const render = (requires: readonly string[], standings: readonly SkillStanding[]): string =>
    taskAsText(
      aTask({ title: 'Answer a question about a browser', requires: requires as Task['requires'] }),
      0,
      false,
      1,
      false,
      null,
      null,
      false,
      [],
      [],
      null,
      standings,
    )

  const standing = (
    over: { skill: string } & Partial<Omit<SkillStanding, 'skill'>>,
  ): SkillStanding =>
    ({ held: false, note: null, grantedBy: null, ...over }) as unknown as SkillStanding

  it('says which of them the reader holds', () => {
    const text = render(
      ['browser', 'mailbox'],
      [standing({ skill: 'browser', held: true }), standing({ skill: 'mailbox', held: true })],
    )

    expect(text).toContain('Required skills: browser, mailbox.')
    expect(text).toContain('You hold all of them.')
  })

  /** A refusal turned into a route, which is what `tasks.frontier` does in the abstract. */
  it('names the rung that grants one the reader lacks', () => {
    const text = render(
      ['browser', 'mailbox'],
      [
        standing({ skill: 'browser', held: true }),
        standing({
          skill: 'mailbox',
          grantedBy: { taskId: anId(1), title: 'Prove a mailbox you control' },
        }),
      ],
    )

    expect(text).toContain('You hold browser.')
    expect(text).toContain('You lack mailbox. “Prove a mailbox you control” grants it')
    expect(text).toContain(`kolonie.tasks.get with taskId ${anId(1)}`)
  })

  /**
   * The rejection case the issue names: a skill no rung grants renders as
   * unobtainable rather than naming a wrong rung. `KNOWN_SKILLS` says outright
   * that a skill nothing grants is a planned rung.
   */
  it('says a skill is unobtainable rather than naming a wrong rung', () => {
    const text = render(['wallet'], [standing({ skill: 'wallet' })])

    expect(text).toContain('no rung currently grants it')
    expect(text).toContain('kolonie.tasks.frontier')
  })

  /**
   * `#349`: the note is laid in front of the citizen rather than waiting to be
   * asked for, because the problem is a failure to remember to look.
   */
  it('lays the reader’s own note in front of it, marked as its own words', () => {
    const text = render(
      ['browser'],
      [
        standing({
          skill: 'browser',
          held: true,
          note: 'The profile lives at ~/.config/agent and survives a restart.',
        }),
      ],
    )

    expect(text).toContain('Your own note on browser, in your words and read by nobody else:')
    expect(text).toContain('The profile lives at ~/.config/agent')
  })

  /** Nothing for a skill with no note: an empty heading is not rendered. */
  it('says nothing about a note that does not exist', () => {
    const text = render(['browser'], [standing({ skill: 'browser', held: true })])

    expect(text).toContain('Required skills: browser.')
    expect(text).not.toContain('Your own note on')
  })

  /** And nothing for a skill the reader does not hold, note or no note. */
  it('never carries a note for a skill the reader does not hold', () => {
    const text = render(['browser'], [standing({ skill: 'browser', held: false })])

    expect(text).not.toContain('Your own note on')
  })

  /**
   * A quest with no requirements says so by saying nothing. An empty heading on
   * every read is how a block becomes something agents skim past.
   */
  it('renders no block at all when nothing is required', () => {
    const text = render([], [])

    expect(text).not.toContain('Required skills')
  })
})
