import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SMS_LIMITS,
  destinationFor,
  guardedSmsSender,
  twilioAdapter,
  type SmsAdapter,
  type SmsSendRecord,
  type SmsSendResult,
  type SmsSpendLedger,
  type TwilioCredentials,
} from './sms.js'
import type { CountryVerdict, SmsGeography } from './sms-geography.js'

const CREDENTIALS: TwilioCredentials = {
  accountSid: 'AC00000000000000000000000000000001',
  apiKeySid: 'SK00000000000000000000000000000001',
  apiKeySecret: 'not-a-real-secret',
  fromNumber: '+17089601498',
}

const AGENT = '11111111-1111-4111-8111-111111111111'
const GERMAN_MOBILE = '+4915100000000'

/** A `fetch` that answers one canned body and records how it was called. */
const answering = (
  status: number,
  payload: unknown,
): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } => {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as unknown as Response
  }) as unknown as typeof fetch

  return { fetch: impl, calls }
}

const notJson = (status: number): typeof fetch =>
  (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        throw new Error('Unexpected token < in JSON')
      },
    }) as unknown as Response) as unknown as typeof fetch

const throwing = (message: string): typeof fetch =>
  (async () => {
    throw new Error(message)
  }) as unknown as typeof fetch

const sentMessage = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sid: 'SM00000000000000000000000000000001',
  from: CREDENTIALS.fromNumber,
  to: GERMAN_MOBILE,
  body: 'Your code is 123456',
  date_created: '2026-08-05T09:00:00Z',
  price: '-0.11200',
  price_unit: 'USD',
  ...over,
})

/** A ledger that answers fixed counts and remembers what it was told. */
const ledgerWith = (
  counts: { citizen?: number; total?: number; country?: number } = {},
): { ledger: SmsSpendLedger; written: SmsSendRecord[] } => {
  const written: SmsSendRecord[] = []
  return {
    written,
    ledger: {
      sentToCitizen: async () => counts.citizen ?? 0,
      sentInTotal: async () => counts.total ?? 0,
      sentToCountry: async () => counts.country ?? 0,
      record: async (entry) => {
        written.push(entry)
      },
    },
  }
}

const adapterAnswering = (result: SmsSendResult): { adapter: SmsAdapter; sends: string[] } => {
  const sends: string[] = []
  return {
    sends,
    adapter: {
      send: async (to) => {
        sends.push(to)
        return result
      },
      received: async () => ({ outcome: 'ok', messages: [] }),
    },
  }
}

const SENT: SmsSendResult = {
  outcome: 'sent',
  vendorId: 'SM00000000000000000000000000000001',
  price: { amount: '0.11200', currency: 'USD' },
}

describe('twilioAdapter — construction', () => {
  it('is not constructed when the configuration is absent', () => {
    expect(twilioAdapter(undefined)).toBeUndefined()
    expect(twilioAdapter({})).toBeUndefined()
  })

  it('is not constructed when one value is missing or blank', () => {
    expect(twilioAdapter({ ...CREDENTIALS, apiKeySecret: '' })).toBeUndefined()
    expect(twilioAdapter({ ...CREDENTIALS, fromNumber: '   ' })).toBeUndefined()
  })

  it('is constructed when all four are present', () => {
    expect(twilioAdapter(CREDENTIALS, answering(200, {}).fetch)).toBeDefined()
  })
})

