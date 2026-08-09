import { describe, expect, it } from 'vitest'

import { createLog, logLine, logRecord, serialiseError, UNSPECIFIED_EVENT } from './log.js'

/** A logger writing into an array, with a clock that does not move. */
function capturing(service = 'api') {
  const lines: string[] = []
  const log = createLog({
    service,
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
