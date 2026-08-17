import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { fakeColony } from './__fixtures__/colony/index.js'
import { recordingLog } from './__fixtures__/console.js'

/**
 * What a 5xx line says about *where* it failed (`#896`).
 *
 * The detector keys a defect on `<service>/<event>` and this API logs one event
 * — `request.failed` — for every endpoint it has, so without a third field every
 * 500 anywhere in the API is one signature. (`#1130` split off one sibling,
 * `request.unavailable`, for the store being briefly absent; every defect of
 * ours still shares this one.) `#896`, a failed query on
 * `GET /v1/agents/me`, was filed as a *regression* of `#764`, a payout balance
 * check answering 522, because the two lines are indistinguishable to it. Worse
 * than the mislabel is the dedupe: while either is open, a genuinely new
 * endpoint failure is deduped into an issue about something else and never said
 * out loud.
 *
 * **The route template and never the URL**, which is the property these tests
 * exist for. A URL carries the id the caller sent, so keying on it would file a
 * new defect per citizen and hand the detector's cardinality to strangers.
 */
describe('a 5xx says which route failed', () => {
  /** A colony whose one public read throws, and a log that keeps the line. */
  const throwing = () => {
    const log = recordingLog()
    const colony = fakeColony()
    const app = buildApp({
      ...colony,
      log,
      citizens: {
        ...colony.citizens,
        publicRecord: async () => {
          throw new Error('the database went away')
        },
      },
    })
    return { app, log }
  }

  const routesLogged = (log: ReturnType<typeof recordingLog>) =>
    log
      .lines()
      .filter((line) => line.fields['event'] === 'request.failed')
      .map((line) => line.fields['route'])

  it('names the template, and the URL separately', async () => {
    const { app, log } = throwing()
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/v1/citizens/Canary' })

    expect(response.statusCode).toBe(500)

    const fields = log.lines().find((line) => line.fields['event'] === 'request.failed')?.fields
    expect(fields?.['route']).toBe('/v1/citizens/:name')
    // Both, because an incident needs the path that was actually asked for too.
    expect(fields?.['url']).toBe('/v1/citizens/Canary')

    await app.close()
  })

  /**
   * The property the fix rests on: three citizens hitting one broken endpoint
   * are one defect, and the template is what keeps them one.
   */
  it('says the same thing however many citizens hit it', async () => {
    const { app, log } = throwing()
    await app.ready()

    for (const name of ['Canary', 'Magpie', 'Wren']) {
      await app.inject({ method: 'GET', url: `/v1/citizens/${name}` })
    }

    expect(routesLogged(log)).toEqual([
      '/v1/citizens/:name',
      '/v1/citizens/:name',
      '/v1/citizens/:name',
    ])

    await app.close()
  })
})
