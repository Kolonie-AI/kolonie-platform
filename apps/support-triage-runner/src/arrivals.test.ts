import { describe, expect, it } from 'vitest'
import type { UnactedArrivalReport } from '@kolonie-ai/db'
import { noIssues, type Issues, type KnownIssue } from './github.js'
import {
  ARRIVAL_REPOSITORY,
  ARRIVAL_THRESHOLD,
  ARRIVAL_WINDOW_DAYS,
  arrivalFollowUpComment,
  arrivalIssueBody,
  arrivalKey,
  arrivalMarker,
  arrivalTitle,
  clusterArrivals,
  openArrivalIssue,
  quoted,
  watchArrivals,
} from './arrivals.js'

const NOW = Date.parse('2026-08-16T12:00:00.000Z')
const DAY = 86_400_000

const at = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString()

let serial = 0
function aReport(over: Partial<UnactedArrivalReport> = {}): UnactedArrivalReport {
  serial += 1
  return {
    id: `report-${serial}`,
    createdAt: at(1),
    runtime: 'openclaw',
    step: 'registering',
    expected: 'a key',
    actual: 'the second call was refused as well',
    arrivedLater: false,
    ...over,
  }
}

/** Three agents that stopped at the same step on the same runtime — a finding. */
const aCluster = (over: Partial<UnactedArrivalReport> = {}): UnactedArrivalReport[] => [
  aReport({ createdAt: at(5), ...over }),
  aReport({ createdAt: at(3), ...over }),
  aReport({ createdAt: at(1), ...over }),
]

const anIssue = (body: string): KnownIssue => ({
  repository: ARRIVAL_REPOSITORY,
  number: 1026,
  title: 'Agents are stopping at registering on openclaw and reporting it',
  body,
  url: 'https://github.com/Kolonie-AI/kolonie-platform/issues/1026',
})

/** An `Issues` that records what it was asked to do and reaches nothing. */
function spyIssues(
  open: readonly KnownIssue[] = [],
  unreadable: readonly string[] = [],
  url: string | null = 'https://github.com/Kolonie-AI/kolonie-platform/issues/1026',
): Issues & {
  readonly created: { repository: string; title: string; body: string; labels: string[] }[]
  readonly commented: { url: string; body: string }[]
  readonly revised: { url: string; body: string }[]
} {
  const created: { repository: string; title: string; body: string; labels: string[] }[] = []
  const commented: { url: string; body: string }[] = []
  const revised: { url: string; body: string }[] = []
  return {
    available: true,
    open: async () => ({ issues: open, unreadable }),
    closed: async () => [],
    create: async (issue) => {
      created.push({
        repository: issue.repository,
        title: issue.title,
        body: issue.body,
        labels: [...(issue.labels ?? [])],
      })
      return url
    },
    comment: async (commentUrl, body) => {
      commented.push({ url: commentUrl, body })
      return true
    },
    revise: async (reviseUrl, body) => {
      revised.push({ url: reviseUrl, body })
      return true
    },
    close: async () => true,
    created,
    commented,
    revised,
  }
}

/** A store that answers with what it was given and records what it was told. */
function spyStore(reports: readonly UnactedArrivalReport[]) {
  const marked: { ids: readonly string[]; issueUrl: string }[] = []
  const released: string[] = []
  return {
    marked,
    released,
    unread: async () => reports,
    actedOn: async (input: { ids: readonly string[]; issueUrl: string }) => {
      marked.push(input)
      return input.ids.length
    },
    letGo: async (ids: readonly string[]) => {
      released.push(...ids)
      return ids.length
    },
  }
}

