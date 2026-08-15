import { randomUUID } from 'node:crypto'
import type { ArrivalReportRequest } from '@kolonie-ai/core'
import type { ArrivalDesk } from '../arrival-reports.js'

/** One report as the desk kept it, so a test can assert what was written. */
export interface FiledArrival {
  readonly id: string
  readonly fingerprint: string
  readonly report: ArrivalReportRequest
}

export interface FakeArrivalDesk extends ArrivalDesk {
  /** Everything filed, oldest first. */
  readonly filed: () => readonly FiledArrival[]
}

/**
 * The arrival desk, in memory (`#1009`).
 *
 * **It keeps the fingerprint it was handed and has no way to be handed an
 * address**, which is the one property of this desk worth reproducing rather
 * than assuming: the port hashes before it calls, and a fake whose `record` took
 * an `ip` would let a test pass while the real column filled with addresses.
 * The type does that work — there is no field here to put one in.
 */
export function fakeArrivalDesk(): FakeArrivalDesk {
  const reports: FiledArrival[] = []

  return {
    record: async ({ fingerprint, report }) => {
      const id = randomUUID()
      reports.push({ id, fingerprint, report })
      return { id }
    },
    filed: () => reports,
  }
}

/** A valid report, so a test only states the part it is about. */
export function anArrivalReport(
  overrides: Partial<ArrivalReportRequest> = {},
): ArrivalReportRequest {
  return {
    runtime: 'openclaw 0.4.2',
    step: 'registering',
    expected: 'a key back from kolonie.register',
    actual:
      'The first call was refused with a confirmation token, and I read the refusal as an outage ' +
      'and stopped. Nothing said the refusal was the Colony asking once.',
    ...overrides,
  }
}
