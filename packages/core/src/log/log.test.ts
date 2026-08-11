import { describe, expect, it } from 'vitest'

import { createLog, logLine, logRecord, serialiseError, UNSPECIFIED_EVENT } from './log.js'

/** A logger writing into an array, with a clock that does not move. */
function capturing(service = 'api', redactUrls?: readonly (string | undefined)[]) {
  const lines: string[] = []
  const log = createLog({
    service,
    redactUrls,
    write: (line) => lines.push(line),
    now: () => new Date('2026-08-03T09:00:00.000Z'),
  })
  return {
    log,
    lines,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  }
}

describe('createLog', () => {
  it('writes one JSON object per call, with the fixed fields', () => {
    const { log, records } = capturing('verifier-runner')
    log.info('polling', { event: 'poll.start' })

    expect(records()).toEqual([
      {
        ts: '2026-08-03T09:00:00.000Z',
        level: 'info',
        service: 'verifier-runner',
        event: 'poll.start',
        msg: 'polling',
      },
    ])
  })

  it('still accepts a bare message, so no call site had to change first', () => {
    // The migration rule: log.info('polling') must compile and must produce a
    // valid record. A migration that requires touching every call site before
    // anything works is one that stalls half done.
    const { log, records } = capturing()
    log.info('polling')

    expect(records()[0]).toMatchObject({ msg: 'polling', event: UNSPECIFIED_EVENT, level: 'info' })
  })

  it('sets service once, and a call site cannot overwrite the fixed fields', () => {
    const { log, records } = capturing('moderation-runner')
    log.info('hello', { service: 'something-else', level: 'error', msg: 'no' })

    expect(records()[0]).toMatchObject({
      service: 'moderation-runner',
      level: 'info',
      msg: 'hello',
    })
  })

  it('keeps a stack on one line', () => {
    // The failure this whole change is about: console.error(message, error)
    // prints an Error through Node's inspector, so one failure becomes N lines
    // and a collector that treats a line as a record gets N records.
    const { log, lines, records } = capturing()
    const error = new Error('upstream said no')
    log.error('could not file the issue', error, { event: 'github.failed' })

    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('\n')
    expect(records()[0]).toMatchObject({
      level: 'error',
      event: 'github.failed',
      err: { name: 'Error', message: 'upstream said no' },
    })
    expect((records()[0]!['err'] as Record<string, unknown>)['stack']).toContain('upstream said no')
  })

  it('writes no err when nothing was thrown', () => {
    const { log, records } = capturing()
    log.error('the queue is empty and should not be', undefined, { event: 'queue.empty' })

    expect(records()[0]).not.toHaveProperty('err')
  })

  it('removes a configured host from every error in a cause chain', () => {
    const configuredUrl = 'https://gateway.invalid/v1'
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND gateway.invalid'), {
      code: 'ENOTFOUND',
    })
    const transport = new Error('request to gateway.invalid failed', { cause: dns })
    const error = new TypeError('fetch failed', { cause: transport })
    const { log, lines, records } = capturing('moderation-runner', [configuredUrl])

    log.error('model call failed', error, { event: 'llm.failed' })

    expect(lines[0]).not.toContain('gateway.invalid')
    expect(records()[0]).toMatchObject({
      err: {
        cause: {
          message: 'request to [configured-host] failed',
          cause: {
            message: 'getaddrinfo ENOTFOUND [configured-host]',
            code: 'ENOTFOUND',
          },
        },
      },
    })
  })

  it('carries the call site’s own ids flat beside the fixed fields', () => {
    const { log, records } = capturing('support-triage-runner')
    log.info('triaged', { event: 'ticket.triaged', ticketId: 'tkt_1', verdict: 'human' })

    expect(records()[0]).toMatchObject({ ticketId: 'tkt_1', verdict: 'human' })
  })
})

