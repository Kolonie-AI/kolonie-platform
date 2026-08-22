/**
 * Times a person reads, on a clock they recognise (`#461`).
 *
 * ## The defect this file exists for
 *
 * `day()` rendered `at.toISOString().slice(0, 16)`, which is UTC with the `Z`
 * sliced off. **The defect was never the offset — it was that the output said
 * nothing about which clock it was on.** `2026-08-06 10:56` looks like a local
 * time to every reader, and the page carried nothing to suggest otherwise. The
 * maintainer read `Last awake 10:56` at 12:56 in Berlin and reported it as a
 * wrong time, which is exactly the right reading of it.
 *
 * ## Why the zone comes from a header
 *
 * The usual fix reads the browser's zone, and that needs JavaScript.
 * `console/theme.ts` records that this app has none and that its CSP is
 * `default-src 'none'` — it gives up the website's self-hosted typeface rather
 * than weaken that, so reopening it for a clock would be the wrong trade.
 *
 * The zone therefore arrives as a request header. **Measured on 2026-08-06** by
 * capturing the plain-HTTP hop between Traefik and this container: it arrives and
 * carries an IANA zone name. No script, no CSP change, no settings page.
 *
 * ## Two headers, and the reason is `kolonie-docs#188`
 *
 * It came from Cloudflare's *Add visitor location headers* managed transform,
 * which is a single switch: turning it on for the timezone also sent latitude,
 * longitude, city, region and postal code to the origin on every request. The
 * Colony reads two of those ten and stores one, so the other eight were arriving
 * for nothing — one careless log line away from being kept, in a pipeline where
 * Promtail already ships every container's stdout to Loki.
 *
 * So the managed transform is off and a transform rule sets
 * **`x-kolonie-timezone`** instead, from `ip.src.timezone.name`. A `cf-`-prefixed
 * name was the obvious choice and Cloudflare refuses it: *"'set' is not a valid
 * value for operation because it cannot be used on header beginning with 'cf-'"*,
 * measured 2026-08-06.
 *
 * **`cf-timezone` is still read, second.** The edge change and this deploy cannot
 * land in the same instant, and a fallback that costs one property lookup is
 * cheaper than a window in which every console page renders in UTC. It is also
 * what makes the edge change revertible without a deploy behind it.
 *
 * ## The zone is read and never stored
 *
 * It is per-request input to rendering. `governance/privacy.md` §3 lists what is
 * held about a signed-in person — *"a coarse location"* — and an IANA zone is
 * finer than that. Rendering with it changes nothing about what is held; writing
 * it down would, and would need that document changed first.
 */

/** What a reader is shown when nothing better is known. Written out, never a bare number. */
export const FALLBACK_ZONE = 'UTC'

/**
 * The zone this request should be rendered in, or {@link FALLBACK_ZONE}.
 *
 * **Validated by asking `Intl` to use it**, rather than by a pattern. The set of
 * IANA zone names is data that changes without this file being edited, and a
 * regular expression that admits `Europe/Berlin` also admits `Europe/Berlyn` —
 * which would throw at the point of rendering, inside a page, on a request that
 * had nothing wrong with it. A constructor that either works or does not is the
 * whole check.
 */
export function zoneFrom(headers: Record<string, unknown>): string {
  // Ours first, Cloudflare's second — see the note above on why both are read.
  const header = headers['x-kolonie-timezone'] ?? headers['cf-timezone']
  if (typeof header !== 'string' || header === '') return FALLBACK_ZONE

  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: header })
    return header
  } catch {
    return FALLBACK_ZONE
  }
}

/** One minute, one hour, one day, in milliseconds — so the arithmetic below reads. */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * *2 hours ago*, *yesterday*, *in 10 minutes*.
 *
 * **For the timestamps whose question is "how long", not "when"** — an agent's
 * last awake, a session's last use. The zone question does not arise for these
 * at all, and a relative reading is the better answer regardless: nobody reads
 * *last awake 14:56* and thinks anything except *how long ago was that*.
 *
 * **Future times read forwards** rather than as a negative interval. A link code
 * that expires in ten minutes is the common case on the dashboard, and *in -1
 * hours* is the output that made this worth writing down.
 *
 * `Intl.RelativeTimeFormat` does the wording, so *1 day ago* is *yesterday* and
 * the plurals are not hand-rolled.
 */
export function relative(timestamp: string, now: Date = new Date()): string {
  const at = new Date(timestamp)
  if (Number.isNaN(at.getTime())) return timestamp

  const difference = at.getTime() - now.getTime()
  const magnitude = Math.abs(difference)
  const format = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' })

  if (magnitude < MINUTE) return 'just now'
  if (magnitude < HOUR) return format.format(Math.round(difference / MINUTE), 'minute')
  if (magnitude < DAY) return format.format(Math.round(difference / HOUR), 'hour')
  return format.format(Math.round(difference / DAY), 'day')
}

/**
 * *6 Aug 2026, 14:56 Europe/Berlin*.
 *
 * **For the timestamps a person acts on**, where *when* is the question: a link
 * code's expiry above all, which is the one where a two-hour misreading makes
 * somebody abandon a live code or trust a dead one.
 *
 * **The zone name is part of the output and not decoration.** Rendering the
 * right instant in the wrong-looking zone is a defect a reader can see and
 * correct for; rendering it with no zone at all is the defect they cannot.
 *
 * An unparseable timestamp is returned as it came, which is what `day()` did:
 * a page is not the place to discover that a column holds something unexpected.
 */
export function absolute(timestamp: string, zone: string): string {
  const at = new Date(timestamp)
  if (Number.isNaN(at.getTime())) return timestamp

  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at)

  return `${formatted} ${zone}`
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/**
 * A timestamp as a person reads one, without needing to know where they are
 * (`#399`, moved here by `#1634`).
 *
 * **A day and not a moment.** `#399`'s argument, unchanged: nothing the operator
 * page says is improved by a time of day, and `2026-08-05T13:18:12.441Z` in
 * front of somebody who has never heard of the Colony reads as a machine talking
 * to itself.
 *
 * **Why not {@link absolute}.** That one is better and needs a zone, which comes
 * from a signed-in request's headers. The operator page is reached by a mailed
 * link by a person with no session, so there is no zone to give it — and a
 * silently-assumed one would be worse than a day, because it would be confidently
 * wrong by up to a day rather than honestly coarse.
 *
 * Hand-formatted rather than through `Intl`, because the output of these pages is
 * asserted in tests and a locale database that differs between this machine and
 * the deploy host is a difference nobody would look for.
 */
export function asDay(timestamp: string): string {
  const at = new Date(timestamp)
  if (Number.isNaN(at.getTime())) return timestamp

  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`
}
