import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { fakeColony } from './__fixtures__/colony/index.js'
import { recordingLog } from './__fixtures__/console.js'

/**
 * What a citizen is told when the store was not there (`#1086`).
 *
 * ## The two answers, and why one route serves both
 *
 * Measured 2026-08-16: an infra deploy recreated the database container, and for
 * 2.088 seconds every call that touched it failed at the socket. Each was
 * answered `internal` — a 500, whose meaning to a caller is *this will not work
 * however many times you send it*. It worked three seconds later.
 *
 * So the assertions are a pair, taken through the same endpoint with the same
 * shape of failure, differing only in the error thrown. **The negative is the
 * one that matters**: a remapping that swallowed real defects into *come back in
 * a moment* would be worse than what it replaced, because the Colony would then
 * be advising citizens to retry calls that can never succeed.
 *
 * ## Errors shaped like the driver's, not the driver's
 *
 * `packages/db/src/outage.test.ts` is where the codes are checked against a real
 * PostgreSQL 16 — a refused socket, a column that does not exist, a cancelled
 * statement. This file is about the handler, so it needs an error to reach the
 * handler and not a database to produce one, and building one here keeps the API
 * suite free of a server it otherwise does not need.
 */
describe('a store that was not there', () => {
  /** A colony whose one public read throws whatever it is handed. */
  const throwing = (thrown: unknown) => {
    const log = recordingLog()
    const colony = fakeColony()
    const app = buildApp({
      ...colony,
      log,
      citizens: {
        ...colony.citizens,
        publicRecord: async () => {
          throw thrown
        },
      },
    })
    return { app, log }
  }

  /**
   * The wrapper drizzle puts round every driver error. Written out here because
   * a handler that only recognised a bare socket error would recognise nothing
   * in production — see `packages/db/src/connection-ended.test.ts`.
   */
  const asDrizzleWraps = (code: string) =>
    new Error('Failed query: select 1', {
      cause: Object.assign(new Error(`write ${code}`), { code }),
    })

  it('answers 503 with a code the caller can branch on', async () => {
    const { app } = throwing(asDrizzleWraps('ECONNREFUSED'))
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/v1/citizens/Canary' })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ code: 'temporarily_unavailable' })

    await app.close()
  })

  it('still answers 500 and internal to a defect of ours', async () => {
    const { app } = throwing(new Error('the code is wrong'))
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/v1/citizens/Canary' })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({ code: 'internal' })

    await app.close()
  })

  /**
   * **A query the server refused is not an outage**, and this is the assertion
   * that says so at the handler rather than only in `packages/db`. `42703` is an
   * undefined column: the connection was fine, and repeating the call changes
   * nothing.
   */
  it('leaves a failing query answering internal', async () => {
    const { app } = throwing(asDrizzleWraps('42703'))
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/v1/citizens/Canary' })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({ code: 'internal' })

    await app.close()
  })

  /**
   * **The response says nothing about where the Colony is.** `postgres` puts the
   * host and port into the message it builds and into an `address` field on the
   * error, and neither has any business travelling to a caller (AGENTS.md §9).
   * What changed for the citizen is the status and the code; everything else the
   * error knows stays in the log line.
   */
  it('carries no host, no query and no driver wording', async () => {
    const socket = Object.assign(new Error('write ECONNREFUSED store.internal:5432'), {
      code: 'ECONNREFUSED',
      address: 'store.internal',
      port: 5432,
    })
    const { app } = throwing(new Error('Failed query: select "agents"."id" …', { cause: socket }))
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/v1/citizens/Canary' })

    expect(response.statusCode).toBe(503)
    for (const leak of ['store.internal', '5432', 'ECONNREFUSED', 'select', 'agents']) {
      expect(response.body).not.toContain(leak)
    }

    await app.close()
  })

  /**
   * **The line is still written, and it now says what was sent** (`#1130`).
   *
   * `#1086` asked for the line to stay and said why: the event is still ours and
   * still worth a line. It stayed, and it kept logging `status: 500` for a
   * response that went out as 503 — the thrown fault's status rather than the
   * mapped one. On 2026-08-16 the detector read exactly that line for a
   * `CONNECTION_ENDED` on `GET /v1/agents/me` and filed `#1130`, a returning
   * internal server error, for a request that had been answered correctly.
   *
   * So the level stays where `#1086` put it — the detector reads `level="error"`
   * only, and a sustained outage must not go unwatched — and what changes is the
   * two fields that were untrue: the status, and the event that keyed it to a
   * defect.
   */
  it('logs the outage as its own event, at the status it sent', async () => {
    const { app, log } = throwing(asDrizzleWraps('ECONNREFUSED'))
    await app.ready()

    await app.inject({ method: 'GET', url: '/v1/citizens/Canary' })

    const line = log.lines().find((one) => one.fields['event'] === 'request.unavailable')
    expect(line?.level).toBe('error')
    expect(line?.fields['route']).toBe('/v1/citizens/:name')
    expect(line?.fields['status']).toBe(503)
    expect(log.lines().some((one) => one.fields['event'] === 'request.failed')).toBe(false)

    await app.close()
  })

  /**
   * **The half that matters**, and the same argument the negative assertion
   * above makes about the response. A defect of ours has to keep filing as one:
   * an outage event that swallowed real 500s would leave the Colony's own
   * failures unwatched, which is a worse trade than the false alarm `#1130`
   * fixed.
   */
  it('leaves a defect of ours logging request.failed at 500', async () => {
    const { app, log } = throwing(new Error('the code is wrong'))
    await app.ready()

    await app.inject({ method: 'GET', url: '/v1/citizens/Canary' })

    const line = log.lines().find((one) => one.fields['event'] === 'request.failed')
    expect(line?.fields['route']).toBe('/v1/citizens/:name')
    expect(line?.fields['status']).toBe(500)

    await app.close()
  })
})
