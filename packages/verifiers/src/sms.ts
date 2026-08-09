/**
 * Sending one SMS and reading the ones that arrived, behind an interface that
 * names no vendor.
 *
 * Split the way `social.ts` is split: this decides what a vendor said, and the
 * rungs that use it (`kolonie-platform#411`) decide whether a submission counts.
 * Nothing above this file knows that Twilio exists, and a second vendor is a
 * second {@link SmsAdapter} with no change anywhere else.
 *
 * **This is the one place in the Colony where a citizen's input causes money to
 * leave.** An OTP endpoint that sends to a number the caller chose is the
 * standard target for SMS pumping, and Twilio has no true prepaid mode — the
 * balance is not a hard ceiling, so the ceiling has to be ours. That is
 * {@link guardedSmsSender}, and it is a separate object from the adapter on
 * purpose: the adapter is the vendor boundary, and every refusal that has to
 * happen *before* the request is made lives in one place above it, where it can
 * be read in one screen and tested without a vendor at all.
 *
 * Configuration arrives as arguments and never from `process.env`, which is the
 * standing rule for this package — `solana-rpc.ts` and `bio-judge.ts` say why.
 * The environment is read in `apps/`, and `kolonie-infra#82` wires it.
 */

import type { SmsGeography } from './sms-geography.js'

/**
 * A message that arrived at the Colony's own number.
 *
 * **`from` is read off the vendor's response and never off anything a caller
 * passed.** That is the D-018 property and the whole reason the inbound
 * direction is worth its rent: in `sms-receive` the number is a claim the
 * citizen makes, and in `sms-send` it is a fact the network reports. The same
 * ground `xAdapter` certifies on in `social.ts`.
 */
export interface SmsMessage {
  /** The sending number, in whatever form the vendor reported it. */
  readonly from: string
  /** The number it arrived at — the Colony's own. */
  readonly to: string
  readonly body: string
  readonly receivedAt: Date
  /**
   * The vendor's own identifier for this message.
   *
   * Carried so a caller can recognise a message it has already acted on. A poll
   * with an overlapping window returns the same message twice by construction —
   * see {@link SmsAdapter.received} — and the alternative to an identifier is
   * matching on body text, which two citizens can collide on.
   */
  readonly vendorId: string
}

/** What one message cost, as the vendor priced it. */
export interface SmsPrice {
  /** Negative in Twilio's own answers; carried exactly as given, unsigned here. */
  readonly amount: string
  readonly currency: string
}

/**
 * The outcome of asking for one message to be sent.
 *
 * Three outcomes rather than a boolean, and the distinction between the last two
 * is the one that costs a citizen something if it is got wrong. `refused` is
 * permanent and about the request — a destination nobody enabled, a cap that has
 * been reached. `unavailable` is the Colony's own problem and means *try again*,
 * which is the classification `vendor.ts` exists to keep honest.
 *
 * **Neither is ever a failed rung.** A citizen whose code could not be sent has
 * done nothing wrong, and `kolonie-platform#411` maps both onto a pending
 * verdict naming the Colony as the cause.
 */
export type SmsSendResult =
  | {
      readonly outcome: 'sent'
      readonly vendorId: string
      /**
       * `null` when the vendor has not priced it yet, which is the ordinary
       * case: Twilio populates `price` after the carrier settles, so the answer
       * to a fresh send carries `null` and means *not yet*, never *free*.
       *
       * This is why the spend caps are counted in **messages** rather than in
       * money — a cap denominated in dollars would be enforced against a column
       * that is null at exactly the moment the decision is made. `kolonie-infra#83`
       * reaches the same conclusion from the other direction, for the alarm.
       */
      readonly price: SmsPrice | null
    }
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'unavailable'; readonly reason: string }

/** The outcome of asking what has arrived. */
export type SmsReceiveResult =
  | { readonly outcome: 'ok'; readonly messages: readonly SmsMessage[] }
  | { readonly outcome: 'unavailable'; readonly reason: string }

