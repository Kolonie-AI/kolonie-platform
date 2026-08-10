import { describe, expect, it } from 'vitest'
import { aTask } from '../../__fixtures__/catalogue.js'
import { taskAsText } from './tasks.js'

describe('task text spacing', () => {
  it('keeps one blank line before instructions when optional sections are absent', () => {
    const task = aTask({
      kind: 'quest',
      status: 'retired',
      instructions: 'Use the account you proved at the required rung.',
    })

    const text = taskAsText(task, 0, false, 1, false)

    expect(text).toContain(
      'Retired — readable, but no longer accepting submissions.\n\n' + task.instructions,
    )
  })
})