describe('twilioAdapter — sending', () => {
  it('authenticates with the API key and never with an Auth Token', async () => {
    const { fetch, calls } = answering(201, sentMessage())
    await twilioAdapter(CREDENTIALS, fetch)?.send(GERMAN_MOBILE, 'Your code is 123456')

    const header = (calls[0]?.init?.headers as Record<string, string>).authorization ?? ''
    const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString()
    expect(decoded).toBe(`${CREDENTIALS.apiKeySid}:${CREDENTIALS.apiKeySecret}`)
    expect(decoded.startsWith('AC')).toBe(false)
  })

  it('sends from the Colony’s own number', async () => {
    const { fetch, calls } = answering(201, sentMessage())
    await twilioAdapter(CREDENTIALS, fetch)?.send(GERMAN_MOBILE, 'Your code is 123456')

    const body = new URLSearchParams(String(calls[0]?.init?.body))
    expect(body.get('From')).toBe(CREDENTIALS.fromNumber)
    expect(body.get('To')).toBe(GERMAN_MOBILE)
  })

  it('carries the price back, unsigned', async () => {
    const { fetch } = answering(201, sentMessage())
    const result = await twilioAdapter(CREDENTIALS, fetch)?.send(GERMAN_MOBILE, 'code')

    expect(result).toEqual({
      outcome: 'sent',
      vendorId: 'SM00000000000000000000000000000001',
      price: { amount: '0.11200', currency: 'USD' },
    })
  })

  it('reports an unpriced send as not yet priced rather than as free', async () => {
    const { fetch } = answering(201, sentMessage({ price: null, price_unit: null }))
    const result = await twilioAdapter(CREDENTIALS, fetch)?.send(GERMAN_MOBILE, 'code')

    expect(result).toMatchObject({ outcome: 'sent', price: null })
  })

  it('names the Colony when the region is not enabled — Twilio 21408', async () => {
    const { fetch } = answering(400, {
      code: 21408,
      message: 'Permission to send an SMS has not been enabled for the region',
    })
    const result = await twilioAdapter(CREDENTIALS, fetch)?.send('+5511900000000', 'code')

    expect(result?.outcome).toBe('refused')
    expect(result?.outcome === 'refused' && result.reason).toContain('Colony')
    expect(result?.outcome === 'refused' && result.reason).not.toContain('your number is')
  })

  it('treats an unreachable vendor as the Colony’s problem', async () => {
    const result = await twilioAdapter(CREDENTIALS, throwing('ECONNRESET'))?.send(
      GERMAN_MOBILE,
      'code',
    )

    expect(result?.outcome).toBe('unavailable')
    expect(result?.outcome === 'unavailable' && result.reason).toContain('ECONNRESET')
  })

  it('treats a 200 with no identifier as unavailable rather than as sent', async () => {
    const { fetch } = answering(201, sentMessage({ sid: undefined }))
    const result = await twilioAdapter(CREDENTIALS, fetch)?.send(GERMAN_MOBILE, 'code')

    expect(result?.outcome).toBe('unavailable')
  })

  it('treats a body that is not JSON as unavailable', async () => {
    const result = await twilioAdapter(CREDENTIALS, notJson(500))?.send(GERMAN_MOBILE, 'code')

    expect(result?.outcome).toBe('unavailable')
  })
})

describe('twilioAdapter — receiving', () => {
  it('reads the sending number off the vendor’s answer and not off any argument', async () => {
    const network = '+4917600000000'
    const { fetch } = answering(200, {
      messages: [sentMessage({ from: network, to: CREDENTIALS.fromNumber, body: 'KOL-4821' })],
    })

    const result = await twilioAdapter(CREDENTIALS, fetch)?.received(
      new Date('2026-08-05T00:00:00Z'),
    )

    expect(result?.outcome).toBe('ok')
    expect(result?.outcome === 'ok' && result.messages[0]?.from).toBe(network)
    // Nothing the caller passed appears in the certified field. `received` takes
    // only a date, so the sending number cannot have come from anywhere else —
    // this is the D-018 property as a test rather than as a comment.
    expect(result?.outcome === 'ok' && result.messages[0]?.to).toBe(CREDENTIALS.fromNumber)
  })

  it('asks only for messages addressed to the Colony’s number', async () => {
    const { fetch, calls } = answering(200, { messages: [] })
    await twilioAdapter(CREDENTIALS, fetch)?.received(new Date('2026-08-05T14:02:00Z'))

    expect(calls[0]?.url).toContain(`To=${encodeURIComponent(CREDENTIALS.fromNumber)}`)
  })

  it('is unavailable — never an empty list — when the answer has no messages array', async () => {
    const { fetch } = answering(200, { ok: true })
    const result = await twilioAdapter(CREDENTIALS, fetch)?.received(new Date())

    expect(result?.outcome).toBe('unavailable')
  })

  it('is unavailable when one listed message cannot be read', async () => {
    const { fetch } = answering(200, {
      messages: [sentMessage(), sentMessage({ from: undefined })],
    })
    const result = await twilioAdapter(CREDENTIALS, fetch)?.received(new Date())

    expect(result?.outcome).toBe('unavailable')
  })

  it('is unavailable when a message carries no usable date', async () => {
    const { fetch } = answering(200, {
      messages: [sentMessage({ date_sent: 'not a date', date_created: undefined })],
    })
    const result = await twilioAdapter(CREDENTIALS, fetch)?.received(new Date())

    expect(result?.outcome).toBe('unavailable')
  })

  it('answers an empty list when nothing arrived', async () => {
    const { fetch } = answering(200, { messages: [] })
    const result = await twilioAdapter(CREDENTIALS, fetch)?.received(new Date())

    expect(result).toEqual({ outcome: 'ok', messages: [] })
  })
})

