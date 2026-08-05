import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AgentIdSchema, type AgentId } from '@kolonie-ai/core'
import { aTask, fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeGuidance } from './__fixtures__/guidance.js'
import { fakeSkillNotes } from './__fixtures__/skill-notes.js'
import { getTask } from './tasks.js'

const agentId = AgentIdSchema.parse(randomUUID())

/**
 * How the standings a task read carries are assembled (`#349`, `#354`).
 *
 * The rendering is asserted in `mcp/text/required-skills.test.ts`; what is here
 * is the half that decides *what is true*: which skills the reader holds, whose
 * notes travel, and where a missing skill is earned.
 */
describe('the skills a task requires, from the reader’s side', () => {
  const noAccounts = { resolve: async () => [] }

  const read = async (options: {
    readonly requires: readonly string[]
    readonly held: readonly string[]
    readonly notes?: ReturnType<typeof fakeSkillNotes>
    readonly graph?: readonly ReturnType<typeof aTask>[]
  }) => {
    const catalogue = fakeCatalogue()
    const task = aTask({ requires: options.requires as never })
    catalogue.answersRead(task)
    if (options.graph !== undefined) catalogue.answersGraph(options.graph)

    const result = await getTask(
      task.id,
      {},
      agentId,
      catalogue,
      fakeGuidance(),
      noAccounts as never,
      {
        held: options.held,
        ...(options.notes === undefined ? {} : { notes: options.notes }),
      },
    )
    if (result.outcome !== 'found') throw new Error(result.outcome)
    return result.response.requiredSkills
  }

  it('marks each required skill held or not, in the task’s own order', async () => {
    const standings = await read({ requires: ['browser', 'mailbox'], held: ['browser'] })

    expect(standings.map((standing) => [standing.skill, standing.held])).toEqual([
      ['browser', true],
      ['mailbox', false],
    ])
  })

  /** The route comes from the graph, which is `tasks.frontier`'s answer arriving here. */
  it('names the active rung that grants a skill the reader lacks', async () => {
    const granter = aTask({ title: 'Prove a mailbox you control', grants: ['mailbox'] as never })

    const standings = await read({
      requires: ['mailbox'],
      held: [],
      graph: [granter],
    })

    expect(standings[0]?.grantedBy).toEqual({ taskId: granter.id, title: granter.title })
  })

  /**
   * The rejection case: a skill no rung grants renders as unobtainable rather
   * than naming a wrong one.
   */
  it('names no rung when nothing active grants it', async () => {
    const retired = aTask({
      title: 'A rung nobody can take',
      grants: ['wallet'] as never,
      status: 'retired' as never,
    })

    const standings = await read({ requires: ['wallet'], held: [], graph: [retired] })

    expect(standings[0]?.grantedBy).toBeNull()
  })

  it('carries the reader’s own note for a skill it holds', async () => {
    const notes = fakeSkillNotes()
    notes.grant(agentId, 'browser')
    await notes.write(agentId, 'browser', 'Start it headless.')

    const standings = await read({ requires: ['browser'], held: ['browser'], notes })

    expect(standings[0]?.note).toBe('Start it headless.')
  })

  /**
   * The rejection case `#349` names: another citizen's note is never rendered,
   * on any surface. The store is keyed on the caller, so the note simply is not
   * there — which is the shape that makes the rule hold rather than a filter
   * somebody has to remember.
   */
  it('never carries another citizen’s note', async () => {
    const notes = fakeSkillNotes()
    const somebodyElse = AgentIdSchema.parse(randomUUID()) as AgentId
    notes.grant(somebodyElse, 'browser')
    await notes.write(somebodyElse, 'browser', 'Something private to them.')
    notes.grant(agentId, 'browser')

    const standings = await read({ requires: ['browser'], held: ['browser'], notes })

    expect(standings[0]?.note).toBeNull()
  })

  it('carries nothing when the task requires nothing', async () => {
    expect(await read({ requires: [], held: ['browser'] })).toEqual([])
  })

  /** A caller that cannot answer it gets an empty list rather than a wrong one. */
  it('carries nothing when the caller supplied no standing at all', async () => {
    const catalogue = fakeCatalogue()
    const task = aTask({ requires: ['browser'] as never })
    catalogue.answersRead(task)

    const result = await getTask(
      task.id,
      {},
      agentId,
      catalogue,
      fakeGuidance(),
      noAccounts as never,
    )
    if (result.outcome !== 'found') throw new Error(result.outcome)

    expect(result.response.requiredSkills).toEqual([])
  })
})
