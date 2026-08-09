import { describe, expect, it } from 'vitest'
import { twilioSmsGeography } from './sms-geography.js'
import type { TwilioCredentials } from './sms.js'

const CREDENTIALS: TwilioCredentials = {
  accountSid: 'AC00000000000000000000000000000001',
  apiKeySid: 'SK00000000000000000000000000000001',
  apiKeySecret: 'not-a-real-secret',
  fromNumber: '+17089601498',
}

interface Canned {
  /** Newest first, exactly as Twilio's Monitor returns them. */
  readonly events?: { event_date: string; countries: Record<string, string> }[]
  readonly pricing?: { country: string; iso_country: string }[]
  readonly lookup?: Record<string, string>
  /** Answer this url with a failure, whatever else is set. */
  readonly failing?: (url: string) => boolean
}

/**
 * A `fetch` that speaks the three Twilio surfaces this reads, and records what
 * was asked.
 *
 * The shapes are the ones measured against the Colony's own account on
 * 2026-08-09 rather than invented: an event carries `event_data.
 * resource_properties` keyed by a lowercase country name, and the pricing
 * catalogue carries the same names in title case beside their ISO codes.
 */
const twilio = (canned: Canned): { fetch: typeof fetch; asked: string[] } => {
  const asked: string[] = []

  const impl = (async (input: string | URL | Request) => {
    const url = String(input)
    asked.push(url)

    if (canned.failing?.(url) === true) {
      return new Response('nope', { status: 500 })
    }

    if (url.startsWith('https://monitor.twilio.com')) {
      return Response.json({
        events: (canned.events ?? []).map((event) => ({
          event_date: event.event_date,
          event_data: {
            resource_properties: Object.fromEntries(
              Object.entries(event.countries).map(([name, updated]) => [name, { updated }]),
            ),
          },
        })),
        meta: { next_page_url: null },
      })
    }

    if (url.startsWith('https://pricing.twilio.com')) {
      return Response.json({ countries: canned.pricing ?? [] })
    }

    const number = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))
    const iso = canned.lookup?.[number]
    return iso === undefined
      ? new Response('not found', { status: 404 })
      : Response.json({ phone_number: number, country_code: iso })
  }) as unknown as typeof fetch

  return { fetch: impl, asked }
}

const PRICING = [
  { country: 'Germany', iso_country: 'DE' },
  { country: 'Nigeria', iso_country: 'NG' },
  { country: 'Australia', iso_country: 'AU' },
]

describe('twilioSmsGeography', () => {
  it('is not constructed at all without credentials', () => {
    expect(twilioSmsGeography(undefined)).toBeUndefined()
    expect(twilioSmsGeography({ accountSid: 'AC1' })).toBeUndefined()
  })

  /**
   * The events are deltas and the API returns them newest first. Folding them in
   * the order they arrive answers the opposite of the truth for any country that
   * was enabled and then disabled — which has happened on this account.
   */
  it('folds the permission events oldest to newest', async () => {
    const geography = twilioSmsGeography(
      CREDENTIALS,
      twilio({
        events: [
          { event_date: '2026-08-09T00:51:33Z', countries: { nigeria: 'disabled' } },
          {
            event_date: '2026-08-05T15:40:21Z',
            countries: { germany: 'enabled', nigeria: 'enabled' },
          },
        ],
        pricing: PRICING,
      }).fetch,
    )

    const list = await geography?.reachable()

    expect(list?.countries).toEqual([{ name: 'germany', iso: 'DE' }])
  })

  it('answers reachable for a number whose country is enabled', async () => {
    const geography = twilioSmsGeography(
      CREDENTIALS,
      twilio({
        events: [{ event_date: '2026-08-05T15:40:21Z', countries: { germany: 'enabled' } }],
        pricing: PRICING,
        lookup: { '+4915100000000': 'DE' },
      }).fetch,
    )

    expect(await geography?.check('+4915100000000')).toEqual({
      verdict: 'reachable',
      country: 'DE',
    })
  })

  it('answers unreachable for a number whose country is not', async () => {
    const geography = twilioSmsGeography(
      CREDENTIALS,
      twilio({
        events: [{ event_date: '2026-08-05T15:40:21Z', countries: { germany: 'enabled' } }],
        pricing: PRICING,
        lookup: { '+2348000000000': 'NG' },
      }).fetch,
    )

    expect(await geography?.check('+2348000000000')).toEqual({
      verdict: 'unreachable',
      country: 'NG',
    })
  })

  /**
   * The first rejection case. Four of the fifty-nine enabled names are
   * composites — `australia/cocos/christmas island`, `guernsey/jersey` — that no
   * ISO code equals. An Australian number is genuinely reachable, and an exact
   * match alone would refuse it.
   */
  it('says unknown rather than unreachable while a composite name is in the list', async () => {
    const geography = twilioSmsGeography(
      CREDENTIALS,
      twilio({
        events: [
          {
            event_date: '2026-08-05T15:40:21Z',
            countries: { germany: 'enabled', 'australia/cocos/christmas island': 'enabled' },
          },
        ],
        pricing: PRICING,
        lookup: { '+61400000000': 'AU' },
      }).fetch,
    )

    expect(await geography?.check('+61400000000')).toEqual({ verdict: 'unknown' })
  })

  /**
   * The second rejection case, and the one that would be dangerous silently.
   * Monitor retains events for a window, so an account whose last change fell out
   * the far end has permissions and no events describing them. Folding that to
   * *nothing is enabled* would refuse every citizen on earth.
   */
  it('says unknown when the vendor has no history to fold', async () => {
    const geography = twilioSmsGeography(
      CREDENTIALS,
      twilio({ events: [], pricing: PRICING, lookup: { '+4915100000000': 'DE' } }).fetch,
    )

    expect(await geography?.reachable()).toBeUndefined()
    expect(await geography?.check('+4915100000000')).toEqual({ verdict: 'unknown' })
  })

  it('says unknown when the lookup cannot name the country', async () => {
    const geography = twilioSmsGeography(
      CREDENTIALS,
      twilio({
        events: [{ event_date: '2026-08-05T15:40:21Z', countries: { germany: 'enabled' } }],
        pricing: PRICING,
      }).fetch,
    )

    expect(await geography?.check('+9999999999')).toEqual({ verdict: 'unknown' })
  })

  it('says unknown when the vendor cannot be reached at all', async () => {
    const geography = twilioSmsGeography(CREDENTIALS, twilio({ failing: () => true }).fetch)

    expect(await geography?.check('+4915100000000')).toEqual({ verdict: 'unknown' })
  })

  /** Read once an hour, not once a call: a challenge mint must not cost three round trips. */
  it('reads the list once and answers from it', async () => {
    const asking = twilio({
      events: [{ event_date: '2026-08-05T15:40:21Z', countries: { germany: 'enabled' } }],
      pricing: PRICING,
      lookup: { '+4915100000000': 'DE' },
    })
    const geography = twilioSmsGeography(CREDENTIALS, asking.fetch)

    await geography?.check('+4915100000000')
    await geography?.check('+4915100000000')

    expect(asking.asked.filter((url) => url.startsWith('https://monitor'))).toHaveLength(1)
    // The lookup is per number and is not cached: two citizens are two numbers.
    expect(asking.asked.filter((url) => url.startsWith('https://lookups'))).toHaveLength(2)
  })
})
