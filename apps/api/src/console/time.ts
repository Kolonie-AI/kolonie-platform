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
 * Cloudflare's *Add visitor location headers* transform is enabled on the zone
 * and `cf-timezone` belongs to it. **Measured on 2026-08-06** by capturing the
 * plain-HTTP hop between Traefik and this container: the header arrives, and it
 * carries an IANA zone name. No script, no CSP change, no settings page.
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
  const header = headers['cf-timezone']
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
