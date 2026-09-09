import { byRoute, confidenceOf, totals, windowOf } from '../arithmetic.js'
import type { Finding } from '../finding.js'
import type { DoctorInput } from '../input.js'
import { CONFIDENCE_FULL_BUCKETS, UNREADABLE_RESPONSE_BYTES } from '../thresholds.js'

/**
 * The narrower call, for the routes that have one (`#884`).
 *
 * **The relation is *returns one of what the other returns all of*, and nothing
 * looser.** A map of vaguely related routes would be worse than no map: a finding
 * that points somewhere unhelpful teaches a citizen to stop reading the pointer,
 * and then the pointer is gone for the cases where it was right.
 *
 * **Short on purpose, and a route missing from it is the ordinary case.** Where
 * there is no narrower route, `narrow-the-request` still says what to do — bound
 * this same call's own arguments — and the finding carries one route key instead
 * of two. Both HTTP and MCP spellings are here because the rollup records
 * whichever the citizen actually called.
 *
 * `kolonie.tasks.frontier` is the measured case: the 128,058-byte response of
 * 2026-08-13 that the calling client refused.
 */
export const NARROWER_CALL_FOR: Readonly<Record<string, string>> = {
  'kolonie.tasks.frontier': 'kolonie.tasks.get',
  'kolonie.tasks.list': 'kolonie.tasks.get',
  '/v1/tasks/frontier': '/v1/tasks/:taskId',
  '/v1/tasks': '/v1/tasks/:taskId',
}

/**
 * The routes that already take a bounded page, and can say so (`#1886`).
 *
 * **A route here is one whose *own* arguments answer the finding.** The generic
 * advice beside `narrow-the-request` — *bound what you ask that call for* — is
 * true and unactionable where a caller cannot see which argument would do it:
 * `kolonie.messages.get_thread` returned a 59-message thread of roughly
 * 125.8 KiB while the Doctor recommended a smaller page and the tool published
 * no argument for one, which is what `#1886` reports. Naming the arguments is
 * the difference between advice and an instruction.
 *
 * Short for {@link NARROWER_CALL_FOR}'s reason: a route missing from it gets the
 * generic sentence, which is still correct.
 */
export const PAGE_ARGUMENTS_FOR: Readonly<Record<string, readonly string[]>> = {
  'kolonie.messages.get_thread': ['limit', 'cursor'],
}

/**
 * One response large enough that the caller may not have been able to take it
 * (`#884`).
 *
 * **The blind spot this closes was measured rather than imagined.** On
 * 2026-08-13 a single `kolonie.tasks.frontier` call returned 128,058 bytes and
 * was rejected by the calling client; `kolonie.doctor` over the same window
 * returned nothing at all, while its own busiest-routes list showed that one call
 * as 76% of everything the citizen moved. Every existing byte rule was correct to
 * stay quiet — and the citizen still could not read its answer.
 *
 * **It is a rule of its own rather than a branch on `oversized-reads`**, for the
 * reason that decides most of this file's shape: those thresholds measure what
 * the *Colony* pays and rightly want a habit before they say anything, and this
 * one measures what the *citizen* pays, which is spent the first time. The two
 * may fire together for one route, and a route with a large mean *and* one
 * unreadable response genuinely has both problems.
 *
 * **No minimum call count, and that is the rule rather than an omission.** One
 * response is the whole of the evidence, because one response is the whole of the
 * failure.
 *
 * ### What it costs when it is wrong
 *
 * A false positive tells a citizen that a response it read comfortably was large
 * — cheap, and visible as wrong the moment it reads the byte figure beside it.
 * The expensive direction is silence, which is what was there before: a citizen
 * whose call cannot answer it, and a Doctor that says nothing is the matter.
 *
 * It under-reports for one reason, and not one this rule can fix: a streamed
 * response carries no `content-length` when the rollup is written and is recorded
 * as zero — `bytesOf` in `apps/api/src/call-rollup.ts` has the whole of it.
 */
export function unreadableResponse(input: DoctorInput): readonly Finding[] {
  const findings: Finding[] = []

  for (const route of byRoute(input.hours)) {
    const summed = totals(route.hours)
    if (summed.maxBytesOut < UNREADABLE_RESPONSE_BYTES) continue

    const window = windowOf(route.hours)
    const narrower = NARROWER_CALL_FOR[route.routeKey]
    const pageArguments = PAGE_ARGUMENTS_FOR[route.routeKey]

    findings.push({
      kind: 'unreadable-response',
      // Serious without a scale: a response the caller could not take is not a
      // shape that may become a problem later, it is one that already stopped
      // the citizen once.
      severity: 'serious',
      scope: 'agent',
      subject: input.subject,
      evidence: {
        // The route, then what to call instead where such a call exists. Same
        // order and same sentence as `deprecated-route`, so a reader that has
        // learned one has learned both.
        routeKeys: narrower === undefined ? [route.routeKey] : [route.routeKey, narrower],
        figures: {
          hours: route.hours.length,
          calls: summed.calls,
          bytesOut: summed.bytesOut,
          maxBytesOut: summed.maxBytesOut,
          /**
           * Whether this route's own arguments bound it (`#1886`).
           *
           * A figure rather than a route key, because it is a property of the
           * route already named rather than a second route — and `Evidence`
           * carries numbers and route keys and nothing else, which is what
           * keeps a stored finding free of prose nobody checked.
           */
          ...(pageArguments === undefined ? {} : { supportsPageArguments: 1 }),
        },
      },
      // Full agreement by construction, and passed explicitly rather than left to
      // the hour count. The agreement term asks *does this pattern hold across
      // buckets*, and this finding is not a pattern: the one measured response is
      // complete evidence of itself, so the only thing left to be less than sure
      // about is how far past the threshold it was.
      confidence: confidenceOf(
        summed.maxBytesOut,
        UNREADABLE_RESPONSE_BYTES,
        CONFIDENCE_FULL_BUCKETS,
      ),
      recommendation: 'narrow-the-request',
      // Nothing here is rate-shaped. Calling the same thing later returns the
      // same response, and a retry time would be advice about the wrong axis.
      retryAfterSeconds: null,
      since: window.since,
      until: window.until,
    })
  }

  return findings
}
