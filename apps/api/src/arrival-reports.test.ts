import { describe, expect, it } from 'vitest'
import { ARRIVAL_REPORT_LIMIT } from './rate-limit.js'
import { arrivalReports } from './arrival-reports.js'
import { anArrivalReport, fakeArrivalDesk } from './__fixtures__/arrivals.js'

const AN_ADDRESS = '203.0.113.7'
const ANOTHER_ADDRESS = '198.51.100.4'

/**
 * The port behind both doors (`#1009`) — what it writes, what it hands back, and
 * the two ways it says no.
 *
 * Every address here is from a documentation range, which is the house rule and
 * matters more than usual on this file: the whole point of the port is that an
 * address goes in and a hash comes out, so the tests have to be able to state an
 * address without one ever being a real one.
 */
describe('filing a report from outside the door (#1009)', () => {
  it('records the report and answers with its id', async () => {
    const desk = fakeArrivalDesk()
    const report = anArrivalReport()

    const result = await arrivalReports({ desk }).report({ ip: AN_ADDRESS, body: report })

    expect(result.outcome).toBe('recorded')
    if (result.outcome !== 'recorded') return
    expect(desk.filed()).toHaveLength(1)
    expect(desk.filed()[0]?.report).toEqual(report)
    expect(result.response.reportId).toBe(desk.filed()[0]?.id)
  })

  /**
   * The property the column depends on, asserted at the only place it can be:
   * the desk is handed a 64-character hash, and the address it was made from
   * appears nowhere in what was written.
   */
  it('writes a fingerprint and not the address it was made from', async () => {
    const desk = fakeArrivalDesk()

    await arrivalReports({ desk }).report({ ip: AN_ADDRESS, body: anArrivalReport() })

    const filed = desk.filed()[0]
    expect(filed?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(filed)).not.toContain(AN_ADDRESS)
  })

  it('gives two addresses two fingerprints, and one address one', async () => {
    const desk = fakeArrivalDesk()
    const port = arrivalReports({ desk })

    await port.report({ ip: AN_ADDRESS, body: anArrivalReport() })
    await port.report({ ip: ANOTHER_ADDRESS, body: anArrivalReport() })
    await port.report({ ip: AN_ADDRESS, body: anArrivalReport({ step: 'connecting' }) })

    const [first, second, third] = desk.filed()
    expect(first?.fingerprint).not.toBe(second?.fingerprint)
    expect(third?.fingerprint).toBe(first?.fingerprint)
  })

  it('refuses a report missing what a report is made of, and writes nothing', async () => {
    const desk = fakeArrivalDesk()

    const result = await arrivalReports({ desk }).report({
      ip: AN_ADDRESS,
      body: { runtime: 'openclaw' },
    })

    expect(result.outcome).toBe('invalid')
    if (result.outcome !== 'invalid') return
    expect(result.error.code).toBe('validation_failed')
    // Named individually, because a caller told only *that* the shape was wrong
    // is a caller guessing which of four fields it was.
    expect(Object.keys(result.error.details ?? {})).toEqual(
      expect.arrayContaining(['step', 'expected', 'actual']),
    )
    expect(desk.filed()).toHaveLength(0)
  })

  it('refuses a step the list has no word for', async () => {
    const desk = fakeArrivalDesk()

    const result = await arrivalReports({ desk }).report({
      ip: AN_ADDRESS,
      body: { ...anArrivalReport(), step: 'giving-up' },
    })

    // `elsewhere` is the answer for anything the list does not name, and it is
    // *in* the list — so a step outside it is a typo rather than a case the
    // enum failed to cover, and counting typos is what the enum exists to stop.
    expect(result.outcome).toBe('invalid')
    expect(desk.filed()).toHaveLength(0)
  })

  it('refuses the caller that has filed its allowance, with a time', async () => {
    const desk = fakeArrivalDesk()
    const port = arrivalReports({ desk })

    for (let filed = 0; filed < ARRIVAL_REPORT_LIMIT; filed += 1) {
      const allowed = await port.report({ ip: AN_ADDRESS, body: anArrivalReport() })
      expect(allowed.outcome).toBe('recorded')
    }

    const refused = await port.report({ ip: AN_ADDRESS, body: anArrivalReport() })

    expect(refused.outcome).toBe('rate-limited')
    if (refused.outcome !== 'rate-limited') return
    expect(refused.retryAfterSeconds).toBeGreaterThan(0)
    expect(desk.filed()).toHaveLength(ARRIVAL_REPORT_LIMIT)
  })

  it('charges the allowance per address, so one caller cannot spend another’s', async () => {
    const desk = fakeArrivalDesk()
    const port = arrivalReports({ desk })

    for (let filed = 0; filed < ARRIVAL_REPORT_LIMIT; filed += 1) {
      await port.report({ ip: AN_ADDRESS, body: anArrivalReport() })
    }

    const stranger = await port.report({ ip: ANOTHER_ADDRESS, body: anArrivalReport() })

    expect(stranger.outcome).toBe('recorded')
  })

  /**
   * The one place this port deliberately differs from registration (`#1009`).
   *
   * `REGISTRATION_LIMIT` charges a rejected attempt, because probing for free
   * names is the abuse there and a refusal is exactly what a prober wants back.
   * Here the caller getting the shape wrong is the caller the channel is *for* —
   * an agent that could not work out the door is unlikely to work out the report
   * first time — so a malformed body costs nothing.
   */
  it('does not charge the allowance for a report it refused as malformed', async () => {
    const desk = fakeArrivalDesk()
    const port = arrivalReports({ desk })

    for (let attempt = 0; attempt < ARRIVAL_REPORT_LIMIT * 3; attempt += 1) {
      const rejected = await port.report({ ip: AN_ADDRESS, body: { runtime: 'openclaw' } })
      expect(rejected.outcome).toBe('invalid')
    }

    const corrected = await port.report({ ip: AN_ADDRESS, body: anArrivalReport() })

    expect(corrected.outcome).toBe('recorded')
  })
})
