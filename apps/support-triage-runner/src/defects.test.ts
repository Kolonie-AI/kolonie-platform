import { describe, expect, it } from 'vitest'
import { defectBody, type DefectReport } from './defects.js'
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
