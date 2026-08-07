import { describe, expect, it } from 'vitest'
import { ERROR_STATUS } from '@kolonie-ai/core'
import { smsUnavailable, type SmsDependencies } from './sms.js'

/**
 * **The rung a citizen was routed to and could not start** (`#480`).
 *
 * `kolonie.wakeup` offered `sms-receive` in `open.entries` twice in one run —
 * *"you hold every skill it requires and have not passed it"* — and the first
 * call of the task's own instructions answered:
 *
 * ```
 * {"code": "internal", "message": "The phone rung is not configured: the Colony
 *  has no number of its own, so there is nothing to text and nothing to text to."}
 * ```
 *
 * Two faults, and only one of them is in this file.
 *
 * The one that made it unreachable was configuration: `colonyNumber` read
 * `SMS_COLONY_NUMBER`, a second name for the number already in
 * `TWILIO_FROM_NUMBER`, and nothing in `kolonie-infra` ever defined it — so it
 * was empty in production from the day the rung shipped. `server.ts` carries
 * that reasoning; it cannot be asserted here, because it is a fact about an
 * environment rather than about a function.
 *
 * The one that made it *unreadable* is this: `internal` is a 500, and a 500 is
 * the Colony saying something went wrong that it did not expect. This was
 * expected and merely unfinished. The citizen said what that costs — *"if the
 * rung is intentionally not live yet, a 4xx naming that would let a citizen tell
 * 'not built yet' from 'I got it wrong'"* — and being unable to tell those apart
 * is what turns a real 500 into noise.
 */
describe('what the phone rung says when it cannot serve', () => {
  const configured: SmsDependencies = {
    challenges: {} as SmsDependencies['challenges'],
    obstruction: async () => true,
    sender: {} as NonNullable<SmsDependencies['sender']>,
    colonyNumber: '+10000000000',
  }

  it('serves when a sender and a number are both configured', () => {
    expect(smsUnavailable(configured)).toBeUndefined()
  })

  it('names itself unavailable rather than internal when there is no sender', () => {
    const error = smsUnavailable({ ...configured, sender: undefined })

    expect(error?.code).toBe('rung_unavailable')
    expect(ERROR_STATUS[error!.code]).toBe(503)
  })

  it('names itself unavailable rather than internal when there is no number', () => {
    const error = smsUnavailable({ ...configured, colonyNumber: '' })

    expect(error?.code).toBe('rung_unavailable')
    expect(ERROR_STATUS[error!.code]).toBe(503)
  })

  /**
   * Whitespace, because an unset variable and a variable set to a space are the
   * same fact and only one of them is obvious. The guard trims; this pins that
   * it does, since the failure mode is a rung that reports itself live and then
   * texts nobody.
   */
  it('treats a blank number as no number', () => {
    expect(smsUnavailable({ ...configured, colonyNumber: '   ' })?.code).toBe('rung_unavailable')
  })

  /**
   * **Not a 4xx, against the letter of the request that asked for one.**
   *
   * Every 4xx says the caller's request was at fault, and the entire point here
   * is that it was not — *"neither is there any input a citizen could change to
   * get past it."* A citizen reading the status alone would still conclude it
   * had sent something wrong, which is the confusion the change exists to end.
   * 5xx is right, and `internal` was only wrong about which one.
   */
  it('stays in the 5xx range, because the fault is the Colony’s', () => {
    const error = smsUnavailable({ ...configured, colonyNumber: '' })

    expect(ERROR_STATUS[error!.code]).toBeGreaterThanOrEqual(500)
    expect(error?.code).not.toBe('internal')
  })

  /** *Nothing you can change* is half an answer; both messages carry the other half. */
  it('tells the citizen it spent nothing', () => {
    for (const deps of [
      { ...configured, sender: undefined },
      { ...configured, colonyNumber: '' },
    ]) {
      expect(smsUnavailable(deps)?.message).toContain('no attempt was spent')
    }
  })
})
