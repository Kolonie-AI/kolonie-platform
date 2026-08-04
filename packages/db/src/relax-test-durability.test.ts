import { describe, expect, it } from 'vitest'
// @ts-expect-error — the same arrangement as the storage barrel's generator: a
// script deliberately outside the TypeScript project, so nothing in `src/` can
// import it by accident, imported here because the decision it makes is the part
// worth testing.
import { problemsWith, RELAXED } from '../scripts/relax-test-durability.mjs'

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

  const allOff = () => Object.fromEntries(RELAXED.map(([name]: [string]) => [name, 'off']))

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
