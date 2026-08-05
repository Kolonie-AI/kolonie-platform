import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AgentIdSchema, type Task } from '@kolonie-ai/core'
import { aTask, fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeGuidance } from './__fixtures__/guidance.js'
import { fakeSkillNotes } from './__fixtures__/skill-notes.js'
import { listTasks } from './tasks.js'
import { taskListAsText } from './mcp/text/tasks.js'

const agentId = AgentIdSchema.parse(randomUUID())

/**
 * Where the reader stands on each listed task's skills (`#380`).
 *
 * **The surface an agent uses to *choose* carried less than the surface it uses
 * to *read*, which is backwards.** `skillStandings` had one call site, inside
 * `getTask`, and the listing attached nothing — so a citizen choosing from a
 * page could not tell a task it was fully equipped for from one it would have to
 * acquire something for without calling `kolonie.tasks.get` on every candidate.
 * By then it has already chosen.
 *
 * **The bound is what most of this file asserts.** A default page is 25 tasks
 * and a note may be 2,000 characters, so notes in a listing would be up to
 * 50,000 characters of context spent on work the citizen has not chosen.
 */
describe('the skill standings on a page of tasks', () => {
  const noAccounts = { resolve: async () => [], heldByKind: async () => new Map() }

  const list = async (options: {
    readonly tasks: readonly Task[]
    readonly held?: readonly string[]
    readonly withStanding?: boolean
  }) => {
    const catalogue = fakeCatalogue()
    catalogue.answers({
      outcome: 'listed',
      page: { items: [...options.tasks], nextCursor: null },
    })

    const result = await listTasks(
      {},
      agentId,
      catalogue,
      fakeGuidance(),
      noAccounts as never,
      options.withStanding === false ? undefined : { held: options.held ?? [] },
    )
    if (result.outcome !== 'listed') throw new Error(result.outcome)
    return result.response
  }

  const agent = { skills: ['browser'] } as never

  it('reports the reader’s standing on a task’s required and suggested skills', async () => {
    const task = aTask({
      title: 'Register a domain you control',
      requires: ['profile'] as never,
      suggests: ['browser', 'mailbox'] as never,
    })

    const [standing] = (await list({ tasks: [task], held: ['profile', 'browser'] })).standings

    expect(standing?.requiredHeld).toEqual(['profile'])
    expect(standing?.requiredLacking).toEqual([])
    expect(standing?.suggestedHeld).toEqual(['browser'])
    expect(standing?.suggestedLacking).toEqual(['mailbox'])
  })

  it('carries one entry per listed task, including the ones with nothing held', async () => {
    const tasks = [
      aTask({ title: 'One', requires: ['profile'] as never }),
      aTask({ title: 'Two', requires: ['browser'] as never }),
    ]

    const response = await list({ tasks, held: [] })

    expect(response.standings).toHaveLength(2)
    expect(response.standings.map((standing) => standing.requiredLacking)).toEqual([
      ['profile'],
      ['browser'],
    ])
  })

  it('carries nothing at all when the caller supplied no standing', async () => {
    const response = await list({
      tasks: [aTask({ requires: ['profile'] as never })],
      withStanding: false,
    })

    expect(response.standings).toEqual([])
  })

  /**
   * **The rejection case, and the bound this issue turns on.** A citizen with
   * notes on skills the listed tasks touch sees none of that text anywhere in
   * the listing — not in the structured half and not in the rendering.
   *
   * It holds by construction rather than by filtering: `TaskSkillStanding` has
   * nowhere to put a note, and `listingStandings` cannot reach a note store. A
   * field that is present but blank is a field somebody eventually fills back
   * in.
   */
  it('carries no note text anywhere, for a citizen that has written them', async () => {
    const notes = fakeSkillNotes()
    const secret = 'The browser profile lives somewhere I would rather not repeat on a page.'
    notes.grant(agentId, 'browser')
    await notes.write(agentId, 'browser', secret)

    const task = aTask({ title: 'Drive a browser', suggests: ['browser'] as never })
    const response = await list({ tasks: [task], held: ['browser'] })

    expect(JSON.stringify(response)).not.toContain(secret)
    expect(taskListAsText(response, agent)).not.toContain(secret)
  })

  /**
   * The same bound at the size the issue names it at: a full page, every task
   * touching a skill the citizen has written a note on.
   */
  it('carries no note text at a full page either', async () => {
    const notes = fakeSkillNotes()
    const secret = 'Something private, repeated across twenty-five rows if this were wrong.'
    notes.grant(agentId, 'browser')
    await notes.write(agentId, 'browser', secret)

    const tasks = Array.from({ length: 25 }, (_, index) =>
      aTask({ title: `Rung ${index}`, requires: ['browser'] as never }),
    )
    const response = await list({ tasks, held: ['browser'] })

    expect(response.standings).toHaveLength(25)
    expect(JSON.stringify(response)).not.toContain(secret)
    expect(taskListAsText(response, agent)).not.toContain(secret)
  })

  /**
   * `requires` still gates and `suggests` still does not. Asserted against the
   * same fixture with and without the standing supplied, because *the listing is
   * not re-filtered by this* is the kind of claim that is cheap to make and
   * expensive to be wrong about.
   */
  it('returns the same set of tasks it returned before', async () => {
    const tasks = [
      aTask({ title: 'One', requires: ['profile'] as never, suggests: ['browser'] as never }),
      aTask({ title: 'Two', requires: ['browser'] as never }),
      aTask({ title: 'Three', suggests: ['mailbox'] as never }),
    ]

    const without = await list({ tasks, withStanding: false })
    const with_ = await list({ tasks, held: [] })

    expect(with_.items.map((task) => task.id)).toEqual(without.items.map((task) => task.id))
    expect(with_.items).toHaveLength(3)
  })

  /**
   * Cost does not grow with page size in round trips: the standings are computed
   * from the page already in hand and the reader's own skills, so a page of
   * twenty-five asks the catalogue exactly what a page of one asks it.
   */
  it('resolves a full page without a per-task round trip', async () => {
    const catalogue = fakeCatalogue()
    const tasks = Array.from({ length: 25 }, (_, index) =>
      aTask({ title: `Rung ${index}`, requires: ['browser'] as never }),
    )
    catalogue.answers({ outcome: 'listed', page: { items: tasks, nextCursor: null } })

    const result = await listTasks({}, agentId, catalogue, fakeGuidance(), noAccounts as never, {
      held: ['browser'],
    })
    if (result.outcome !== 'listed') throw new Error(result.outcome)

    expect(result.response.standings).toHaveLength(25)
    // One list read, and the graph is never consulted at all — that is where the
    // granting rung would have come from, and it belongs in `kolonie.tasks.get`.
    expect(catalogue.queries()).toHaveLength(1)
    expect(catalogue.graphReads()).toBe(0)
  })

  describe('the line a citizen reads', () => {
    it('says what is held and what is lacking, in one line', async () => {
      const task = aTask({
        title: 'Register a domain you control',
        requires: ['profile', 'domain'] as never,
        suggests: ['browser'] as never,
      })

      const text = taskListAsText(await list({ tasks: [task], held: ['profile'] }), agent)

      expect(text).toContain('skills: you hold profile; you lack domain;')
    })

    /**
     * A missing suggestion is not a bar, and a citizen that reads it as one
     * skips a rung that is open to it. Same pair of phrasings `#375` settled
     * one surface along.
     */
    it('never phrases a missing suggestion as a lack', async () => {
      const task = aTask({ title: 'Drive a browser', suggests: ['browser'] as never })

      const text = taskListAsText(await list({ tasks: [task], held: [] }), agent)

      expect(text).not.toContain('you lack browser')
      expect(text).toContain('browser would help, not required')
    })

    it('prints no skills line for a task that names none', async () => {
      const task = aTask({ title: 'Something with no edges', requires: [] as never })

      const text = taskListAsText(await list({ tasks: [task], held: ['browser'] }), agent)

      expect(text).not.toContain('skills:')
    })
  })
})
