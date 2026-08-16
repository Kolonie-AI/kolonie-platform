import { describe, expect, it } from 'vitest'
import { createDatabase } from './client.js'
import { isDatabaseOutage } from './outage.js'
import { databaseTestTarget } from './testing.js'

const target = databaseTestTarget()

/**
 * A URL pointing at the same server and at a port nothing serves.
 *
 * **The host is taken from the target rather than written down**, because no
 * address belongs in this repository (`AGENTS.md §9`) and because a hard-coded
 * one would pass on the machine it was written on and fail everywhere else.
 * Port 1 is reserved and no PostgreSQL is ever on it.
 */
const nowhere = (): string => {
  const url = new URL(target.url)
  url.port = '1'
  return url.toString()
}

/**
 * What `isDatabaseOutage` must and must not recognise (`#1086`).
 *
 * ## Against a real server, both halves
 *
 * The interesting assertion is not that a connection failure is recognised — it
 * is that **a genuine defect is still a defect**. A recogniser too eager would
 * answer *come back in a moment* to a query that is wrong and will be wrong
 * tomorrow, and the citizen would retry it forever on the Colony's own advice.
 * So the errors here are produced rather than constructed: a socket nothing is
 * listening on, a column that does not exist, and a statement the server
 * cancelled. A fake shaped like the driver's error would only prove that this
 * file and that fake agree.
 *
 * ## Every error arrives through drizzle
 *
 * Which is the point of asserting on `db.execute` rather than on the driver
 * directly. Drizzle wraps the driver's error and puts the original on `cause` —
 * `connection-ended.test.ts` found that for `#874` — so a recogniser that read
 * the top-level `code` would recognise nothing at all, and would do it silently,
 * because *nothing recognised* is the behaviour that was there before.
 */
describe('telling an outage from a defect', () => {
  it('recognises a socket with nothing behind it', async () => {
    // A short connect timeout so a network that drops rather than refuses still
    // reaches a verdict; both codes are the same answer, which is the point.
    const db = createDatabase(nowhere(), { connect_timeout: 2, max: 1 })

    const failure = await db.execute('select 1 as one').catch((error: unknown) => error)
    await db.close().catch(() => undefined)

    expect(failure).toBeInstanceOf(Error)
    expect(isDatabaseOutage(failure)).toBe(true)
  })

  it('recognises a pool that has been shut down', async () => {
    const db = createDatabase(target.url)
    await db.execute('select 1 as one')
    await db.close()

    const failure = await db.execute('select 1 as one').catch((error: unknown) => error)

    expect(isDatabaseOutage(failure)).toBe(true)
  })

  /**
   * **The assertion this module is judged on.** The server answered, and what it
   * said was *your statement names a column I do not have*. Nothing about
   * repeating that call later helps, so nothing here may call it temporary.
   */
  it('leaves a query the server refused alone', async () => {
    const db = createDatabase(target.url)

    const failure = await db
      .execute('select no_such_column from information_schema.tables')
      .catch((error: unknown) => error)
    await db.close()

    expect(failure).toBeInstanceOf(Error)
    expect(isDatabaseOutage(failure)).toBe(false)
  })

  /**
   * A cancelled statement is the near miss: it is a `57*` SQLSTATE, it arrives
   * from a healthy connection, and it means the query was too slow rather than
   * the server too far away. `57014` is deliberately absent from the set, and
   * this is what says so out loud.
   */
  it('leaves a statement the server cancelled alone', async () => {
    const db = createDatabase(target.url)
    await db.execute(`set statement_timeout = '50ms'`)

    const failure = await db.execute('select pg_sleep(1)').catch((error: unknown) => error)
    await db.close()

    expect((failure as { cause?: { code?: string } }).cause?.code).toBe('57014')
    expect(isDatabaseOutage(failure)).toBe(false)
  })

  it('says nothing about an error that carries no code at all', () => {
    expect(isDatabaseOutage(new Error('something went wrong'))).toBe(false)
    expect(isDatabaseOutage(undefined)).toBe(false)
    expect(isDatabaseOutage(null)).toBe(false)
    expect(isDatabaseOutage('ECONNREFUSED')).toBe(false)
  })

  /**
   * The chain is followed rather than the top read, and a wrapper two deep is
   * still recognised — drizzle adds one layer today and is under no obligation
   * to keep adding exactly one.
   */
  it('reaches a code through more than one wrapper', () => {
    const socket = Object.assign(new Error('write ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const wrapped = new Error('Failed query: select 1', { cause: socket })
    const twice = new Error('while answering', { cause: wrapped })

    expect(isDatabaseOutage(twice)).toBe(true)
  })
})