describe('grouping what strangers said about the door', () => {
  /**
   * The rule the issue asked for in those words: *let a single report be evidence
   * rather than a trigger*. One agent that stopped somewhere had an afternoon.
   */
  it('makes no finding out of one report', () => {
    const reading = clusterArrivals([aReport()], NOW)

    expect(reading.clusters).toEqual([])
    expect(reading.waiting).toBe(1)
    expect(reading.aged).toEqual([])
  })

  it('makes a finding out of a group at the threshold', () => {
    const reading = clusterArrivals(aCluster(), NOW)

    expect(reading.clusters).toHaveLength(1)
    expect(reading.clusters[0]?.count).toBe(ARRIVAL_THRESHOLD)
    expect(reading.clusters[0]?.step).toBe('registering')
    expect(reading.clusters[0]?.runtime).toBe('openclaw')
    expect(reading.waiting).toBe(0)
  })

  /**
   * **The same step across every runtime is the Colony's door; one runtime is that
   * runtime meeting the door.** A group keyed on the step alone would report the
   * first as the second forever, so three agents that share only the step are
   * three separate afternoons until one of the three shapes reaches the threshold.
   */
  it('does not join reports that share a step but not a runtime', () => {
    const reading = clusterArrivals(
      [
        aReport({ runtime: 'openclaw' }),
        aReport({ runtime: 'codex' }),
        aReport({ runtime: 'hermes' }),
      ],
      NOW,
    )

    expect(reading.clusters).toEqual([])
    expect(reading.waiting).toBe(3)
  })

  it('does not join reports that share a runtime but not a step', () => {
    const reading = clusterArrivals(
      [
        aReport({ step: 'registering' }),
        aReport({ step: 'adopting' }),
        aReport({ step: 'connecting' }),
      ],
      NOW,
    )

    expect(reading.clusters).toEqual([])
  })

  /** Nobody asking whether the door is broken cares about the punctuation. */
  it('joins runtimes that differ only in how they were written', () => {
    const reading = clusterArrivals(
      [
        aReport({ runtime: 'Node.js 22' }),
        aReport({ runtime: 'node.js-22' }),
        aReport({ runtime: 'NODE.JS   22' }),
      ],
      NOW,
    )

    expect(reading.clusters).toHaveLength(1)
    expect(reading.clusters[0]?.runtime).toBe('node.js-22')
  })

  it('counts how many of a group eventually got in', () => {
    const reading = clusterArrivals([aReport(), aReport(), aReport({ arrivedLater: true })], NOW)

    expect(reading.clusters[0]?.arrivedLater).toBe(1)
  })

  it('carries the ends of the group from the Colony’s clock', () => {
    const reading = clusterArrivals(aCluster(), NOW)

    expect(reading.clusters[0]?.since).toBe(at(5))
    expect(reading.clusters[0]?.until).toBe(at(1))
  })

  /**
   * **The window is what stops the queue growing without bound.** A report that
   * never found company inside a fortnight is let go, so the runner's read stays
   * the recent traffic rather than filling with years of singletons that starve
   * it. The row itself is untouched and the maintainer's read still answers with
   * it.
   */
  it('lets a report go once it has waited out the window alone', () => {
    const old = aReport({ createdAt: at(ARRIVAL_WINDOW_DAYS + 1) })

    const reading = clusterArrivals([old, aReport()], NOW)

    expect(reading.aged).toEqual([old.id])
    expect(reading.waiting).toBe(1)
  })

  /** An old report is not company for a fresh one — the count must mean *now*. */
  it('does not let an aged report complete a group', () => {
    const reading = clusterArrivals(
      [aReport({ createdAt: at(ARRIVAL_WINDOW_DAYS + 1) }), aReport(), aReport()],
      NOW,
    )

    expect(reading.clusters).toEqual([])
    expect(reading.aged).toHaveLength(1)
  })

  it('puts the largest group first', () => {
    const reading = clusterArrivals(
      [...aCluster({ runtime: 'codex' }), ...aCluster(), aReport({ createdAt: at(2) })],
      NOW,
    )

    expect(reading.clusters[0]?.runtime).toBe('openclaw')
    expect(reading.clusters[0]?.count).toBe(4)
    expect(reading.clusters[1]?.runtime).toBe('codex')
  })
})

