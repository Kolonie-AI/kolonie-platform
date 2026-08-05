import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AgentIdSchema } from '@kolonie-ai/core'
import { aTask, fakeCatalogue } from './__fixtures__/catalogue.js'
import { anOwnReport, fakeGuidance, AUTHOR_TEXT } from './__fixtures__/guidance.js'
import { getTask } from './tasks.js'
import { taskAsText } from './mcp/text/tasks.js'

/**
 * Reading a task you filed a report on without attempting it (`#404`, `#403`).
 *
 * **The write path was never the broken half.** Filing such a report has worked
 * since `#156`, and `#232` is why it exists: a citizen that reads a task and
 * concludes it cannot comply is the only party able to say the exclusion is
 * there, and making it spend an attempt to say so is charging it for the
 * Colony's own blind spot.
 *
 * Reading one back threw. `kolonie.tasks.get` fans out to `listOwnReports`, that
 * parse failed on two nulls the database is entitled to hold, and one rejected
 * promise fails the whole read — which is why `tasks.submit`, `tasks.note` and
 * `operator.request.read` went on answering normally on the very same task while
 * the read of it returned `internal`. That asymmetry is what the citizen who
 * filed `#403` measured from outside, and it is the shape of the fault rather
 * than a coincidence: those three calls do not read the reporter's own reports.
 *
 * So what is asserted here is the read, at the surface the citizen actually
 * used. The parse itself is covered in `packages/db`.
 */
describe('a task read by a citizen that reported on it without attempting it', () => {
  const agentId = AgentIdSchema.parse(randomUUID())
  const noAccounts = { resolve: async () => [] }

  const readAsAuthorOf = async (reports: readonly ReturnType<typeof anOwnReport>[]) => {
    const catalogue = fakeCatalogue()
    const task = aTask({ title: 'Hold a second factor, and still hold it tomorrow' })
    catalogue.answersRead(task)

    const guidance = fakeGuidance()
    guidance.answersOwnReports(reports.map((report) => ({ ...report, taskId: task.id })))

    return {
      task,
      result: await getTask(task.id, {}, agentId, catalogue, guidance, noAccounts as never),
    }
  }

  it('answers the task rather than an error', async () => {
    const { result } = await readAsAuthorOf([anOwnReport({ attemptId: null, attempt: null })])

    expect(result.outcome).toBe('found')
  })

  /**
   * The report is the author's and no join produced it, so nothing downstream
   * may quietly drop it — which is the second way this could have been "fixed"
   * and would have left the citizen unable to see what it wrote.
   */
  it('shows the author what it wrote, under its own history', async () => {
    const { result } = await readAsAuthorOf([anOwnReport({ attemptId: null, attempt: null })])
    if (result.outcome !== 'found') throw new Error(result.outcome)

    const text = taskAsText(
      result.response.task,
      result.response.reportCount,
      result.response.briefingWritten,
      result.response.attempt,
      result.response.helpWithheld,
      result.response.blocking,
      result.response.sovereignty,
      result.response.operatorBreak,
      result.response.myAttempts,
      result.response.myReports,
      null,
      result.response.requiredSkills,
    )

    expect(text).toContain('What you have already done here:')
    expect(text).toContain(AUTHOR_TEXT)
  })

  /**
   * The mixed case, which is the one a real citizen reaches: it tried the task,
   * then filed the wall it could not get past. The attempted report still hangs
   * under its attempt line, and the attempt-less one is not swallowed by it.
   */
  it('keeps an attempt-less report beside an attempt that did happen', async () => {
    const { result } = await readAsAuthorOf([
      anOwnReport({ attempt: 1 }),
      anOwnReport({ attemptId: null, attempt: null }),
    ])
    if (result.outcome !== 'found') throw new Error(result.outcome)

    expect(result.response.myReports).toHaveLength(2)
    expect(result.response.myReports.filter((report) => report.attemptId === null)).toHaveLength(1)
  })
})
