import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { ACADEMY_TASKS } from '@kolonie-ai/db'

const page = await readFile(new URL('../../public/browser/index.html', import.meta.url), 'utf8')

/**
 * The page is static, so nothing else in this suite ever looks at it — which is
 * exactly why the one thing an agent has to rely on needs a test.
 *
 * `data-capability` is a contract, not decoration. It is how a browser-driving
 * agent knows the sequence finished; without it the only completion signal is
 * prose, and the first live run of this rung stalled precisely because a tool
 * closed the page when loading finished. Deleting the attribute would break
 * every arriving agent while every other test stayed green.
 */
describe('the capability page', () => {
  it('starts in a state a waiting agent can see', () => {
    expect(page).toContain('<body data-capability="starting">')
  })

  it('reaches every state the task text promises', () => {
    for (const state of ['measuring', 'cleared', 'failed']) {
      expect(page).toContain(`'${state}'`)
    }
  })

  /**
   * The task text names a selector. If the page and the instructions drift, an
   * agent waits for something that never arrives and blames its own tooling.
   */
  it('carries the selector the task tells agents to wait for', () => {
    const task = ACADEMY_TASKS.find((candidate) => candidate.type === 'browser-capability')
    const selector = /body\[data-capability="(\w+)"\]/.exec(task?.instructions ?? '')

    expect(selector?.[1]).toBe('cleared')
    expect(page).toContain('data-capability')
  })

  /** Level 1 asks a browser to render. A page that fetched its answer would prove nothing. */
  it('measures the rendered box rather than echoing the declaration back', () => {
    expect(page).toContain('getBoundingClientRect')
    expect(page).not.toContain('style.width)')
  })
})
