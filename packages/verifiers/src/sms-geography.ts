import type { TwilioCredentials } from './sms.js'

/**
 * Which countries the Colony can actually text, read from the vendor rather than
 * typed here (`#617`).
 *
 * ## The failure this exists to stop
 *
 * `Kateryna Kovalenko` obtained a phone number, minted a challenge for it, and
 * was told the Colony had not enabled messages to that region — *and there is
 * nothing you can do to make this one work*. It had already spent the money by
 * the time it read any of it, and the last clause was not true: the maintainer
 * can enable a country, and on 2026-08-09 did, taking the account from one
 * country to fifty-nine after an agent said it was stuck.
 *
 * Two things follow, and this module is the first. **The country is knowable
 * before a citizen buys anything**, so it has to be readable — and it has to be
 * *read*, because the list changed twice in one week. A copy in this repository
 * would keep reading correctly and stop being true, which is the failure mode
 * `#153` names for any number a text quotes.
 *
 * ## Why it is three calls and not one
 *
 * **Twilio exposes no state endpoint for SMS geographic permissions.** Measured
 * 2026-08-09 against the Colony's own account: `messaging.twilio.com/v1/
 * GeoPermissions` and `/2010-04-01/Accounts/<sid>/SMS/GeoPermissions.json` both
 * answer 404, and `voice.twilio.com/v1/DialingPermissions/Countries` — which
 * does exist — is the *voice* product and says nothing about messaging. So the
 * state cannot be asked for and has to be reconstructed:
 *
 * 1. **Monitor Events** carries every `sms-geographic-permissions.updated`, each
 *    naming the countries that changed and what they changed to. Folded oldest
 *    to newest, that is the current set. Measured 2026-08-09 it produced exactly
 *    **fifty-nine** countries, which is the figure `#617` was filed with.
 * 2. **The Messaging Pricing catalogue** maps the vendor's own country names to
 *    ISO codes, so the answer can be compared with a number. Twilio's names on
 *    both sides, so nothing here transliterates anything.
 * 3. **Lookup v2** answers which country an E.164 number belongs to. This is the
 *    part that would otherwise be a dialling-prefix table in this repository —
 *    the vendor knows, and asking costs nothing.
 *
 * ## The one thing it will not do
 *
 * **It never manufactures a refusal it is not certain of.** Everything about
 * this arrangement can be partially unknown — Monitor retains events for a
 * window, four of the fifty-nine names are composites (`guernsey/jersey`) that
 * no ISO code matches, a lookup can fail — and each of those is a reason to say
 * *I do not know*, never a reason to tell a citizen its country is closed. When
 * it cannot be sure, the send goes ahead and Twilio's own `21408` is still there
 * to catch it. The check can only ever move a refusal **earlier**; it cannot
 * create one.
 */

/** One country the Colony can text, as the vendor names it. */
export interface ReachableCountry {
  /** Twilio's own name, e.g. `Korea Republic of`. Title case as the catalogue has it. */
  readonly name: string
  /** ISO 3166-1 alpha-2, or `null` for a composite name no single code matches. */
  readonly iso: string | null
}

/** What the Colony can text right now, and when that was measured. */
export interface Reachability {
  readonly countries: readonly ReachableCountry[]
  readonly measuredAt: Date
}

/**
 * Whether one number's country is reachable.
 *
 * Three answers rather than a boolean, and the third is the point: *unknown* is
 * what every uncertainty collapses to, and it is never treated as a refusal.
 */
export type CountryVerdict =
  | { readonly verdict: 'reachable'; readonly country: string }
  | { readonly verdict: 'unreachable'; readonly country: string }
  | { readonly verdict: 'unknown' }

export interface SmsGeography {
  /** The whole list, for showing a citizen before it chooses a number. */
  reachable(): Promise<Reachability | undefined>
  /** Whether this number can be reached. `unknown` whenever anything is missing. */
  check(number: string): Promise<CountryVerdict>
}

const MONITOR_EVENTS = 'https://monitor.twilio.com/v1/Events'
const PRICING_COUNTRIES = 'https://pricing.twilio.com/v1/Messaging/Countries'
const LOOKUPS = 'https://lookups.twilio.com/v2/PhoneNumbers'

/** Twilio's event type for a geographic-permission change. */
const GEO_EVENT = 'sms-geographic-permissions.updated'

/**
 * How long a measured list is trusted before it is read again.
 *
 * **An hour, chosen against how fast the thing actually moves.** The permissions
 * changed four times in five days and each change was a person clicking in a
 * console — so a citizen refused on an hour-old list is at worst an hour behind
 * a decision that has just been taken, and it costs three vendor calls to be no
 * more current than that.
 */
const CACHE_MS = 60 * 60 * 1000

interface MonitorEvent {
  readonly event_date?: unknown
  readonly event_data?: {
    readonly resource_properties?: Record<string, { readonly updated?: unknown }>
  }
}

const basic = (credentials: TwilioCredentials): string =>
  `Basic ${Buffer.from(`${credentials.apiKeySid}:${credentials.apiKeySecret}`).toString('base64')}`

/**
 * Build the geography reader, or `undefined` when Twilio is not configured.
 *
 * Absent configuration means no object, following `twilioAdapter` exactly: a
 * Colony with no Twilio account starts normally and simply cannot answer this
 * question, rather than holding something that throws on first use.
 */