describe('destinationFor', () => {
  it('matches the longest prefix, so a narrower entry wins over +1', () => {
    const allowed = [
      { country: 'US', prefix: '+1' },
      { country: 'CA-ON', prefix: '+1416' },
    ]
    expect(destinationFor('+14165550100', allowed)?.country).toBe('CA-ON')
    expect(destinationFor('+12025550100', allowed)?.country).toBe('US')
  })

  it('answers nothing for a destination on no list', () => {
    expect(destinationFor('+5511900000000', DEFAULT_SMS_LIMITS.allowedPrefixes)).toBeUndefined()
  })
})

describe('guardedSmsSender', () => {
  it('sends, and records the send with its price', async () => {
    const { adapter, sends } = adapterAnswering(SENT)
    const { ledger, written } = ledgerWith()

    const result = await guardedSmsSender({ adapter, ledger }).send(AGENT, GERMAN_MOBILE, 'code')

    expect(result).toEqual(SENT)
    expect(sends).toEqual([GERMAN_MOBILE])
    expect(written).toEqual([
      {
        agentId: AGENT,
        to: GERMAN_MOBILE,
        vendorId: SENT.vendorId,
        price: { amount: '0.11200', currency: 'USD' },
        // No geography configured here, so nothing named the country (`#616`).
        country: null,
        sentAt: expect.any(Date),
      },
    ])
  })

  it('refuses a destination off the allowlist before the request is made', async () => {
    const { adapter, sends } = adapterAnswering(SENT)
    const { ledger, written } = ledgerWith()

    const result = await guardedSmsSender({ adapter, ledger }).send(AGENT, '+5511900000000', 'code')

    expect(result.outcome).toBe('refused')
    expect(result.outcome === 'refused' && result.reason).toContain('DE (+49)')
    expect(sends).toEqual([])
    expect(written).toEqual([])
  })

  it('refuses a citizen over its own limit before the request is made', async () => {
    const { adapter, sends } = adapterAnswering(SENT)
    const { ledger } = ledgerWith({ citizen: DEFAULT_SMS_LIMITS.perCitizen })

    const result = await guardedSmsSender({ adapter, ledger }).send(AGENT, GERMAN_MOBILE, 'code')

    expect(result.outcome).toBe('refused')
    expect(sends).toEqual([])
  })

  it('refuses when the global daily cap is reached, and says it is the Colony’s ceiling', async () => {
    const { adapter, sends } = adapterAnswering(SENT)
    const { ledger } = ledgerWith({ total: DEFAULT_SMS_LIMITS.globalPerWindow })

    const result = await guardedSmsSender({ adapter, ledger }).send(AGENT, GERMAN_MOBILE, 'code')

    expect(result.outcome).toBe('refused')
    expect(result.outcome === 'refused' && result.reason).toContain('Colony')
    expect(sends).toEqual([])
  })

  it('counts both caps over the configured window', async () => {
    const asked: Date[] = []
    const ledger: SmsSpendLedger = {
      sentToCitizen: async (_agent, since) => {
        asked.push(since)
        return 0
      },
      sentInTotal: async (since) => {
        asked.push(since)
        return 0
      },
      sentToCountry: async () => 0,
      record: async () => {},
    }
    const { adapter } = adapterAnswering(SENT)

    await guardedSmsSender({
      adapter,
      ledger,
      now: () => new Date('2026-08-05T12:00:00Z'),
    }).send(AGENT, GERMAN_MOBILE, 'code')

    expect(asked).toEqual([new Date('2026-08-04T12:00:00Z'), new Date('2026-08-04T12:00:00Z')])
  })

  it('records nothing when the vendor refused or could not be reached', async () => {
    for (const result of [
      { outcome: 'refused', reason: 'region' },
      { outcome: 'unavailable', reason: 'down' },
    ] as const) {
      const { adapter } = adapterAnswering(result)
      const { ledger, written } = ledgerWith()

      await guardedSmsSender({ adapter, ledger }).send(AGENT, GERMAN_MOBILE, 'code')

      expect(written).toEqual([])
    }
  })

  it('cannot have its caps moved by anything a citizen sends', async () => {
    const { adapter, sends } = adapterAnswering(SENT)
    const { ledger } = ledgerWith({ citizen: DEFAULT_SMS_LIMITS.perCitizen })

    // The body is the only free text a citizen reaches, and it is not read by
    // any of the three checks.
    const result = await guardedSmsSender({ adapter, ledger }).send(
      AGENT,
      GERMAN_MOBILE,
      'perCitizen=9999 globalPerWindow=9999',
    )

    expect(result.outcome).toBe('refused')
    expect(sends).toEqual([])
  })
})