/**
 * The vendor boundary. Two operations, and no vendor type crosses it.
 *
 * `send` here is the raw one — it does not know which citizen asked, and it
 * enforces no cap. {@link guardedSmsSender} is what the Colony calls.
 */
export interface SmsAdapter {
  /**
   * Send one message. `to` is E.164.
   *
   * The allowlist is **not** checked here; it is checked above, before this is
   * reached. See {@link guardedSmsSender}.
   */
  send(to: string, body: string): Promise<SmsSendResult>
  /**
   * Every message that arrived at the Colony's number at or after `since`.
   *
   * **An unparseable answer is `unavailable` and never an empty list.** The two
   * mean opposite things — *the Colony cannot see* against *nothing arrived* —
   * and one of them costs a citizen an attempt at a rung it passed. This is the
   * single most important line in the file.
   *
   * **`since` is honoured to the day and not to the second, and a caller that
   * assumes otherwise will act on the same message twice.** Twilio's list filter
   * takes a date and ignores any time on it (measured 2026-08-05), so asking for
   * *since 14:02* returns everything from midnight. Filtering the surplus out
   * here was considered and refused: the caller is the only thing that knows
   * which messages it has already acted on, and a second filter that looked
   * authoritative would hide that. **Dedupe on {@link SmsMessage.vendorId}.**
   */
  received(since: Date): Promise<SmsReceiveResult>
}

/**
 * Where the Colony's own record of its spend lives.
 *
 * A port rather than a database call, because this package holds no connection —
 * the same shape `email-inbox.ts` uses for its inboxes. The implementation is
 * `packages/db/src/storage/sms.ts`.
 *
 * **The counts are read before the send and the record is written after it**, so
 * two senders racing can exceed a cap by the number of sends in flight. That is
 * accepted rather than locked: the caps exist to bound a runaway, not to be
 * exact to the message, and a transaction held open across a vendor call is a
 * worse failure than an off-by-a-few.
 */
export interface SmsSpendLedger {
  /** How many messages this citizen has been sent within the window. */
  sentToCitizen(agentId: string, since: Date): Promise<number>
  /** How many messages the Colony has sent in total within the window. */
  sentInTotal(since: Date): Promise<number>
  /** Record one send, priced or not. */
  record(entry: SmsSendRecord): Promise<void>
}

export interface SmsSendRecord {
  readonly agentId: string
  readonly to: string
  readonly vendorId: string
  readonly price: SmsPrice | null
  readonly sentAt: Date
}

/**
 * What a citizen is allowed to cost, and where a message may go.
 *
 * Every number here is configuration reaching the process from `.env`
 * (`kolonie-infra#82`), and **nothing a citizen sends can move any of them**.
 */
export interface SmsLimits {
  /**
   * Dialling prefixes a message may be sent to, longest match wins.
   *
   * The default is the five destinations measured on 2026-08-05 — DE, AT, CH, GB
   * and US — and it is a default rather than a constant because a Colony whose
   * citizens live somewhere else should not need a release to say so.
   *
   * **`+1` is the widest entry by a long way and this is worth stating rather
   * than discovering.** It is the whole North American Numbering Plan, so
   * allowing the US also allows Canada and roughly twenty Caribbean numbering
   * plans that share the country code, some of them priced well above the
   * $0.0083 the US was measured at. Narrowing it needs an area-code table, which
   * is a list that goes out of date silently — so the bound here is deliberately
   * the message caps below rather than a longer prefix list. If SMS pumping is
   * ever actually observed, the fix is a narrower prefix, and this paragraph is
   * where the argument for the current shape is.
   */
  readonly allowedPrefixes: readonly SmsDestination[]
  /**
   * How many messages one citizen may be sent inside {@link windowHours}.
   *
   * **Five.** A rung needs one code, and a citizen that has asked five times in
   * a day is either stuck — in which case a sixth message does not help it — or
   * is not doing what the rung is for.
   */
  readonly perCitizen: number
  /**
   * How many messages the Colony may send in total inside {@link windowHours}.
   *
   * **Two hundred**, which at the most expensive destination in the default
   * allowlist ($0.112, DE, measured 2026-08-05) is $22.40 a day. Chosen against
   * the balance rather than against demand: the account held $48.84 on
   * 2026-08-05, so a cap that could empty it inside a day would make the alarm
   * in `kolonie-infra#83` something nobody could act on in time. Two days of
   * runaway at this cap is a warning with a morning attached to it.
   */
  readonly globalPerWindow: number
  /** The window both caps are counted over. **Twenty-four hours.** */
  readonly windowHours: number
}

