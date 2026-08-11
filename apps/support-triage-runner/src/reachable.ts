/**
 * A `fetch` whose transport failures say what was being called (`#648`).
 *
 * ## What this is for
 *
 * On 2026-08-09 this runner logged `ticket.triage.failed` with
 * `TypeError: fetch failed` and nothing else. The ticket stayed in the queue,
 * which is correct — but the line named none of the four things this process
 * talks to, so *which* was unreachable was not answerable from the log at all.
 * The reading filed alongside it says so in as many words: **"The error does not
 * specify which URL was called."** A single occurrence is probably transient; a
 * transient failure you cannot attribute is one you cannot tell from a
 * misconfiguration.
 *
 * `transportReason` already unwrapped the cause chain, and exactly one of eight
 * outbound calls used it. This puts it under all of them instead, at the four
 * points where a `fetch` is chosen, so a call site added later inherits it
 * without having to remember.
 *
 * ## Why a name and not the URL
 *
 * `what` is a name — *GitHub*, *the model endpoint*, *the log store* — and never
 * the address. Loki's URL is configuration and a host of ours, which `AGENTS.md`
 * §9 keeps out of every file including a log line. The name answers the question
 * the log could not, and the address would answer it no better: there is one of
 * each.
 *
 * ## What it does not do
 *
 * **It does not retry and it does not swallow.** The queue is the retry — a
 * ticket that could not be triaged stays in it and is tried again on the next
 * poll — and a wrapper that decided otherwise would be a second retry policy
 * underneath the one that already works. This only replaces an anonymous
 * rejection with an attributable one.
 */

import { transportReason } from './github.js'

/** How a failure to reach one named service reads, once and in one place. */
export class Unreachable extends Error {
  constructor(
    readonly what: string,
    cause: unknown,
  ) {
    super(`${what} could not be reached: ${transportReason(cause)}`, { cause })
    this.name = 'Unreachable'
  }
}

/**
 * The same `fetch`, with a name attached to whatever it fails to reach.
 *
 * A response is passed through untouched, including a 4xx or a 5xx: an answer
 * that says no is an answer, and every caller here already reads `response.ok`
 * and says something better about it than this could.
 */
export function reachableFetch(what: string, doFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    try {
      return await doFetch(input, init)
    } catch (error) {
      throw new Unreachable(what, error)
    }
  }
}

/** The names, enumerated so two call sites cannot spell the same service differently. */
export const REACHES = {
  github: 'GitHub',
  model: 'the model endpoint',
  logs: 'the log store',
} as const
