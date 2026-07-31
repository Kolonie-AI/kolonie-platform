import { describe, expect, it } from 'vitest'
import { TaskIdSchema, type TaskId } from '@kolonie-ai/core'
import type { ProviderChange } from '@kolonie-ai/db'
import { issueBody, respondToChange, type IssueOpener, type Tripwire } from './tripwire.js'
import type { Log } from './loop.js'

const silent: Log = { info: () => {}, warn: () => {}, error: () => {} }

const aChange = (): ProviderChange => ({
  taskId: TaskIdSchema.parse('11111111-2222-4333-8444-555555555555'),
  reporters: 3,
  windowHours: 48,
})

/** A tripwire that records what it was asked to do and nothing else. */
function fakeTripwire(options: { alreadyOpen?: boolean } = {}) {
  const recorded: TaskId[] = []
  const resynthesised: TaskId[] = []
  const opened: { title: string; body: string }[] = []

  const issues: IssueOpener = {
    isOpen: async () => options.alreadyOpen === true,
    open: async (input) => {
      opened.push(input)
      return 'https://example.invalid/issues/1'
    },
  }

  const tripwire: Tripwire = {
    record: async (taskId) => {
      recorded.push(taskId)
    },
    resynthesise: async (taskId) => {
      resynthesised.push(taskId)
    },
    issues,
  }

  return { tripwire, recorded, resynthesised, opened }
}

describe('responding to a detected provider change', () => {
  it('records, re-synthesises and files, in that order', async () => {
    const { tripwire, recorded, resynthesised, opened } = fakeTripwire()

    await respondToChange(aChange(), tripwire, silent)

    expect(recorded).toEqual([aChange().taskId])
    expect(resynthesised).toEqual([aChange().taskId])
    expect(opened).toHaveLength(1)
  })

  /**
   * A provider change produces reports for days and a maintainer needs one
   * issue, not one per batch.
   */
  it('opens nothing while an issue for the same task is already open', async () => {
    const { tripwire, recorded, resynthesised, opened } = fakeTripwire({ alreadyOpen: true })

    await respondToChange(aChange(), tripwire, silent)

    // The demotion and the rewrite still happen — those protect agents, and the
    // open issue says nothing about whether the briefing is current.
    expect(recorded).toHaveLength(1)
    expect(resynthesised).toHaveLength(1)
    expect(opened).toEqual([])
  })

  /**
   * **An automated writer is exactly the writer most likely to break this rule**,
   * which is why the body is built from counts and an id and nothing else.
   */
  it('writes an issue body with no citizen text in it', () => {
    const body = issueBody(aChange())

    expect(body).toContain('3 distinct citizens')
    expect(body).toContain('48 hours')
    expect(body).toContain(aChange().taskId)
    // The only prose is the Colony's own. There is no input to this function
    // that could carry a report.
    expect(body).toContain('is quoted here')
  })

  it('names the threshold it fired on, so a false positive argues with a number', () => {
    expect(issueBody(aChange())).toMatch(/starting position rather than a measurement/)
  })
})
