import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  defectIssuesFiledSince,
  readDefect,
  recordDefectComment,
  recordDefectIssue,
  recordSeenDefects,
} from './log-defects.js'

const target = databaseTestTarget()

/**
 * What the Colony has already noticed in its own logs (`#407`).
 *
 * The one property everything here is arranged around: **the before-state is
 * the return value**. A detector that recorded first and read afterwards could
 * never tell a signature it has just met from one it has been watching for a
 * week, and that distinction is what decides whether to file.
 */
describe('the log defect register', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('answers nothing for a signature it has never seen, and records it', async () => {
    const before = await recordSeenDefects(db, [
      { signature: 'api/poll.failed', service: 'api', occurrences: 3 },
    ])

    expect(before.get('api/poll.failed')).toBeUndefined()
    expect((await readDefect(db, 'api/poll.failed'))?.occurrences).toBe(3)
  })

  it('answers the row as it was before this window, not after it', async () => {
    await recordSeenDefects(db, [{ signature: 'api/poll.failed', service: 'api', occurrences: 3 }])

    const before = await recordSeenDefects(db, [
      { signature: 'api/poll.failed', service: 'api', occurrences: 4 },
    ])

    // Three, because that is what the Colony knew before this call — the row is
    // now at seven, and a caller told seven could not tell a first sighting from
    // a fourth.
    expect(before.get('api/poll.failed')?.occurrences).toBe(3)
    expect((await readDefect(db, 'api/poll.failed'))?.occurrences).toBe(7)
  })

  it('keeps the first sighting when a signature comes back', async () => {
    await recordSeenDefects(db, [{ signature: 'api/x', service: 'api', occurrences: 1 }])
    const first = (await readDefect(db, 'api/x'))?.firstSeenAt

    await recordSeenDefects(db, [{ signature: 'api/x', service: 'api', occurrences: 1 }])

    expect((await readDefect(db, 'api/x'))?.firstSeenAt).toBe(first)
  })

  it('records the issue only when there is one, and counts a regression', async () => {
    await recordSeenDefects(db, [{ signature: 'api/x', service: 'api', occurrences: 1 }])

    const untouched = await readDefect(db, 'api/x')
    expect(untouched?.issueUrl).toBeNull()
    expect(untouched?.issueFiledAt).toBeNull()

    await recordDefectIssue(db, 'api/x', 'https://github.com/Kolonie-AI/kolonie-platform/issues/1')
    expect((await readDefect(db, 'api/x'))?.regressions).toBe(0)

    await recordDefectIssue(
      db,
      'api/x',
      'https://github.com/Kolonie-AI/kolonie-platform/issues/2',
      true,
    )
    const after = await readDefect(db, 'api/x')
    expect(after?.regressions).toBe(1)
    expect(after?.issueUrl).toContain('issues/2')
  })

  /**
   * The per-day cap reads this, and it is on the row rather than in the process
   * for `deferrals`' reason: a count a redeploy forgets is a cap a redeploy
   * lifts, and a runner restarting during an incident is exactly when it matters.
   */
  it('counts what was filed inside a window, and nothing outside it', async () => {
    await recordSeenDefects(db, [
      { signature: 'api/a', service: 'api', occurrences: 1 },
      { signature: 'api/b', service: 'api', occurrences: 1 },
    ])
    await recordDefectIssue(db, 'api/a', 'https://github.com/Kolonie-AI/kolonie-platform/issues/1')

    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString()
    const inAnHour = new Date(Date.now() + 3_600_000).toISOString()

    expect(await defectIssuesFiledSince(db, anHourAgo)).toBe(1)
    // `api/b` was seen and never filed, so it is not in the count — a signature
    // can sit under the cap for days before it becomes an issue.
    expect(await defectIssuesFiledSince(db, inAnHour)).toBe(0)
  })

  it('remembers when a recurrence was last noted', async () => {
    await recordSeenDefects(db, [{ signature: 'api/x', service: 'api', occurrences: 1 }])
    expect((await readDefect(db, 'api/x'))?.lastCommentAt).toBeNull()

    await recordDefectComment(db, 'api/x')

    expect((await readDefect(db, 'api/x'))?.lastCommentAt).not.toBeNull()
  })

  it('takes a windowful of signatures in one statement', async () => {
    const before = await recordSeenDefects(db, [
      { signature: 'api/a', service: 'api', occurrences: 2 },
      { signature: 'traefik/b', service: 'traefik', occurrences: 5 },
    ])

    expect(before.size).toBe(2)
    expect((await readDefect(db, 'traefik/b'))?.service).toBe('traefik')
  })

  it('records nothing for an empty window', async () => {
    expect((await recordSeenDefects(db, [])).size).toBe(0)
  })
})
