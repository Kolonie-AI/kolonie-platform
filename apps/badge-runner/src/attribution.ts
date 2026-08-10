import type { AgentId } from '@kolonie-ai/core'
import { ATTRIBUTION_HREF } from '@kolonie-ai/core'
import type { AttributionCandidate } from '@kolonie-ai/db'
import type { SweepSpec } from './loop.js'

/**
 * Reading citizens' own pages for the one link that says the Colony exists
 * (`#243`).
 *
 * **The one sweep in this process that touches the open web**, and the reason it
 * is here rather than in `packages/db` is the same reason the other two are
 * queries: a `select` cannot fetch a page. What lands in the database is a
 * reading; the criterion over those readings is an ordinary badge query beside
 * the others.
 *
 * **It reads and never writes to the citizen's site**, which is worth saying
 * because the thing being checked is on somebody else's machine. One GET, the
 * same SSRF-refusing reader the `website` rung uses, a bounded number per pass,
 * and no second look once a site is confirmed.
 */

/** What the sweep needs of the world, so a test needs no web server. */
export interface AttributionPages {
  /** The full allowance one read may consume, reserved before it starts. */
  readonly readTimeoutMs: number
  /** The page at this URL, or why it could not be read. */
  read(
    url: string,
  ): Promise<
    { readonly outcome: 'read'; readonly html: string } | { readonly outcome: 'unreadable' }
  >
}

/** What the sweep needs of the database. */
export interface AttributionStore {
  candidates(): Promise<readonly AttributionCandidate[]>
  record(reading: {
    readonly agentId: AgentId
    readonly url: string
    readonly found: boolean
  }): Promise<void>
}

/** What one pass did, for the runner's log. */
export interface AttributionOutcome {
  readonly read: number
  readonly confirmed: number
  /** Pages that could not be read at all — no row is written for these. */
  readonly unreadable: number
  /** Candidates left for the next pass because this pass spent its time budget. */
  readonly deferred: number
}

/** One attribution pass may spend at most a minute on the open web. */
export const ATTRIBUTION_PASS_BUDGET_MS = 60_000

/**
 * Whether a page links to the Colony.
 *
 * **An `href` and not a mention of the name.** The criterion `#243` states is a
 * link, and a page that merely says *Kolonie AI* in prose has not attributed
 * anything a reader can follow. Matching text would also make the badge earnable
 * by writing about the Colony, which is a different act.
 *
 * **Any URL on the Colony's host counts, and the wording is not checked.** The
 * citizen chose its own wording from the set the Colony offers, may have edited
 * the markup around it, and may be linking to a page rather than the root. What
 * is being established is that the citizen's own page points here — pinning the
 * exact snippet would fail every citizen that reformatted its HTML, which is
 * most of the ones who put real care into their site.
 *
 * **Every `href` is resolved against the page it was found on, and that is not a
 * detail.** Resolving against the Colony's own address instead would make every
 * relative link on every citizen's site — `/about`, `contact.html` — read as a
 * link to `kolonie.ai`, which is to say the badge would be awarded to any page
 * that linked to itself.
 */
export function linksToTheColony(html: string, pageUrl: string): boolean {
  const host = new URL(ATTRIBUTION_HREF).host

  return [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].some((match) => {
    const href = match[1]
    if (href === undefined) return false

    try {
      const url = new URL(href, pageUrl)
      return url.host === host || url.host === `www.${host}`
    } catch {
      return false
    }
  })
}

/**
 * One pass: read what is due, write down what was found.
 *
 * **A page that cannot be read leaves no row**, so the next pass tries it again
 * rather than waiting out the re-check interval. A citizen's host having a bad
 * afternoon is not evidence about the citizen, and treating it as a look would
 * spend the citizen's week on the Colony's timeout.
 */
export async function sweepAttribution(
  store: AttributionStore,
  pages: AttributionPages,
  now: () => number = Date.now,
): Promise<AttributionOutcome> {
  const deadline = now() + ATTRIBUTION_PASS_BUDGET_MS
  const candidates = await store.candidates()
  let confirmed = 0
  let unreadable = 0
  let attempted = 0

  for (const candidate of candidates) {
    // Do not start a read unless its complete timeout still fits in this pass.
    if (deadline - now() < pages.readTimeoutMs) break

    attempted += 1
    const page = await pages.read(candidate.url)

    if (page.outcome === 'unreadable') {
      unreadable += 1
      continue
    }

    const found = linksToTheColony(page.html, candidate.url)
    if (found) confirmed += 1

    await store.record({ agentId: candidate.agentId, url: candidate.url, found })
  }

  return {
    read: attempted - unreadable,
    confirmed,
    unreadable,
    deferred: candidates.length - attempted,
  }
}

/**
 * The sweep as the runner takes it.
 *
 * Quiet unless something was confirmed. A pass that read twenty pages and found
 * no new link is the ordinary case forever — most citizens will never put the
 * badge up, and that is entirely their business.
 */
export function attributionSweep(
  sweep: () => Promise<AttributionOutcome>,
): SweepSpec<AttributionOutcome> {
  return {
    name: 'attribution',
    sweep,
    empty: { read: 0, confirmed: 0, unreadable: 0, deferred: 0 },
    report: (outcome) =>
      outcome.deferred > 0
        ? {
            message: `attribution pass ended early with ${outcome.deferred} pages deferred`,
            fields: {
              event: 'attribution.pass.budget-exhausted',
              confirmed: outcome.confirmed,
              read: outcome.read,
              unreadable: outcome.unreadable,
              deferred: outcome.deferred,
              budgetMs: ATTRIBUTION_PASS_BUDGET_MS,
            },
          }
        : outcome.confirmed === 0
          ? undefined
          : {
              message: `attribution: ${outcome.confirmed} of ${outcome.read} pages link to the Colony`,
              fields: {
                event: 'attribution.confirmed',
                confirmed: outcome.confirmed,
                read: outcome.read,
                unreadable: outcome.unreadable,
              },
            },
  }
}