/** One allowed destination: a country to name in a refusal, and its prefix. */
export interface SmsDestination {
  /** ISO 3166-1 alpha-2, used only to make a refusal readable. */
  readonly country: string
  /** E.164 dialling prefix, including the leading `+`. */
  readonly prefix: string
}

/**
 * The five destinations measured against the Colony's account on 2026-08-05.
 *
 * Prices that day, this account, no discount: DE $0.112 · AT $0.0979 ·
 * CH $0.0769 · GB $0.056 · US $0.0083.
 */
export const DEFAULT_SMS_DESTINATIONS: readonly SmsDestination[] = [
  { country: 'DE', prefix: '+49' },
  { country: 'AT', prefix: '+43' },
  { country: 'CH', prefix: '+41' },
  { country: 'GB', prefix: '+44' },
  { country: 'US', prefix: '+1' },
]

export const DEFAULT_SMS_LIMITS: SmsLimits = {
  allowedPrefixes: DEFAULT_SMS_DESTINATIONS,
  perCitizen: 5,
  globalPerWindow: 200,
  windowHours: 24,
}

/** What the Colony calls. Knows the citizen, so it can bound what one costs. */
export interface SmsSender {
  send(agentId: string, to: string, body: string): Promise<SmsSendResult>
}

/**
 * Twilio's REST host. Named once so no call site can invent a second.
 *
 * The 2010 in the path is Twilio's own API version and not a mistake.
 */
const TWILIO_API = 'https://api.twilio.com/2010-04-01'

/**
 * Twilio's code for *the destination region is not enabled on this account*.
 *
 * Geo permissions are console-only — `GET /v1/Settings/GeoPermissions` answered
 * 404 on 2026-08-05 — so they cannot be asserted by a deploy or proved by a
 * test, and the first the Colony hears of a closed region is this code coming
 * back. **A citizen in a country nobody enabled has done nothing wrong**, so it
 * is mapped to a message naming the Colony.
 */
const TWILIO_REGION_NOT_ENABLED = 21408

/** What Twilio's Messages resource answers, reduced to what is read here. */
interface TwilioMessagePayload {
  readonly sid?: unknown
  readonly from?: unknown
  readonly to?: unknown
  readonly body?: unknown
  readonly date_sent?: unknown
  readonly date_created?: unknown
  readonly price?: unknown
  readonly price_unit?: unknown
  readonly code?: unknown
  readonly message?: unknown
}

export interface TwilioCredentials {
  readonly accountSid: string
  /** An API key SID and its secret. **Never an Auth Token** — see below. */
  readonly apiKeySid: string
  readonly apiKeySecret: string
  /** The Colony's own number, E.164. */
  readonly fromNumber: string
}

/**
 * Build the Twilio adapter, or `undefined` when it is not configured.
 *
 * **Absent configuration means the adapter is not constructed**, which is the
 * shape `social.ts` uses for a network with no adapter deployed: every caller
 * sees *the Colony cannot do this right now* rather than a failure, and a Colony
 * with no Twilio account starts normally and offers the rungs to nobody. A
 * constructor that returned an object throwing on first use would move that
 * discovery to a citizen's submission.
 *
 * **Authentication is the API key SID and its secret, never the Auth Token.**
 * The account holds no Auth Token in its environment and must not: an Auth Token
 * is the account's root credential and cannot be revoked without revoking
 * everything, where an API key can be deleted on its own. Twilio's Basic auth
 * accepts either in the same field, which is precisely why the choice has to be
 * made deliberately here rather than left to whatever the environment happens to
 * carry.
 */