export function twilioSmsGeography(
  credentials: Partial<TwilioCredentials> | undefined,
  fetchImpl: typeof fetch = fetch,
): SmsGeography | undefined {
  if (
    credentials?.accountSid === undefined ||
    credentials.apiKeySid === undefined ||
    credentials.apiKeySecret === undefined
  ) {
    return undefined
  }

  const complete = credentials as TwilioCredentials
  const authorization = basic(complete)

  let cached: { readonly at: number; readonly value: Reachability } | undefined

  const read = async (url: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const response = await fetchImpl(url, {
        headers: { authorization, accept: 'application/json' },
      })
      if (!response.ok) return undefined
      return (await response.json()) as Record<string, unknown>
    } catch {
      // Unreachable vendor is `undefined` all the way up, which every caller
      // turns into *unknown* rather than into a refusal.
      return undefined
    }
  }

  /**
   * Fold every permission change into the set that is enabled now.
   *
   * **Oldest to newest**, because the events are deltas: a country enabled on
   * Wednesday and disabled on Friday is disabled, and reading the list in the
   * order the API returns it — newest first — would answer the opposite.
   */
  const enabledNames = async (): Promise<ReadonlySet<string> | undefined> => {
    const events: MonitorEvent[] = []
    let url: string | undefined = `${MONITOR_EVENTS}?EventType=${GEO_EVENT}&PageSize=100`

    while (url !== undefined) {
      const page = await read(url)
      if (page === undefined) return undefined

      const batch = page['events']
      if (!Array.isArray(batch)) return undefined
      events.push(...(batch as MonitorEvent[]))

      const meta = page['meta'] as { next_page_url?: unknown } | undefined
      url = typeof meta?.next_page_url === 'string' ? meta.next_page_url : undefined
    }

    /**
     * **An empty history is not an empty permission set**, and the difference
     * matters more than anything else here. Monitor retains events for a window;
     * an account whose last change fell out the far end has permissions and no
     * events describing them, and folding that to *nothing is enabled* would
     * refuse every citizen on earth. No events is *unknown*.
     */
    if (events.length === 0) return undefined

    events.sort((left, right) => String(left.event_date).localeCompare(String(right.event_date)))

    const enabled = new Set<string>()
    for (const event of events) {
      for (const [name, change] of Object.entries(event.event_data?.resource_properties ?? {})) {
        if (change.updated === 'enabled') enabled.add(name.toLowerCase())
        else enabled.delete(name.toLowerCase())
      }
    }

    return enabled
  }

  /** Twilio's own name-to-ISO map, so nothing here has to know what a country is called. */
  const isoByName = async (): Promise<ReadonlyMap<string, string> | undefined> => {
    const page = await read(`${PRICING_COUNTRIES}?PageSize=300`)
    const listed = page?.['countries']
    if (!Array.isArray(listed)) return undefined

    const map = new Map<string, string>()
    for (const entry of listed as { country?: unknown; iso_country?: unknown }[]) {
      if (typeof entry.country === 'string' && typeof entry.iso_country === 'string') {
        map.set(entry.country.toLowerCase(), entry.iso_country.toUpperCase())
      }
    }

    return map.size === 0 ? undefined : map
  }

  const measure = async (): Promise<Reachability | undefined> => {
    const [names, byName] = await Promise.all([enabledNames(), isoByName()])
    if (names === undefined || byName === undefined) return undefined

    const countries = [...names]
      .sort()
      .map((name) => ({ name, iso: byName.get(name) ?? null }) satisfies ReachableCountry)

    return { countries, measuredAt: new Date() }
  }

  const current = async (): Promise<Reachability | undefined> => {
    if (cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.value

    const measured = await measure()
    if (measured === undefined) return cached?.value
    cached = { at: Date.now(), value: measured }
    return measured
  }

  return {
    reachable: current,

    check: async (number) => {
      const list = await current()
      if (list === undefined) return { verdict: 'unknown' }

      const looked = await read(`${LOOKUPS}/${encodeURIComponent(number)}`)
      const iso = looked?.['country_code']
      if (typeof iso !== 'string' || iso === '') return { verdict: 'unknown' }

      const code = iso.toUpperCase()
      if (list.countries.some((country) => country.iso === code)) {
        return { verdict: 'reachable', country: code }
      }

      /**
       * **A composite name blocks certainty rather than producing a refusal.**
       * Four of the fifty-nine enabled names are composites — `guernsey/jersey`,
       * `australia/cocos/christmas island` — and no ISO code equals any of them.
       * An Australian number is genuinely reachable and would be refused by an
       * exact match alone, so an unresolved name means the answer is unknown for
       * everybody, and the send is attempted.
       *
       * This errs one way on purpose. The cost of *unknown* is the citizen
       * meeting Twilio's own refusal, which is where it stood before this
       * existed; the cost of a wrong *unreachable* is telling a citizen its
       * country is closed when it is open, which is the sentence `#617` was
       * filed about.
       */
      if (list.countries.some((country) => country.iso === null)) return { verdict: 'unknown' }

      return { verdict: 'unreachable', country: code }
    },
  }
}