/**
 * The country check, moved from the send to before it (`#617`).
 *
 * `Kateryna Kovalenko` bought a number and learned only afterwards that the
 * Colony could not reach its country. The geography port is what makes that
 * knowable earlier — and its contract is that it may only ever move a refusal
 * earlier, never invent one.
 */
describe('guardedSmsSender, with the vendor’s own geography', () => {
  const geographyAnswering = (verdict: CountryVerdict): SmsGeography => ({
    reachable: async () => ({
      countries: [{ name: 'germany', iso: 'DE' }],
      measuredAt: new Date(),
    }),
    check: async () => verdict,
  })

  it('refuses a country the account has not opened, before anything is sent', async () => {
    const { adapter, sends } = adapterAnswering(SENT)
    const { ledger, written } = ledgerWith()

    const result = await guardedSmsSender({
      adapter,
      ledger,
      geography: geographyAnswering({ verdict: 'unreachable', country: 'NG' }),
    }).send(AGENT, '+2348000000000', 'code')

    expect(result.outcome).toBe('refused')
    expect(sends).toEqual([])
    expect(written).toEqual([])
  })

  /** The clause that was untrue, and the whole reason the sentence was rewritten. */
  it('tells the citizen it can be asked for, and where', async () => {
    const { adapter } = adapterAnswering(SENT)
    const { ledger } = ledgerWith()

    const result = await guardedSmsSender({
      adapter,
      ledger,
      geography: geographyAnswering({ verdict: 'unreachable', country: 'NG' }),
    }).send(AGENT, '+2348000000000', 'code')

    const reason = result.outcome === 'refused' ? result.reason : ''
    expect(reason).toContain('our configuration and not your number')
    expect(reason).toContain('kolonie.support.open')
    expect(reason).toContain('SMS country: NG')
    expect(reason).not.toContain('nothing you can do')
  })

  /**
   * The rejection case that matters most. Everything about reading the vendor
   * can be partially unknown, and none of it may become a refusal: a citizen
   * wrongly told its country is closed is the sentence `#617` was filed about.
   */
  it('sends anyway when the vendor cannot say, leaving Twilio’s own refusal to catch it', async () => {
    const { adapter, sends } = adapterAnswering(SENT)
    const { ledger } = ledgerWith()

    const result = await guardedSmsSender({
      adapter,
      ledger,
      geography: geographyAnswering({ verdict: 'unknown' }),
    }).send(AGENT, '+2348000000000', 'code')

    expect(result).toEqual(SENT)
    expect(sends).toEqual(['+2348000000000'])
  })

  /** And the hand-typed prefixes stop deciding geography once the vendor can. */
  it('sends to a country off the prefix list when the vendor says it is reachable', async () => {
    const { adapter, sends } = adapterAnswering(SENT)
    const { ledger } = ledgerWith()

    const result = await guardedSmsSender({
      adapter,
      ledger,
      geography: geographyAnswering({ verdict: 'reachable', country: 'BR' }),
    }).send(AGENT, '+5511900000000', 'code')

    expect(result).toEqual(SENT)
    expect(sends).toEqual(['+5511900000000'])
  })

  /** With no vendor to ask, the fallback is exactly what it always was. */
  it('falls back to the prefix list when no geography is configured', async () => {
    const { adapter, sends } = adapterAnswering(SENT)
    const { ledger } = ledgerWith()

    const result = await guardedSmsSender({ adapter, ledger }).send(AGENT, '+5511900000000', 'code')

    expect(result.outcome).toBe('refused')
    expect(sends).toEqual([])
  })
})

