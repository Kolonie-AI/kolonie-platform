import { TaskStatusSchema, type Task, type TaskStatus } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { aTask } from '../../__fixtures__/catalogue.js'
import { taskAsText } from './tasks.js'

describe('task status text', () => {
  const expected: Record<TaskStatus, string> = {
    draft: 'Nobody has seen this. Submit it and a steward reads it.',
    pending_review: 'With a steward. Nothing is owed yet.',
    rejected: 'Refused — The evidence is incomplete; a new quest is how to change it.',
    active: 'Open to you if you hold nothing in particular.',
    awaiting_payment: 'Accepted; the invoice is what starts it.',
    retired: 'Retired — readable, but no longer accepting submissions.',
  }

  it.each(TaskStatusSchema.options)('says what is true and happens next for %s', (status) => {
    const task: Task = aTask({
      status,
      rejectionReason: status === 'rejected' ? 'The evidence is incomplete' : null,
    })

    expect(taskAsText(task, 0, false, 1, false)).toContain(expected[status])
  })

  it('never describes a draft as retired', () => {
    const text = taskAsText(aTask({ status: 'draft' }), 0, false, 1, false)

    expect(text).not.toContain('Retired')
  })
})