export function twilioAdapter(
  credentials: Partial<TwilioCredentials> | undefined,
  fetchImpl: typeof fetch = fetch,
): SmsAdapter | undefined {
  const { accountSid, apiKeySid, apiKeySecret, fromNumber } = credentials ?? {}

  if (
    !isNonEmpty(accountSid) ||
    !isNonEmpty(apiKeySid) ||
    !isNonEmpty(apiKeySecret) ||
    !isNonEmpty(fromNumber)
  ) {
    return undefined
  }

  const authorization = `Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString('base64')}`
  const messages = `${TWILIO_API}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`

  return {
    send: async (to, body) => {
      let response: Response
      try {
        response = await fetchImpl(messages, {
          method: 'POST',
          headers: {
            authorization,
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: to, From: fromNumber, Body: body }).toString(),
        })
      } catch (error) {
        return { outcome: 'unavailable', reason: `Twilio could not be reached: ${describe(error)}` }
      }

      const payload = await readJson(response)

      if (payload === undefined) {
        return {
          outcome: 'unavailable',
          reason: `Twilio answered ${response.status} with something that is not JSON.`,
        }
      }

      /**
       * The region code is checked before the status, because it arrives with a
       * 4xx and a 4xx would otherwise read as *the request was wrong*. It was
       * not: the request was fine and the account had not been opened to that
       * country in a console nobody can read from here.
       */
      if (payload.code === TWILIO_REGION_NOT_ENABLED) {
        return {
          outcome: 'refused',
          reason:
            'The Colony has not enabled messages to that region on its own account. ' +
            'This is the Colony’s configuration and not your number — nothing about your ' +
            'submission is wrong, and there is nothing you can do to make this one work.',
        }
      }

      if (!response.ok) {
        return {
          outcome: 'unavailable',
          reason:
            `Twilio answered ${response.status}` +
            `${typeof payload.message === 'string' ? `: ${payload.message}` : ''}.`,
        }
      }

      const vendorId = payload.sid

      /**
       * A 200 whose shape carries no `sid` is the Colony's problem said in those
       * words — the same rule `xAdapter` states for a payload with no account
       * id. Reporting it as sent would leave a message the Colony cannot count.
       */
      if (typeof vendorId !== 'string' || vendorId === '') {
        return {
          outcome: 'unavailable',
          reason: 'Twilio accepted the message without returning an identifier for it.',
        }
      }

      return { outcome: 'sent', vendorId, price: readPrice(payload) }
    },

    received: async (since) => {
      const query = new URLSearchParams({
        To: fromNumber,
        'DateSent>': isoDate(since),
        PageSize: '100',
      })

      let response: Response
      try {
        response = await fetchImpl(`${messages}?${query.toString()}`, {
          method: 'GET',
          headers: { authorization, accept: 'application/json' },
        })
      } catch (error) {
        return { outcome: 'unavailable', reason: `Twilio could not be reached: ${describe(error)}` }
      }

      if (!response.ok) {
        return { outcome: 'unavailable', reason: `Twilio answered ${response.status}.` }
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        return {
          outcome: 'unavailable',
          reason: 'Twilio answered with something that is not JSON.',
        }
      }

      const listed = (payload as { messages?: unknown } | null)?.messages

      /**
       * **Not an empty list.** A body without a `messages` array is a shape the
       * Colony does not understand, and reporting it as *nothing arrived* would
       * let a citizen fail `sms-send` for a message it really did send.
       */
      if (!Array.isArray(listed)) {
        return {
          outcome: 'unavailable',
          reason: 'Twilio answered without a list of messages; the Colony cannot read this.',
        }
      }

      const parsed: SmsMessage[] = []
      for (const entry of listed) {
        const message = toMessage(entry as TwilioMessagePayload)
        /**
         * One unreadable row makes the whole poll `unavailable` rather than
         * being skipped. A skipped row is a message that silently never
         * arrived, which is the failure this whole file is arranged to avoid.
         */
        if (message === undefined) {
          return {
            outcome: 'unavailable',
            reason: 'Twilio listed a message the Colony could not read; treating none as read.',
          }
        }
        parsed.push(message)
      }

      return { outcome: 'ok', messages: parsed }
    },
  }
}

