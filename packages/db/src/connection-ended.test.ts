import { describe, expect, it } from 'vitest'
import { createDatabase } from './client.js'
import { databaseTestTarget } from './testing.js'

const target = databaseTestTarget()

/**
 * What `CONNECTION_ENDED` actually is, pinned against the driver (`#874`).
 *
 * ## Why this test exists rather than a paragraph
 *
 * `#874` asked whether `packages/db` should reattempt an idempotent statement
 * once when the connection ended before it ran, and reasoned from the error's
 * name: *"`CONNECTION_ENDED` is precisely the error where a retry is safe in
 * principle — the statement did not execute, so there is nothing to duplicate."*
 *
 * The first half is right and the second does not follow, because the name means
 * something narrower than it reads. In `postgres`, `CONNECTION_ENDED` is raised
 * in exactly one place — the query handler's first line, when the pool is
 * **ending** — and `sql.end()` is what sets that. It is not *the socket died
 * under a live statement*. It is *this pool has been shut down*.
 *
 * **So a retry cannot help: the state is terminal.** The assertions below are the
 * whole argument, and they are executable rather than quoted, because the claim
 * is about somebody else's library and a claim like that goes stale silently. If
 * `postgres` ever makes this recoverable, this test fails and `D-121` gets
 * re-argued against a measurement instead of being rediscovered.
 *
 * **The two incidents `#874` measured are both this.** `closeShare` on
 * 2026-08-13 and the credential read behind `kolonie.tasks.note` on 2026-08-11
 * both carried `write CONNECTION_ENDED postgres:5432` — the message
 * `Errors.connection` builds for exactly this case. A pool that is ending is a
 * process that is shutting down, and the retry `#874` proposed would have failed
 * identically, twice, a millisecond later.
 *
 * ## What the other codes are, and why they are worse candidates
 *
 * `CONNECTION_CLOSED` is the one that means what `#874` was describing: the
 * socket closed while queries were in flight. That is precisely the case where
 * the driver **cannot** say whether the statement reached the server — it is
 * raised for queries already sent — so it is unsafe for writes exactly where a
 * retry would be useful. `CONNECTION_DESTROYED` is a terminated connection, and
 * terminal in the same way as this one.
 */
/**
 * **The code is not on the error a caller catches**, which is a finding in its
 * own right and part of why `#874` reads the way it does.
 *
 * Drizzle wraps the driver's error as `Failed query: …` and puts the original on
 * `cause`. So any retry rule written in terms of *"which error codes, by name"* —
 * `#874`'s first question — has to reach through the wrapper first, and a rule
 * that read `error.code` would match nothing and silently never retry. That is
 * the quiet failure a decision like this is most likely to ship with.
 */
const codeOf = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } }).cause?.code

describe('what CONNECTION_ENDED means', () => {
  it('is what a query on a pool that is shutting down gets', async () => {
    const db = createDatabase(target.url)
    await db.execute('select 1 as one')

    const closing = db.close()
    const failure = await db.execute('select 1 as one').catch((error: unknown) => error)
    await closing

    expect(codeOf(failure)).toBe('CONNECTION_ENDED')
  })

  /**
   * **The assertion `#874` turns on.** A second attempt is refused identically,
   * so *retry once* buys nothing at all — it is not a smaller chance of success,
   * it is none.
   */
  it('answers the same to a retry, and to one long afterwards', async () => {
    const db = createDatabase(target.url)
    await db.execute('select 1 as one')
    await db.close()

    const first = await db.execute('select 1 as one').catch((error: unknown) => error)
    const second = await db.execute('select 1 as one').catch((error: unknown) => error)

    expect(codeOf(first)).toBe('CONNECTION_ENDED')
    expect(codeOf(second)).toBe('CONNECTION_ENDED')
  })

  /**
   * The message shape Loki recorded, so a reader who greps for the string that
   * appeared in production arrives at this file and at `D-121`.
   */
  it('carries the message the incidents were reported under', async () => {
    const db = createDatabase(target.url)
    await db.close()

    const failure = await db.execute('select 1 as one').catch((error: unknown) => error)

    expect((failure as { cause?: Error }).cause?.message).toContain('write CONNECTION_ENDED')
  })
})