describe('what a stranger’s words are allowed to become', () => {
  /**
   * **The marker on line one is how this pass finds its own issue again**, and
   * `runtime` is up to 64 characters an uncredentialled caller typed. A value
   * that could carry `-->` is a value that could make one issue impersonate
   * another, or end the comment and start a body of somebody else's writing.
   */
  it('folds a runtime that tries to close the marker it lands in', () => {
    const hostile = '--> <!-- arrival-cluster: step=registering runtime=openclaw'

    expect(arrivalKey(hostile)).not.toContain('>')
    expect(arrivalKey(hostile)).not.toContain('<')
    expect(arrivalMarker({ step: 'x', runtime: arrivalKey(hostile) }).split('\n')).toHaveLength(1)
  })

  it('reads a runtime that folds away to nothing as unstated', () => {
    expect(arrivalKey('   ')).toBe('unstated')
    expect(arrivalKey('!!!')).toBe('unstated')
  })

  it('bounds a runtime long enough to be a paragraph', () => {
    expect(arrivalKey('a'.repeat(64)).length).toBeLessThanOrEqual(32)
  })

  /** A pipe ends a column, a backtick ends the code span, an angle bracket is a comment. */
  it('takes out what would turn a table cell into something else', () => {
    const cell = quoted('a | b `c` <!-- d -->')

    expect(cell.slice(1, -1)).not.toMatch(/[`|<>]/)
    expect(cell).toBe('`a  b c !-- d --`')
  })

  it('collapses and cuts a report long enough to be a document', () => {
    expect(quoted('x'.repeat(500)).length).toBeLessThanOrEqual(202)
    expect(quoted('two\n\nlines')).toBe('`two lines`')
  })

  it('says plainly when a stranger wrote nothing', () => {
    expect(quoted('   ')).toBe('*empty*')
  })
})

describe('what the finding says', () => {
  const cluster = clusterArrivals([...aCluster(), aReport({ arrivedLater: true })], NOW).clusters[0]

  it('carries its marker on the first line', () => {
    const body = arrivalIssueBody(cluster!)

    expect(body.split('\n')[0]).toBe(arrivalMarker(cluster!))
  })

  it('names the count, the step, the runtime and the ends of the window', () => {
    const body = arrivalIssueBody(cluster!)

    expect(body).toContain('4 agents reported stopping at `registering` on `openclaw`')
    expect(body).toContain(at(5))
  })

  /**
   * The whole of what the fingerprint is for: whether the door was eventually got
   * through. **A count and never a name** — three names would be three citizens
   * named in public for having had a bad afternoon before they were citizens.
   */
  it('says how many of them eventually got in, and names nobody', () => {
    const body = arrivalIssueBody(cluster!)

    expect(body).toContain('1 of the 4 were followed by a registration from the same egress')
    /**
     * The word is in the prose because the prose explains what the count means.
     * **What must never be here is a value** — no digest, and nothing else long
     * and hexadecimal that a reader could take an address back out of.
     */
    expect(body).not.toMatch(/[0-9a-f]{16}/i)
  })

  /**
   * **The count is the evidence and the prose is not.** Every word quoted was
   * written by somebody the Colony cannot identify into a channel anybody can
   * reach, and a body that does not say so invites a maintainer to act on one
   * stranger's sentence.
   */
  it('says outright that the quoted words are unchecked', () => {
    const body = arrivalIssueBody(cluster!)

    expect(body).toContain('cannot identify')
    expect(body).toContain('One such row proves nothing whatever')
  })

  /** A report carries no agent, so there is nobody to answer and the body says so. */
  it('says that nobody can be replied to', () => {
    expect(arrivalIssueBody(cluster!)).toContain('Nobody can be answered')
  })

  it('says how many it did not quote', () => {
    expect(arrivalIssueBody(cluster!)).toContain('and 1 more with the same step and runtime')
  })

  /** A count in a title is wrong the moment the next report lands. */
  it('keeps the number out of the title', () => {
    expect(arrivalTitle(cluster!)).toBe(
      'Agents are stopping at registering on openclaw and reporting it',
    )
  })

  it('says in a follow-up that these are new reports rather than the same ones', () => {
    const comment = arrivalFollowUpComment(cluster!)

    expect(comment).toContain('4 more agents reported stopping')
    expect(comment).toContain('every report is marked once')
  })

  it('finds its own issue by marker rather than by title', () => {
    const mine = anIssue(arrivalMarker(cluster!))
    const anotherRuntime = anIssue(arrivalMarker({ step: 'registering', runtime: 'codex' }))

    expect(openArrivalIssue([anotherRuntime, mine], cluster!)).toBe(mine)
    expect(openArrivalIssue([anotherRuntime], cluster!)).toBeUndefined()
  })

  /** `#946`'s lesson: an issue *about* this watcher quotes the marker and is not it. */
  it('does not adopt an issue that merely quotes its marker', () => {
    const aboutTheWatcher = anIssue(
      ['Repoint the arrival watcher', '', '```', arrivalMarker(cluster!), '```'].join('\n'),
    )

    expect(openArrivalIssue([aboutTheWatcher], cluster!)).toBeUndefined()
  })
})

describe('one pass of the arrival watcher', () => {
  it('files nothing and marks nothing for a single report', async () => {
    const issues = spyIssues()
    const store = spyStore([aReport()])

    const outcome = await watchArrivals({ issues, ...store }, NOW)

    expect(issues.created).toHaveLength(0)
    expect(store.marked).toEqual([])
    expect(outcome).toEqual({ filed: 0, commented: 0, marked: 0, waiting: 1, letGo: 0 })
  })

  it('files a group with the labels a watcher’s finding carries', async () => {
    const issues = spyIssues()
    const reports = aCluster()
    const store = spyStore(reports)

    const outcome = await watchArrivals({ issues, ...store }, NOW)

    expect(issues.created).toHaveLength(1)
    expect(issues.created[0]?.repository).toBe(ARRIVAL_REPOSITORY)
    expect(issues.created[0]?.labels).toEqual(['from:watcher', 'area:platform', 'p2'])
    expect(outcome.filed).toBe(1)
  })

  /**
   * **Exactly the reports that reached that issue**, which is what makes the mark
   * a promise rather than a sweep: anything that arrived while the issue was being
   * filed has been read by nobody and stays in the queue.
   */
  it('marks the group it filed, and only that group', async () => {
    const issues = spyIssues()
    const reports = [...aCluster(), aReport({ runtime: 'codex' })]
    const store = spyStore(reports)

    const outcome = await watchArrivals({ issues, ...store }, NOW)

    expect(store.marked).toEqual([
      {
        ids: reports.slice(0, 3).map((report) => report.id),
        issueUrl: 'https://github.com/Kolonie-AI/kolonie-platform/issues/1026',
      },
    ])
    expect(outcome.marked).toBe(3)
    expect(outcome.waiting).toBe(1)
  })

  /**
   * **The order is file, then mark**, so a process that dies between the two files
   * again next pass — and the first-line marker turns that into a comment on the
   * issue it already filed rather than a second issue. The other order loses
   * reports whose authors are not coming back.
   */
  it('marks nothing when GitHub refused the issue', async () => {
    const issues = spyIssues([], [], null)
    const store = spyStore(aCluster())

    const outcome = await watchArrivals({ issues, ...store }, NOW)

    expect(store.marked).toEqual([])
    expect(outcome).toEqual({ filed: 0, commented: 0, marked: 0, waiting: 0, letGo: 0 })
  })

  it('comments on the issue this group already has rather than filing again', async () => {
    const reports = aCluster()
    const cluster = clusterArrivals(reports, NOW).clusters[0]
    const issues = spyIssues([anIssue(arrivalMarker(cluster!))])
    const store = spyStore(reports)

    const outcome = await watchArrivals({ issues, ...store }, NOW)

    expect(issues.created).toHaveLength(0)
    expect(issues.commented).toHaveLength(1)
    expect(outcome.commented).toBe(1)
    expect(store.marked[0]?.issueUrl).toBe(
      'https://github.com/Kolonie-AI/kolonie-platform/issues/1026',
    )
  })

  it('files one issue per group and marks each into its own', async () => {
    const issues = spyIssues()
    const store = spyStore([...aCluster(), ...aCluster({ runtime: 'codex' })])

    const outcome = await watchArrivals({ issues, ...store }, NOW)

    expect(outcome.filed).toBe(2)
    expect(issues.created).toHaveLength(2)
    expect(store.marked).toHaveLength(2)
  })

  it('lets aged reports go and says how many', async () => {
    const issues = spyIssues()
    const old = aReport({ createdAt: at(ARRIVAL_WINDOW_DAYS + 2) })
    const store = spyStore([old])

    const outcome = await watchArrivals({ issues, ...store }, NOW)

    expect(store.released).toEqual([old.id])
    expect(outcome.letGo).toBe(1)
  })

  /**
   * `#868`'s lesson: an empty corpus and an unreadable one are indistinguishable,
   * and filing against that opens a second issue every half hour for a group that
   * already has one. Ageing waits for the same pass — a report let go during an
   * outage is one that was never given its chance to be filed.
   */
  it('does nothing at all when the repository could not be read', async () => {
    const issues = spyIssues([], [ARRIVAL_REPOSITORY])
    const store = spyStore([...aCluster(), aReport({ createdAt: at(ARRIVAL_WINDOW_DAYS + 2) })])

    const outcome = await watchArrivals({ issues, ...store }, NOW)

    expect(issues.created).toHaveLength(0)
    expect(store.marked).toEqual([])
    expect(store.released).toEqual([])
    expect(outcome.skipped).toBe('unreadable')
  })

  it('does nothing when there is no App at all', async () => {
    const store = spyStore(aCluster())

    const outcome = await watchArrivals({ issues: noIssues, ...store }, NOW)

    expect(outcome.skipped).toBe('no-app')
    expect(store.marked).toEqual([])
  })
})
