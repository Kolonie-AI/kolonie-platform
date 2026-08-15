import { describe, expect, it } from 'vitest'
import { SPONSOR_ASYMMETRY, type Task } from '@kolonie-ai/core'
import { aTask } from '../../__fixtures__/catalogue.js'
import { taskAsText, taskListAsText } from './tasks.js'

/**
 * What a quest tells a citizen about who is buying (`#961`).
 *
 * A quest is the largest footprint a citizen leaves here — it spends real money
 * and asks other citizens for their afternoon — and it was the only one that
 * arrived anonymous. These are the two surfaces a citizen actually decides from:
 * the page it scans, and the task it opens.
 */
describe('the sponsor a quest names over MCP', () => {
  const aQuest = (overrides: Partial<Task> = {}): Task =>
    aTask({
      kind: 'quest',
      status: 'active',
      title: 'Walk a provider nobody has walked',
      ...overrides,
    })

  const reader = { skills: ['browser'] } as never

  const listOf = (task: Task): string =>
    taskListAsText(
      { items: [task], nextCursor: null, notices: [], sovereignty: [], standings: [] } as never,
      reader,
    )

  it('names the sponsor on the task a citizen opens, with the call that resolves it', () => {
    const text = taskAsText(aQuest({ sponsorHandle: 'ariadne' }), 0, false, 1, false)

    expect(text).toContain('Sponsored by `ariadne`')
    expect(text).toContain('kolonie.citizens.read ariadne')
  })

  /**
   * **The listing and not only the single read.** By the time a citizen has
   * called `kolonie.tasks.get` it has already chosen what to look at, which is
   * the same argument `#380` made about skill standings.
   */
  it('names the sponsor on the page a citizen chooses from', () => {
    expect(listOf(aQuest({ sponsorHandle: 'ariadne' }))).toContain('Sponsored by `ariadne`')
  })

  /**
   * The three unattributed states print nothing rather than *no sponsor*: most
   * tasks here are the Colony's own, and a reader that could tell an opt-out
   * from an erasure would have been told something neither citizen chose to say.
   */
  it.each([
    ['a quest with no sponsor to name', null],
    ['a read that did not ask', undefined],
  ])('says nothing on %s', (_case, handle) => {
    const quest = aQuest({ sponsorHandle: handle as string | null | undefined })

    expect(taskAsText(quest, 0, false, 1, false)).not.toContain('Sponsored by')
    expect(listOf(quest)).not.toContain('Sponsored by')
  })

  /** An Academy rung has no sponsor and gains no line for one. */
  it('leaves an Academy rung reading exactly as it did', () => {
    expect(taskAsText(aTask({ kind: 'academy' }), 0, false, 1, false)).not.toContain('Sponsored by')
  })

  /**
   * **Both halves of the asymmetry, on both surfaces.** A description stating
   * only that the sponsor is named reads as an oversight rather than as `#326`'s
   * decision — so the sentence that says what does *not* travel is asserted
   * where a citizen reads it, not only where it is defined.
   */
  it('states what does not travel back to the sponsor', () => {
    expect(SPONSOR_ASYMMETRY).toContain('the parties that are answering are not')
  })
})