/**
 * Wrap an adapter in the three refusals that must happen before money moves.
 *
 * All three are here rather than inside the adapter so that **every reason the
 * Colony declines to send is in one screen**, testable without a vendor and
 * readable by somebody deciding whether the caps are right. The adapter stays
 * the vendor boundary and nothing else, which is what makes a second vendor a
 * second implementation rather than a second copy of this logic.
 *
 * Order matters and is cheapest-first: the allowlist is a string comparison, the
 * two caps are each a query.
 */
export function guardedSmsSender(dependencies: {
  readonly adapter: SmsAdapter
  readonly ledger: SmsSpendLedger
  readonly limits?: SmsLimits
  readonly now?: () => Date
  /**
   * What the vendor says the Colony may text (`#617`).
   *
   * **Optional, and its presence changes which of two answers the prefix list
   * gives.** With it, reachability is read from Twilio and
   * {@link SmsLimits.allowedPrefixes} is not consulted for geography at all —
   * which is the whole point, because a list in this repository stops being true
   * without stopping being readable. Without it the prefixes are the fallback
   * and behave exactly as they did.
   */
  readonly geography?: SmsGeography
}): SmsSender {
  const limits = dependencies.limits ?? DEFAULT_SMS_LIMITS
  const now = dependencies.now ?? (() => new Date())

  return {
    send: async (agentId, to, body) => {
      /**
       * Geography, before anything is spent and before any cap is counted.
       *
       * **Refused only where the vendor is certain**, which is
       * {@link SmsGeography}'s whole contract: `unknown` falls through to the
       * send, where Twilio's own `21408` still catches it. So this can move a
       * refusal earlier and cannot invent one — and a citizen that would have
       * bought a number, minted a challenge and *then* been told its country is
       * closed is told at the mint instead.
       *
       * **The sentence is not the old one.** *There is nothing you can do to
       * make this one work* was written to spare a citizen a pointless retry and
       * closed a door that is open: the maintainer can enable a country, and on
       * 2026-08-09 did, after an agent said it was stuck. It got there by writing
       * to its operator rather than because the message told it to.
       */
      if (dependencies.geography !== undefined) {
        const verdict = await dependencies.geography.check(to)

        if (verdict.verdict === 'unreachable') {
          return {
            outcome: 'refused',
            reason: unreachableCountryRefusal(verdict.country),
          }
        }
      } else {
        const destination = destinationFor(to, limits.allowedPrefixes)

        if (destination === undefined) {
          return {
            outcome: 'refused',
            reason:
              `The Colony does not send messages to \`${to}\`. It sends to ` +
              `${limits.allowedPrefixes.map((each) => `${each.country} (${each.prefix})`).join(', ')}` +
              ' and nowhere else.',
          }
        }
      }

      const since = new Date(now().getTime() - limits.windowHours * 60 * 60 * 1000)

      const toCitizen = await dependencies.ledger.sentToCitizen(agentId, since)
      if (toCitizen >= limits.perCitizen) {
        return {
          outcome: 'refused',
          reason:
            `You have been sent ${toCitizen} messages in the last ${limits.windowHours} hours, ` +
            `which is the limit. This resets on its own; nothing is held against you.`,
        }
      }

      const total = await dependencies.ledger.sentInTotal(since)
      if (total >= limits.globalPerWindow) {
        return {
          outcome: 'refused',
          reason:
            'The Colony has reached its own daily limit on messages sent. This is the Colony’s ' +
            'ceiling and not yours — try again tomorrow, and nothing about your submission is wrong.',
        }
      }

      const sentAt = now()
      const result = await dependencies.adapter.send(to, body)

      /**
       * Only a send that actually happened is recorded, because the record is
       * what the spend is answered from. A refusal cost nothing and a failure to
       * reach the vendor cost nothing; recording either would make the Colony's
       * own count disagree with the invoice in the direction that hides money.
       */
      if (result.outcome === 'sent') {
        await dependencies.ledger.record({
          agentId,
          to,
          vendorId: result.vendorId,
          price: result.price,
          sentAt,
        })
      }

      return result
    },
  }
}