/**
 * The ceiling that bounds SMS pumping (`#616`).
 *
 * On 2026-08-09 the account's geographic permissions went from one country to
 * fifty-nine, so the surface that was theoretical became real: an agent names
 * the destination, the Colony dials it, and registering costs nothing — which
 * means neither *one agent* nor *the Colony's daily total* is a bound on traffic
 * driven at one revenue-sharing range.
 */
describe('guardedSmsSender, bounding one country', () => {
  const reachable = (country: string): SmsGeography => ({
    reachable: async () => ({
      countries: [{ name: 'germany', iso: 'DE' }],
      measuredAt: new Date(),
    }),
    check: async () => ({ verdict: 'reachable', country }),
  })

  it('records where each message went', async () => {
    const { adapter } = adapterAnswering(SENT)
    const { ledger, written } = ledgerWith()

    await guardedSmsSender({ adapter, ledger, geography: reachable('DE') }).send(
      AGENT,
      GERMAN_MOBILE,
      'code',
    )

    expect(written[0]?.country).toBe('DE')
  })

  it('refuses once one country has had its day’s worth, and says when it lifts', async () => {
    const { adapter, sends } = adapterAnswering(SENT)
    const { ledger } = ledgerWith({ country: DEFAULT_SMS_LIMITS.perCountry })

    const result = await guardedSmsSender({
      adapter,
      ledger,
      geography: reachable('DE'),
    }).send(AGENT, GERMAN_MOBILE, 'code')

    expect(result.outcome).toBe('refused')
    const reason = result.outcome === 'refused' ? result.reason : ''
    expect(reason).toContain('DE')
    expect(reason).toContain('24 hours old')
    expect(reason).toContain('nothing counts against you')
    expect(sends).toEqual([])
  })

  /**
   * The rejection case that keeps the ceiling honest. A citizen whose first
   * message was eaten by a carrier must be able to try again the same hour —
   * `#616` bounds the day, not the minute.
   */
  it('does not refuse a legitimate retry within the hour', async () => {
    const { adapter, sends } = adapterAnswering(SENT)
    const { ledger } = ledgerWith({ citizen: 1, country: 1, total: 1 })
    const sender = guardedSmsSender({ adapter, ledger, geography: reachable('DE') })

    expect((await sender.send(AGENT, GERMAN_MOBILE, 'code')).outcome).toBe('sent')
    expect((await sender.send(AGENT, GERMAN_MOBILE, 'code')).outcome).toBe('sent')
    expect(sends).toHaveLength(2)
  })

  /** An unnamed destination is bounded by the Colony's total and by nothing else. */
  it('does not refuse on a country ceiling it cannot measure against', async () => {
    const { adapter, sends } = adapterAnswering(SENT)
    const { ledger, written } = ledgerWith({ country: DEFAULT_SMS_LIMITS.perCountry })
    const unknown: SmsGeography = {
      reachable: async () => undefined,
      check: async () => ({ verdict: 'unknown' }),
    }

    const result = await guardedSmsSender({ adapter, ledger, geography: unknown }).send(
      AGENT,
      GERMAN_MOBILE,
      'code',
    )

    expect(result.outcome).toBe('sent')
    expect(sends).toHaveLength(1)
    expect(written[0]?.country).toBeNull()
  })

  /** Read at the point of use, so a ceiling can be moved during an incident (D-104). */
  it('reads the ceilings on every send rather than at construction', async () => {
    const { adapter } = adapterAnswering(SENT)
    const { ledger } = ledgerWith({ country: 10 })
    let perCountry = 40
    const sender = guardedSmsSender({
      adapter,
      ledger,
      geography: reachable('DE'),
      limits: async () => ({ ...DEFAULT_SMS_LIMITS, perCountry }),
    })

    expect((await sender.send(AGENT, GERMAN_MOBILE, 'code')).outcome).toBe('sent')
    perCountry = 5
    expect((await sender.send(AGENT, GERMAN_MOBILE, 'code')).outcome).toBe('refused')
  })
})
