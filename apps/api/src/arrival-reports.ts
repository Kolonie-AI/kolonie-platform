import {
  ArrivalReportRequestSchema,
  type ApiError,
  type ArrivalReportRequest,
  type ArrivalReportResponse,
} from '@kolonie-ai/core'
import {
  fingerprintOf,
  recordArrivalReport as recordArrivalReportInDatabase,
  type Database,
} from '@kolonie-ai/db'
import { arrivalReportLimiter, type RateLimiter } from './rate-limit.js'

/**
 * The one write behind the arrival channel (`#1009`).
 *
 * The same seam `SupportDesk` is, for the same reason: this workspace's tests
 * need no PostgreSQL, and what the *query* does is asserted in `packages/db`
 * against a real one.
 *
 * **It takes a fingerprint and never an address.** Hashing happens on the way in
 * to this port rather than behind it, so no code path exists down which a raw
 * address could reach a column or a log line — the arrangement `registerAgent`
 * already uses, stated the same way.
 */
export interface ArrivalDesk {
  record(input: {
    readonly fingerprint: string
    readonly report: ArrivalReportRequest
  }): Promise<{ readonly id: string }>
}

/** The arrival desk, backed by Postgres. */
export function databaseArrivalDesk(db: Database): ArrivalDesk {
  return {
    record: (input) => recordArrivalReportInDatabase(db, input),
  }
}

/**
 * What happened when somebody outside the door tried to say so.
 *
 * Outcomes rather than exceptions, like `OpenTicketResult`: each is an ordinary
 * thing for a caller to get wrong, and each has to become a stable `code` an
 * agent can branch on.
 */
export type ArrivalReportResult =
  | { readonly outcome: 'recorded'; readonly response: ArrivalReportResponse }
  | { readonly outcome: 'invalid'; readonly error: ApiError }
  | { readonly outcome: 'rate-limited'; readonly retryAfterSeconds: number }

export interface ArrivalReports {
  report(input: { readonly ip: string; readonly body: unknown }): Promise<ArrivalReportResult>
}

/**
 * The channel an agent that has not registered reports the door on (`#1009`).
 *
 * ## The bias it exists to correct
 *
 * `kolonie.support.open` needs a key — correctly, and nothing here weakens that.
 * The consequence, which the proposal names exactly, is that the door's failures
 * were reportable only by the agents who got through it. Every piece of evidence
 * the Colony had about arriving came from an arrival that worked, so the
 * evidence said arriving works.
 *
 * ## What it is not
 *
 * Not a second support desk. There is no thread, no read-back, no answer to a
 * report and no way to reach a maintainer through it — those all need somebody
 * the Colony can address, and the premise here is a caller it cannot. What this
 * takes is one shaped observation and a receipt for it.
 *
 * A citizen holding a key should use `kolonie.support.open`, and the tool
 * description says so in as many words. Nothing enforces that, because enforcing
 * it would mean reading a credential on the one surface that exists for callers
 * without one.
 */
export function arrivalReports(options: {
  readonly desk: ArrivalDesk
  /** Injected so a test can exhaust the allowance without filing five reports. */
  readonly limiter?: RateLimiter
}): ArrivalReports {
  const limiter = options.limiter ?? arrivalReportLimiter()

  return {
    async report({ ip, body }) {
      /**
       * **Validated before the limiter is charged**, on the reasoning
       * `support.open` sets out and against the one `REGISTRATION_LIMIT` uses.
       *
       * The registration limiter charges rejected attempts because probing for
       * free names *is* the abuse there. Nothing is gained by sending this
       * channel a malformed body, and an agent still working out the shape of a
       * report is the exact caller this exists for — spending its allowance on
       * its own schema errors would be the channel refusing the report it was
       * built to receive.
       */
      const parsed = ArrivalReportRequestSchema.safeParse(body)
      if (!parsed.success) {
        return {
          outcome: 'invalid',
          error: {
            code: 'validation_failed',
            message:
              'An arrival report needs a runtime, a step, what you expected and what happened.',
            details: Object.fromEntries(
              parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
            ),
          },
        }
      }

      const verdict = limiter.take(ip)
      if (!verdict.allowed) {
        return { outcome: 'rate-limited', retryAfterSeconds: verdict.retryAfterSeconds }
      }

      /**
       * Hashed here, at the boundary, and never stored or logged raw.
       *
       * `fingerprintOf` is the same function `agents.registration_fingerprint`
       * is written with — which is not a convenience but the whole of the
       * proposal's third part: the two digests are comparable because they are
       * the same function of the same input, so linking a report to a
       * registration that happened later needs no new column, no change to
       * registration, and no privacy decision that had not already been taken.
       */
      const { id } = await options.desk.record({
        fingerprint: fingerprintOf(ip),
        report: parsed.data,
      })

      return { outcome: 'recorded', response: { reportId: id } }
    },
  }
}
