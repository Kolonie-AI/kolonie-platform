import { describe, expect, it } from 'vitest'
import { TaskIdSchema, type TaskId } from '@kolonie-ai/core'
import type { ProviderChange } from '@kolonie-ai/db'
import { changeMarker, issueBody, respondToChange, type Tripwire } from './tripwire.js'
import { fakeIssues } from './__fixtures__/issues.js'
import type { Log } from './loop.js'

const silent: Log = { info: () => {}, warn: () => {}, error: () => {} }

const aChange = (): ProviderChange => ({
  taskId: TaskIdSchema.parse('11111111-2222-4333-8444-555555555555'),
  reporters: 8,
  windowHours: 48,
  baseline: 3.5,
  required: 7,
})

/** A tripwire that records what it was asked to do and nothing else. */
function fakeTripwire(options: { already?: 'open' | 'closed' } = {}) {
  const recorded: TaskId[] = []
  const resynthesised: TaskId[] = []
  const issues = fakeIssues()

  if (options.already !== undefined) {
    issues.existing({
      body: `${changeMarker(aChange().taskId)}\nFiled on an earlier pass.`,
      state: options.already,
    })
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

  return { tripwire, recorded, resynthesised, issues, opened: issues.opened }
}

describe('responding to a detected provider change', () => {
  it('records, re-synthesises and files, in that order', async () => {
    const { tripwire, recorded, resynthesised, opened } = fakeTripwire()

    await respondToChange(aChange(), tripwire, silent)

    expect(recorded).toEqual([aChange().taskId])
    expect(resynthesised).toEqual([aChange().taskId])
    expect(opened()).toHaveLength(1)
  })

  /** `#1161`: what the next pass looks for has to be the first thing it reads. */
  it('puts the marker on the first line of what it files', async () => {
    const { tripwire, opened } = fakeTripwire()

    await respondToChange(aChange(), tripwire, silent)

    expect(opened()[0]?.body.split('\n')[0]).toBe(changeMarker(aChange().taskId))
  })

  /**
   * A provider change produces reports for days and a maintainer needs one
   * issue, not one per batch.
   */
  it('opens nothing while an issue for the same task is already open', async () => {
    const { tripwire, recorded, resynthesised, opened, issues } = fakeTripwire({ already: 'open' })

    await respondToChange(aChange(), tripwire, silent)

    // The demotion and the rewrite still happen — those protect agents, and the
    // open issue says nothing about whether the briefing is current.
    expect(recorded).toHaveLength(1)
    expect(resynthesised).toHaveLength(1)
    expect(opened()).toEqual([])
    // It says so on the issue that exists, once per cooldown: the tripwire has
    // fired again, and an open issue nobody has touched is not evidence that
    // anybody knows the condition is still holding.
    expect(issues.comments()).toHaveLength(1)
  })

  /**
   * **`#727`/`#867`, the corpus this change exists for** (`#1161`).
   *
   * A maintainer closed the issue while the provider change was still holding,
   * the next pass asked *is anything open* and heard no, and filed `#867` — a
   * second issue about the same rung, which somebody then had to notice, read
   * and close by hand. The marker finds a closed issue too, and a standing
   * finding whose condition still holds is a reopen rather than a second copy.
   */
  it('reopens the closed issue rather than filing a second one', async () => {
    const { tripwire, opened, issues } = fakeTripwire({ already: 'closed' })

    await respondToChange(aChange(), tripwire, silent)

    expect(opened()).toEqual([])
    expect(issues.reopened()).toHaveLength(1)
    expect(issues.comments()).toHaveLength(1)
  })

  /**
   * **`#946`: an issue *about* a watcher is not the watcher's issue.** A person
   * quoted a marker inside a code fence explaining how the convention worked,
   * GitHub's search matched it, and the watcher rewrote their issue twelve
   * minutes after they filed it. Search is a narrowing; the first line is the
   * decision.
   */
  it('does not adopt an issue that merely mentions the marker', async () => {
    const { tripwire, opened, issues } = fakeTripwire()
    issues.existing({
      body: [
        'How the watcher convention works',
        '',
        'The runner puts a marker on the first line, like this:',
        '',
        '```',
        changeMarker(aChange().taskId),
        '```',
      ].join('\n'),
    })

    await respondToChange(aChange(), tripwire, silent)

    expect(opened()).toHaveLength(1)
    expect(issues.comments()).toEqual([])
    expect(issues.reopened()).toEqual([])
  })

  /**
   * **An automated writer is exactly the writer most likely to break this rule**,
   * which is why the body is built from counts and an id and nothing else.
   */
  it('writes an issue body with no citizen text in it', () => {
    const body = issueBody(aChange())

    expect(body).toContain('8 distinct citizens')
    expect(body).toContain('48 hours')
    expect(body).toContain(aChange().taskId)
    // The only prose is the Colony's own. There is no input to this function
    // that could carry a report.
    expect(body).toContain('is quoted here')
  })

  /**
   * `#598`: the first false positive was a maintainer reading *three in 48
   * hours* and having no way to tell it from that rung's ordinary Tuesday. The
   * body now carries what the cluster was measured against.
   */
  it('names the baseline it beat, so a false positive argues with a number', () => {
    const body = issueBody(aChange())

    expect(body).toContain('ordinarily carries 3.5 distinct reporters')
    expect(body).toContain('had to reach 7')
    expect(body).toContain('floor of 3')
  })
})
