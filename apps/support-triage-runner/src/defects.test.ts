import { describe, expect, it } from 'vitest'
import { bodyMarker, defectBody, openIssueFor, type DefectReport } from './defects.js'
import type { KnownIssue } from './github.js'
import type { LogCause } from './logs.js'

/**
 * What the filed issue says about the error's `cause` (`#898`).
 *
 * `#895` is the measurement behind this: the same tool threw every thirty
 * minutes, the samples were cut mid-column-list because Drizzle puts the whole
 * statement in `message`, and the model judging them wrote that it could not
 * tell whether the problem was data, schema, connectivity or the query. The
 * answer — `42809`, *op ANY/ALL (array) requires array on right side* — was on
 * the line it was reading, one field past where the truncation fell.
 */
const report = (
  causes: readonly LogCause[],
  samples: readonly string[] = ['a line'],
): DefectReport => ({
  signature: {
    signature: 'api/mcp.tool.threw',
    service: 'api',
    event: 'mcp.tool.threw',
    route: null,
    count: 4,
  },
  evidence: {
    firstAt: '2026-08-13T09:00:00.000Z',
    lastAt: '2026-08-13T09:29:00.000Z',
    samples,
    causes,
  },
  lastStart: null,
  history: { known: undefined, openIssue: undefined, closedIssue: undefined, lastSeenAt: null },
})

describe('the cause in the body', () => {
  it('names the failure in full, in its own section', () => {
    const body = defectBody(
      report([
        {
          name: 'PostgresError',
          code: '42809',
          message: 'op ANY/ALL (array) requires array on right side',
        },
      ]),
    )

    expect(body).toContain('## The cause')
    expect(body).toContain('`42809`')
    expect(body).toContain('op ANY/ALL (array) requires array on right side')
    // And it says what it does not read, because that is the security claim.
    expect(body).toContain('`parameters`')
  })

  /**
   * **Independent of the sample**, which is the acceptance criterion. The line
   * is long, the sample stays truncated, and the cause is there anyway.
   */
  it('is there whatever the truncated sample happens to end on', () => {
    const cut = `{"err":{"message":"Failed query: select ${'"a", '.repeat(60)}`
    const body = defectBody(
      report([{ name: 'PostgresError', code: '42809', message: 'wrong type' }], [cut]),
    )

    expect(body).toContain('wrong type')
    expect(body.indexOf('## The cause')).toBeGreaterThan(body.indexOf('## Lines'))
  })

  it('says every link of a chain, in order', () => {
    const body = defectBody(
      report([
        { name: 'DrizzleQueryError', code: null, message: 'Failed query' },
        { name: 'PostgresError', code: '42809', message: 'wrong type' },
      ]),
    )

    expect(body).toContain('| 1 | `DrizzleQueryError` |')
    expect(body).toContain('| 2 | `PostgresError` | `42809` |')
    // A cause with no code is a dash, not an empty cell and not `undefined`.
    expect(body).toContain('| 1 | `DrizzleQueryError` | — |')
  })

  /** The rejection case: no cause files exactly what it filed before. */
  it('an error with no cause gets no section at all', () => {
    const body = defectBody(report([]))

    expect(body).not.toContain('## The cause')
    expect(body).not.toContain('undefined')
    expect(body).toContain('## Lines')
  })

  /**
   * A message can hold a `|`, and a table cell cannot. Left unescaped it would
   * not merely look wrong: the columns shift, and the code lands under *Name*.
   */
  it('a message carrying a pipe does not break the table', () => {
    const body = defectBody(report([{ name: 'X', code: null, message: 'a | b' }]))

    expect(body).toContain('a \\| b')
  })
})

/**
 * Which open issue this detector treats as its own.
 *
 * **The marker on the first line, which is where {@link defectBody} puts it.**
 * Matching it anywhere in the body adopts every issue that *discusses* a
 * signature — a triage note quoting the marker, or the issue somebody files
 * asking for the detector to be changed. Next door that is not hypothetical:
 * the draft watcher rewrote `#946` twelve minutes after a person filed it,
 * because the issue quoted a marker inside a code fence.
 */
describe('finding the issue already open for a signature', () => {
  const anIssue = (body: string): KnownIssue => ({
    repository: 'Kolonie-AI/kolonie-platform',
    number: 1,
    title: 'something',
    body,
    url: 'https://github.com/Kolonie-AI/kolonie-platform/issues/1',
  })

  it('matches the marker it filed, and not the title', () => {
    const mine = anIssue(`${bodyMarker('api/mcp.tool.threw')}\n\n## What is failing`)

    expect(openIssueFor('api/mcp.tool.threw', [mine])).toBe(mine)
    expect(openIssueFor('api/other.thing', [mine])).toBeUndefined()
  })

  it('does not adopt an issue that merely quotes the marker', () => {
    const aboutTheDetector = anIssue(
      [
        'Change how the log detector dedupes',
        '',
        '```',
        bodyMarker('api/mcp.tool.threw'),
        '```',
      ].join('\n'),
    )

    expect(openIssueFor('api/mcp.tool.threw', [aboutTheDetector])).toBeUndefined()
  })
})