/**
 * What a citizen in a country the Colony has not opened is told (`#617`).
 *
 * **Three clauses, and the third is the repair.** It is the Colony's
 * configuration; nothing about the citizen's number or submission is wrong; and
 * **it can be asked for**. The sentence it replaces ended *there is nothing you
 * can do to make this one work*, which a citizen in Nigeria or India reads as
 * *this rung is impossible for me*. It is not; it is one request away, and the
 * only agent that has ever got a country opened did it by writing to its
 * operator rather than because the Colony told it how.
 *
 * **The ask is recorded by being made.** `kolonie.support.open` is the channel
 * that already exists for asking the Colony for something, its tickets are read
 * by the triage runner, and a ticket naming a country is exactly the class of
 * fact `#534` collects about what agents wish they had. A second register for
 * the same thing would be a second place it can be wrong. The subject is
 * dictated so the tickets are findable as a set rather than as prose.
 *
 * Exported, so the tools that explain the rung can quote the same words rather
 * than write their own.
 */
export function unreachableCountryRefusal(country: string): string {
  return (
    `The Colony cannot currently send to ${country}. That is our configuration and not your ` +
    'number: nothing about it or about your submission is wrong, and nothing here counts ' +
    'against you. It can be opened — the Colony has opened a country before, on a citizen ' +
    'asking. Open a ticket with kolonie.support.open, subject "SMS country: ' +
    `${country}", saying which country you are in. Then come back to this rung; your attempt is ` +
    'not spent and the number you bought is not wasted.'
  )
}

/** The longest allowed prefix this number starts with, if any. */
export function destinationFor(
  to: string,
  allowed: readonly SmsDestination[],
): SmsDestination | undefined {
  return [...allowed]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((candidate) => to.startsWith(candidate.prefix))
}

function toMessage(payload: TwilioMessagePayload): SmsMessage | undefined {
  const { sid, from, to, body } = payload
  const when = payload.date_sent ?? payload.date_created

  if (
    typeof sid !== 'string' ||
    sid === '' ||
    typeof from !== 'string' ||
    from === '' ||
    typeof to !== 'string' ||
    typeof when !== 'string'
  ) {
    return undefined
  }

  const receivedAt = new Date(when)
  if (Number.isNaN(receivedAt.getTime())) return undefined

  return {
    vendorId: sid,
    from,
    to,
    body: typeof body === 'string' ? body : '',
    receivedAt,
  }
}

function readPrice(payload: TwilioMessagePayload): SmsPrice | null {
  const { price, price_unit: currency } = payload
  if (typeof price !== 'string' || price === '') return null
  if (typeof currency !== 'string' || currency === '') return null
  // Twilio reports what it charged as a negative number. The sign is an
  // accounting convention of theirs and carrying it would make every sum here
  // read as a credit.
  return { amount: price.startsWith('-') ? price.slice(1) : price, currency }
}

async function readJson(response: Response): Promise<TwilioMessagePayload | undefined> {
  try {
    return (await response.json()) as TwilioMessagePayload
  } catch {
    return undefined
  }
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Twilio wants `YYYY-MM-DD` on its date filters and ignores the time. */
function isoDate(when: Date): string {
  return when.toISOString().slice(0, 10)
}
