import { describe, expect, it } from 'vitest'
import { AgentIdSchema, TaskIdSchema } from '@kolonie-ai/core'
import { aTask, fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeGuidance } from './__fixtures__/guidance.js'
import { fakeAccounts } from './__fixtures__/accounts.js'
import { getTask, listTasks } from './tasks.js'
import { listReports } from './guidance.js'

/**
 * `#232`: which reads count as *this citizen considered this task*.
 *
 * **Fetching the task list is browsing; fetching one task's detail or its
 * briefing is consideration.** A row per listing would record every citizen
 * against every task and mean nothing, and the negative half of that rule is the
 * one that decays quietly — so it is asserted rather than left to the doc
 * comment on the table.
 */
describe('what counts as considering a task', () => {
  const agentId = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')

  const colony = () => {
    const catalogue = fakeCatalogue()
    const guidance = fakeGuidance()
    const task = aTask()
    catalogue.answersRead(task)
    return {
      catalogue,
      guidance,
      taskId: TaskIdSchema.parse(task.id),
      register: fakeAccounts().resolution,
    }
  }

  it('records the citizen against the task it read in full', async () => {
    const { catalogue, guidance, taskId, register } = colony()

    await getTask(taskId, { hints: false }, agentId, catalogue, guidance, register)

    expect(guidance.considered()).toEqual([{ agentId, taskId }])
  })

  it('records the citizen against the task whose briefing it read', async () => {
    const { guidance, taskId } = colony()

    await listReports(taskId, {}, agentId, guidance)

    expect(guidance.considered()).toEqual([{ agentId, taskId }])
  })

  /**
   * The negative half, and the one this test exists for. Browsing is not
   * consideration, and a listing that recorded would put every citizen against
   * every task within a week.
   */
  it('records nothing at all for the listing', async () => {
    const { catalogue, guidance, register } = colony()

    await listTasks({}, agentId, catalogue, guidance, register)

    expect(guidance.considered()).toEqual([])
  })

  /**
   * **It is nobody else's business.** The record exists to prompt one sentence
   * to the citizen it is about; that somebody looked at a task and left is at
   * least as sensitive as the words `task_reports` already keeps for the
   * moderator alone. Nothing here should ever be able to answer *who considered
   * this task*, so the three reads a citizen can reach are checked for any trace
   * of one.
   */
  it('appears in no listing, no task read and no briefing response', async () => {
    const { catalogue, guidance, taskId, register } = colony()

    const listed = await listTasks({}, agentId, catalogue, guidance, register)
    const read = await getTask(taskId, { hints: false }, agentId, catalogue, guidance, register)
    const briefing = await listReports(taskId, {}, agentId, guidance)

    for (const answer of [listed, read, briefing]) {
      expect(JSON.stringify(answer)).not.toMatch(/consider/i)
      expect(JSON.stringify(answer)).not.toMatch(/fetched/i)
    }
  })

  /** A task that does not exist was not considered. */
  it('records nothing for a task id that resolves to nothing', async () => {
    const { catalogue, guidance, register } = colony()
    catalogue.answersRead(undefined)

    const result = await getTask(
      TaskIdSchema.parse('22222222-2222-4222-8222-222222222222'),
      { hints: false },
      agentId,
      catalogue,
      guidance,
      register,
    )

    expect(result.outcome).toBe('rejected')
    expect(guidance.considered()).toEqual([])
  })
})