describe('serialiseError', () => {
  it('keeps a thrown non-Error rather than discarding it', () => {
    // What gets thrown when something is truly wrong is exactly the thing least
    // likely to be an Error.
    expect(serialiseError('boom')).toEqual({ name: 'NonError', message: 'boom' })
    expect(serialiseError(undefined)).toEqual({ name: 'NonError', message: 'undefined' })
    expect(serialiseError({ code: 500 })).toMatchObject({ name: 'NonError' })
  })

  it('carries name, message and stack from an Error', () => {
    const error = new TypeError('not a function')
    expect(serialiseError(error)).toMatchObject({ name: 'TypeError', message: 'not a function' })
  })

  it('carries a cause chain and its error codes', () => {
    const cause = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    const error = new TypeError('fetch failed', { cause })

    expect(serialiseError(error)).toMatchObject({
      name: 'TypeError',
      message: 'fetch failed',
      cause: { name: 'Error', message: 'connection reset', code: 'ECONNRESET' },
    })
  })

  /**
   * `#747`. Drizzle throws `Failed query: <the entire SQL>`, and the issue
   * detector files from a 400-character sample of the line — so on
   * `api/mcp.tool.threw` the sample ended inside the column list and the `cause`
   * never appeared. Two issues were filed on that signature, 145 lines apart,
   * and the model judging both wrote that the cause could not be determined.
   */
  it('bounds a message that is a document rather than a sentence', () => {
    const sql = `Failed query: select ${'"credentials"."column", '.repeat(40)}from "credentials"`
    const error = new Error(sql)

    const serialised = serialiseError(error)

    expect(serialised.message.length).toBeLessThan(sql.length)
    expect(serialised.message).toMatch(/… \(truncated\)$/)
    // It keeps the front, which is the part that says what was being asked.
    expect(serialised.message).toContain('Failed query: select "credentials"')
    // And nothing is lost: the stack opens with the message in full.
    expect(serialised.stack).toContain(sql)
  })

  it('leaves an ordinary message exactly as it is', () => {
    expect(serialiseError(new Error('connection reset')).message).toBe('connection reset')
  })

  /**
   * The order is what survives truncation, so it is asserted rather than left to
   * the object literal. A reader who gets only the first 400 characters of a
   * line should have the diagnosis and be missing the stack, not the reverse.
   */
  it('writes the diagnosis before the stack, so a prefix of the line carries it', () => {
    const cause = Object.assign(new Error('terminating connection'), { code: '57P01' })
    const error = Object.assign(new Error('Failed query: select 1'), { cause, code: 'QUERY' })

    const line = JSON.stringify(serialiseError(error))

    expect(Object.keys(serialiseError(error))).toEqual([
      'name',
      'code',
      'message',
      'cause',
      'stack',
    ])
    expect(line.indexOf('57P01')).toBeLessThan(line.indexOf('"stack"'))
  })

  /**
   * A cause's stack is where the inner library threw, which is almost never the
   * question — its name, code and message are. Three nested stacks ahead of the
   * outer one is how a chain that was serialised correctly still arrives
   * unreadable.
   */
  it('gives a stack to the outermost error only', () => {
    const inner = new Error('inner')
    const error = new Error('outer', { cause: inner })

    const serialised = serialiseError(error)

    expect(serialised.stack).toBeDefined()
    expect(serialised.cause?.stack).toBeUndefined()
    expect(serialised.cause?.message).toBe('inner')
  })

  it('serialises at most four errors from a cause chain', () => {
    const looping = new Error('round')
    Object.assign(looping, { cause: looping })

    const serialised = serialiseError(looping)
    expect(serialised.cause?.cause?.cause).toMatchObject({ name: 'Error', message: 'round' })
    expect(serialised.cause?.cause?.cause?.cause).toBeUndefined()
  })
})

describe('logLine', () => {
  it('degrades rather than throwing when a field cannot be serialised', () => {
    // The failure a logger is reporting is usually worse than the failure of
    // the logger, so an unserialisable field must not take the line down.
    const circular: Record<string, unknown> = {}
    circular['self'] = circular

    const line = logLine(
      logRecord({
        level: 'error',
        service: 'api',
        message: 'something went wrong',
        now: new Date('2026-08-03T09:00:00.000Z'),
        fields: { event: 'weird', circular },
      }),
    )

    const record = JSON.parse(line) as Record<string, unknown>
    expect(line).not.toContain('\n')
    expect(record).toMatchObject({
      level: 'error',
      service: 'api',
      event: 'weird',
      unserialisable: true,
    })
  })
})
