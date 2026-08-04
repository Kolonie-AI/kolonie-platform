import { describe, expect, it } from 'vitest'
// The same arrangement as the storage barrel's generator: a script deliberately
// outside the TypeScript project, so nothing in `src/` can import it by
// accident, imported here because the decision it makes is the part worth
// testing.
//
// The namespace import keeps the suppression on one line. `@ts-expect-error`
// covers the line that follows it, and a named import long enough for prettier
// to wrap puts the module specifier — which is where TypeScript reports this —
// out of its reach.
// @ts-expect-error — untyped by design; see above.
import * as script from '../scripts/relax-test-durability.mjs'

const { problemsWith, relax, RELAXED, VERIFY_ATTEMPTS, verifyRelaxed } = script as {
  problemsWith: (rows: readonly { name: string; setting: string }[]) => string[]
  relax: (
    sql: never,
    readSettings: () => Promise<readonly { name: string; setting: string }[]>,
    wait: (ms: number) => Promise<void>,
  ) => Promise<string[]>
  RELAXED: readonly (readonly [string, string])[]
  VERIFY_ATTEMPTS: number
  verifyRelaxed: (
    readSettings: () => Promise<readonly { name: string; setting: string }[]>,
    wait: (ms: number) => Promise<void>,
    attempts?: number,
  ) => Promise<string[]>
}

/**
 * `#283`. The script turns three durability settings off and then asks the
 * server what it actually has. **This tests the asking, not the turning off** —
 * whether `ALTER SYSTEM` works is PostgreSQL's business, whereas whether a
 * half-applied change is reported as success is ours.
 *
 * The reason that is the interesting half: the failure mode here is silent. A
 * suite running at stock speed is not wrong, it is slow, and slow does not show
 * up in an exit code. If this check ever returns "fine" for a server that did not
 * take the settings, nothing downstream will ever say so — the same shape as the
 * skipped database tests `#224` closed, where a third of the suite reported green
 * by not running.
 */
describe('deciding whether the test database took the relaxed settings', () => {
  const asRows = (settings: Record<string, string>) =>
    Object.entries(settings).map(([name, setting]) => ({ name, setting }))

  const allOff = () => Object.fromEntries(RELAXED.map(([name]) => [name, 'off']))

  it('is satisfied when every setting reports the value it was asked for', () => {
    expect(problemsWith(asRows(allOff()))).toEqual([])
  })

  it('names the setting that is still on, rather than failing anonymously', () => {
    const problems: string[] = problemsWith(asRows({ ...allOff(), fsync: 'on' }))

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('fsync')
    expect(problems[0]).toContain('on')
  })

  /**
   * The rejection case that motivates the function existing at all.
   *
   * A server that does not know a setting returns no row for it, and a check
   * written as "every row I got back says off" passes on an empty result. That is
   * not a hypothetical shape: it is what a different major version, or a renamed
   * GUC, looks like from here — and `operations/testing.md` pins CI to PostgreSQL
   * 16 precisely because the major version is a thing that moves.
   */
  it('refuses a server that simply did not mention a setting', () => {
    const { fsync: _dropped, ...rest } = allOff()

    const problems: string[] = problemsWith(asRows(rest))

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('fsync')
  })

  it('reports every setting that is wrong, not just the first', () => {
    const problems: string[] = problemsWith(
      asRows({ fsync: 'on', synchronous_commit: 'on', full_page_writes: 'on' }),
    )

    expect(problems).toHaveLength(RELAXED.length)
  })

  it('ignores rows it did not ask about, so a wider query cannot mask a gap', () => {
    expect(problemsWith(asRows({ ...allOff(), wal_level: 'replica' }))).toEqual([])
  })
})

/**
 * `#294`. The check was right and the way it asked was wrong.
 *
 * It asked the session that had just called `pg_reload_conf()` — the one witness
 * that cannot answer, because the postmaster signals its backends and they adopt
 * the new file when they next look. So the script failed on the run that applied
 * the settings and succeeded on the next one, and the container this
 * repository's tests run against sat at full durability all day.
 *
 * **The first-run case is the one under test here**, because it is the one that
 * was broken and the one nobody re-runs to check.
 */
describe('asking whether the settings landed', () => {
  const asRows = (settings: Record<string, string>) =>
    Object.entries(settings).map(([name, setting]) => ({ name, setting }))

  const allOff = () => Object.fromEntries(RELAXED.map(([name]) => [name, 'off']))
  const allOn = () => Object.fromEntries(RELAXED.map(([name]) => [name, 'on']))

  /** A server whose reload lands after `adoptsAfter` asks. */
  const serverThatCatchesUp = (adoptsAfter: number) => {
    let asked = 0
    return {
      readSettings: async () => {
        asked++
        return asRows(asked > adoptsAfter ? allOff() : allOn())
      },
      asks: () => asked,
    }
  }

  const noWait = async () => {}

  it('is satisfied by a server that reports the settings on the first ask', async () => {
    const server = serverThatCatchesUp(0)

    expect(await verifyRelaxed(server.readSettings, noWait)).toEqual([])
    expect(server.asks()).toBe(1)
  })

  /**
   * The defect, stated as the behaviour that was missing: a reload that has not
   * been adopted yet is not a refusal.
   */
  it('waits out a reload that has not been adopted yet rather than calling it a refusal', async () => {
    const server = serverThatCatchesUp(3)

    expect(await verifyRelaxed(server.readSettings, noWait)).toEqual([])
    expect(server.asks()).toBe(4)
  })

  /**
   * The half that must not be lost. This check exists for a server that will not
   * take the settings — a build without them, a `postgresql.conf` that pins them
   * — and a retry loop that never gives up would turn one lie into a hang.
   */
  it('still fails a server that never takes them, and stops asking', async () => {
    const server = serverThatCatchesUp(Number.POSITIVE_INFINITY)

    const problems: string[] = await verifyRelaxed(server.readSettings, noWait)

    expect(problems).toHaveLength(RELAXED.length)
    expect(server.asks()).toBe(VERIFY_ATTEMPTS)
  })

  it('waits between asks, so the bound is time and not just a count', async () => {
    const waited: number[] = []
    const server = serverThatCatchesUp(2)

    await verifyRelaxed(server.readSettings, async (ms: number) => {
      waited.push(ms)
    })

    expect(waited).toHaveLength(2)
    expect(waited.every((ms) => ms > 0)).toBe(true)
  })

  /**
   * The arrangement, end to end: the settings are written on the connection that
   * is open, and the verdict comes from somewhere else entirely.
   */
  it('never reads the settings back through the connection that wrote them', async () => {
    const written: string[] = []
    const sql = Object.assign(async () => [] as unknown[], {
      unsafe: async (statement: string) => void written.push(statement),
    }) as never

    const problems: string[] = await relax(sql, async () => asRows(allOff()), noWait)

    expect(problems).toEqual([])
    expect(written).toHaveLength(RELAXED.length)
    expect(written.every((statement) => statement.startsWith('alter system set'))).toBe(true)
  })
})
