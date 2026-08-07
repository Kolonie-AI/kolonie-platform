import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { SPL_TOKEN_PROGRAM, USDC_MINT } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeDeposits, fakeDepositDependencies } from '../__fixtures__/deposits.js'
import { fakeHumanStore, fakeTenant, anAgent, type FakeHumanStore } from '../__fixtures__/humans.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * The funding page (`#460`).
 *
 * **The last step of the one path this model exists to make easy.** The deposit
 * routes have reached a browser session since `#430`; what was missing was the
 * page, so somebody who wanted to fund a quest was told a price and given no way
 * to pay it.
 *
 * Most of these tests are about warnings rather than about data, and that is the
 * shape of the issue: each one is a way to be out of pocket on a page that
 * looked like it worked.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let humans: FakeHumanStore
let deposits: ReturnType<typeof fakeDeposits>

beforeEach(async () => {
  humans = fakeHumanStore()
  deposits = fakeDeposits()

  app = buildApp({
    ...fakeColony(),
    store: fakeStore(),
    console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
    humans: { store: humans, tenant: fakeTenant() },
    deposits: fakeDepositDependencies(deposits),
  })
  await app.ready()
})

afterEach(async () => {
  await app?.close()
})

const signedInCookie = async (): Promise<string> => {
  const started = await app.inject({
    method: 'GET',
    url: '/sign-in/github',
    headers: { host: CONSOLE_HOST, accept: 'text/html' },
  })
  const state = new URL(started.headers['location'] as string).searchParams.get('state') as string
  const back = await app.inject({
    method: 'GET',
    url: `/sign-in/callback?code=abc&state=${state}`,
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie: `${OAUTH_STATE_COOKIE}=${state}` },
  })
  const raw = back.headers['set-cookie']
  const all = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  const cookie = all.find((one) => one.startsWith(`${SESSION_COOKIE}=`)) as string
  return cookie.slice(0, cookie.indexOf(';'))
}

const theHuman = () => {
  const people = humans.people()
  const human = people[people.length - 1]
  if (human === undefined) throw new Error('nobody signed in')
  return human
}

const funding = (cookie: string) =>
  app.inject({
    method: 'GET',
    url: '/funding',
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie, 'cf-timezone': 'Europe/Berlin' },
  })

/** Somebody who has written a quest, and therefore has an identity to fund. */
const withIdentity = async () => {
  const cookie = await signedInCookie()
  const own = anAgent({ name: 'sponsor-abcd' })
  humans.holdsSponsor(theHuman().id, own)
  return { cookie, own }
}

describe('the funding page', () => {
  /**
   * **The warning is the most prominent thing on the page, above the address.**
   * A warning beside the thing it is about is a warning read after the decision.
   */
  it('warns about USDC and Solana before it shows anything else', async () => {
    const { cookie } = await withIdentity()

    const body = (await funding(cookie)).body

    expect(body).toContain('Send only USDC, on Solana')
    expect(body).toContain('Anything else sent to this address is lost')
    expect(body.indexOf('Send only USDC')).toBeLessThan(body.indexOf('deposit address'))
  })

  it('says the credit follows what arrives rather than what was paid', async () => {
    const { cookie } = await withIdentity()

    const body = (await funding(cookie)).body

    expect(body).toContain('credited what arrives, not what you paid')
    expect(body).toContain('fee comes off first')
  })

  /** Beside the address, before the decision — not in a linked document. */
  it('says money in is one-way, on the page', async () => {
    const { cookie } = await withIdentity()

    const body = (await funding(cookie)).body

    expect(body).toContain('Money in is one-way')
    expect(body).toContain('cannot be sent back out')
  })

  /**
   * The dollars, not only the credits (`#500`).
   *
   * A sponsor who has read *credits cannot be sent back out* still asks whether
   * the transfer itself can be reversed. It cannot, and the page says so before
   * the address rather than in a document about the Treasury.
   */
  it('says the dollars are not returned either, before the address', async () => {
    const { cookie } = await withIdentity()

    const body = (await funding(cookie)).body

    expect(body).toContain('neither can the dollars')
    expect(body.indexOf('neither can the dollars')).toBeLessThan(
      body.indexOf('Your deposit address'),
    )
  })

  it('says what a credit is worth', async () => {
    const { cookie } = await withIdentity()

    expect((await funding(cookie)).body).toContain('One credit is one US cent')
  })

  /**
   * One sentence and **no provider button**. Until an on-ramp integration lands,
   * the person buys on their own name with their own KYC and the Colony is not
   * part of that purchase.
   */
  it('tells a person to buy anywhere, and offers no provider', async () => {
    const { cookie } = await withIdentity()

    const body = (await funding(cookie)).body

    expect(body).toContain('Buy USDC on Solana wherever you like')
    expect(body).not.toMatch(/<form[^>]*action="\/funding/)
    expect(body).not.toContain('Buy with card')
  })

  it('shows the address, and the same one on a second visit', async () => {
    const { cookie } = await withIdentity()

    const first = (await funding(cookie)).body
    const second = (await funding(cookie)).body

    const addressOf = (body: string) => /value="(address-[^"]+)"/.exec(body)?.[1]

    expect(addressOf(first)).toBeDefined()
    expect(addressOf(second)).toBe(addressOf(first))
  })

  /** Three numbers, because a single balance is the one people misread. */
  it('shows available apart from reserved and held', async () => {
    const { cookie } = await withIdentity()

    const body = (await funding(cookie)).body

    expect(body).toContain('Available')
    expect(body).toContain('Reserved for quests awaiting review')
    expect(body).toContain('Held against published quests')
    expect(body).toContain('US$')
  })

  it('shows what has arrived, with its date and its verdict', async () => {
    const { cookie, own } = await withIdentity()
    const issued = await deposits.address(own.id)
    if (issued.outcome !== 'issued') throw new Error('no address')
    await deposits.record({
      signature: 'a-signature',
      address: issued.address,
      baseUnits: 5_000_000,
      mint: USDC_MINT,
      tokenProgram: SPL_TOKEN_PROGRAM,
      commitment: 'finalized',
    } as never)

    const body = (await funding(cookie)).body

    // 5_000_000 base units is US$ 5.00, and a credit is one cent.
    expect(body).toContain('500 credits (US$ 5.00)')
    expect(body).toContain('Europe/Berlin')
    expect(body).toContain('credited')
  })

  /**
   * **A refusal is shown in words rather than as a slug.** `wrong-mint` is
   * precise and says nothing to somebody who has just lost money.
   */
  it('says in words why a transfer was not credited', async () => {
    const { cookie, own } = await withIdentity()
    const issued = await deposits.address(own.id)
    if (issued.outcome !== 'issued') throw new Error('no address')
    await deposits.record({
      signature: 'the-wrong-token',
      address: issued.address,
      baseUnits: 5_000_000,
      mint: 'So11111111111111111111111111111111111111112',
      tokenProgram: SPL_TOKEN_PROGRAM,
      commitment: 'finalized',
    } as never)

    const body = (await funding(cookie)).body

    expect(body).toContain('not credited')
    expect(body).toContain('not recoverable')
    expect(body).not.toContain('wrong-mint')
  })

  /**
   * **Nothing here creates an identity.** `#455` made a row appear at the first
   * quest draft; money is not a reason to make one somebody did not ask for.
   */
  it('renders for somebody with no identity, and creates none', async () => {
    const cookie = await signedInCookie()

    const response = await funding(cookie)

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('Nothing to fund yet')
    expect(response.body).toContain('/quests/new')
    expect(await humans.sponsorAgent(theHuman().id)).toBeUndefined()
  })

  /** No withdrawal, no transfer, and no way to fund an agent from here. */
  it('offers no way to take money out or to move it', async () => {
    const { cookie } = await withIdentity()

    const body = (await funding(cookie)).body

    expect(body).toContain('no way to withdraw')
    expect(body).toContain('operating one does not make its money yours to move')
    expect(body).not.toContain('Withdraw')
    expect(body).not.toContain('Transfer')
  })

  /** `governance/quests.md`: no route requires pasting a key anywhere. */
  it('displays nothing key-shaped and asks for nothing', async () => {
    const { cookie } = await withIdentity()

    const body = (await funding(cookie)).body

    expect(body).not.toContain('private key')
    expect(body).not.toContain('seed phrase')
    expect(body).not.toContain('type="password"')
  })

  /**
   * **The rejection case.** The address is resolved from the caller and never
   * from the request, so there is nowhere to name somebody else's identity —
   * and without a session there is no caller at all.
   */
  it('is not reachable without a session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/funding',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(response.statusCode).toBe(404)
  })

  it('takes no identity from the request', async () => {
    const { cookie, own } = await withIdentity()
    const strangers = anAgent({ name: 'not-mine' })

    const body = (
      await app.inject({
        method: 'GET',
        url: `/funding?agentId=${String(strangers.id)}`,
        headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      })
    ).body

    const issued = await deposits.address(own.id)
    if (issued.outcome !== 'issued') throw new Error('no address')
    expect(body).toContain(issued.address)
  })

  /** An unconfirmed sign-up address gets the page without one, not an error. */
  it('renders without an address when the Colony will not issue one', async () => {
    const { cookie, own } = await withIdentity()
    deposits.leaveUnconfirmed(own.id)

    const response = await funding(cookie)

    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain('Your deposit address')
  })

  it('is in the console’s navigation', async () => {
    const { cookie } = await withIdentity()

    expect((await funding(cookie)).body).toContain('<a href="/funding">Funding</a>')
  })
})

/**
 * Funding before writing anything (`#469`).
 *
 * `#455` creates the person's identity at the first quest draft so that signing
 * in to look around does not manufacture empty citizens. That left somebody who
 * wants to *pay* first with a dead end, and the fix is a second door rather than
 * a change to the first: an explicit action on this page, never a page load.
 */
describe('creating the identity that holds the money', () => {
  const create = (cookie: string) =>
    app.inject({
      method: 'POST',
      url: '/funding/identity',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
    })

  it('offers an action that says what it makes', async () => {
    const cookie = await signedInCookie()

    const body = (await funding(cookie)).body

    expect(body).toContain('<form method="post" action="/funding/identity">')
    expect(body).toContain('Create my account and show my deposit address')
    // Not *create an account* on its own: they have one, they signed in with it.
    expect(body).toContain('You already have an account here')
    expect(body).toContain('holds the money')
  })

  it('creates one when the action is taken, and shows the address', async () => {
    const cookie = await signedInCookie()
    expect(await humans.sponsorAgent(theHuman().id)).toBeUndefined()

    const posted = await create(cookie)

    expect(posted.statusCode).toBe(303)
    expect(posted.headers['location']).toBe('/funding')

    const held = await humans.sponsorAgent(theHuman().id)
    expect(held).toBeDefined()

    const body = (await funding(cookie)).body
    expect(body).toContain('Your deposit address')
    // `#460`'s warnings, unchanged and still above it.
    expect(body).toContain('Send only USDC, on Solana')
    expect(body.indexOf('Send only USDC')).toBeLessThan(body.indexOf('Your deposit address'))
  })

  /**
   * **The rejection case, and it is the whole of `#455`'s rule.** A `GET` that
   * creates a row is how signing in to look around starts manufacturing
   * citizens again.
   */
  it('creates nothing on a page load, however many times it is loaded', async () => {
    const cookie = await signedInCookie()

    await funding(cookie)
    await funding(cookie)

    expect(await humans.sponsorAgent(theHuman().id)).toBeUndefined()
    // And nothing was generated on the deposit side either.
    expect(await deposits.watched()).toHaveLength(0)
  })

  it('is idempotent: pressing twice is one identity and one address', async () => {
    const cookie = await signedInCookie()

    await create(cookie)
    const first = await humans.sponsorAgent(theHuman().id)
    await create(cookie)
    const second = await humans.sponsorAgent(theHuman().id)

    expect(first).toBeDefined()
    expect(String(second?.id)).toBe(String(first?.id))
    await funding(cookie)
    expect(await deposits.watched()).toHaveLength(1)
  })

  /** `#455`'s first door is untouched: a quest draft still makes the identity. */
  it('leaves the quest-draft trigger alone', async () => {
    const cookie = await signedInCookie()

    const drafted = await app.inject({
      method: 'POST',
      url: '/quests',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'title=&brief=&questions=&capacity=&pricePerReport=',
    })

    // Whatever the form makes of an empty draft, the identity behind it exists —
    // which is the half of `#455` this issue must not have moved.
    expect(drafted.statusCode).not.toBe(404)
    expect(await humans.sponsorAgent(theHuman().id)).toBeDefined()
  })

  /**
   * **`#266` is not bypassed.** The identity is made and the *address* is still
   * refused until somebody has followed the sign-in link — and the page says so
   * rather than repeating the offer it has already honoured.
   */
  it('still refuses the address to an unconfirmed sign-up address', async () => {
    const cookie = await signedInCookie()
    await create(cookie)
    const held = await humans.sponsorAgent(theHuman().id)
    if (held === undefined) throw new Error('no identity was created')
    deposits.leaveUnconfirmed(held.id)

    const body = (await funding(cookie)).body

    expect(body).not.toContain('Your deposit address')
    expect(body).toContain('Open the mail first')
    // Not the offer again, and not the quest detour: neither would help.
    expect(body).not.toContain('Create my account and show my deposit address')
  })

  it('is not reachable without a session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/funding/identity',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(response.statusCode).toBe(404)
    expect(humans.people()).toHaveLength(0)
  })

  /** No JavaScript, which is what makes a plain form the only shape available. */
  it('adds no script to the page', async () => {
    const cookie = await signedInCookie()

    expect((await funding(cookie)).body).not.toContain('<script')
  })
})

/**
 * One route to USDC that is known to work (`#471`).
 *
 * `#464` was closed because a prefilled button needs a KYB. A link with no key
 * needs nothing, and it closes the two mistakes that actually cost money —
 * wrong asset, wrong network — without the Colony becoming a party to anything.
 */
describe('the on-ramp link', () => {
  it('offers MoonPay with USDC on Solana already chosen', async () => {
    const { cookie } = await withIdentity()

    const body = (await funding(cookie)).body

    expect(body).toContain('Buy USDC with a card (at MoonPay)')
    expect(body).toContain('currencyCode=usdc_sol')
  })

  /**
   * **Below the warnings, and below the address.** Nobody reaches it before
   * reading that only USDC on Solana is credited, and the address they have to
   * paste is directly above it.
   */
  it('sits below the warnings, never above or beside them', async () => {
    const { cookie } = await withIdentity()

    const body = (await funding(cookie)).body

    expect(body.indexOf('Send only USDC, on Solana')).toBeLessThan(body.indexOf('at MoonPay'))
    expect(body.indexOf('Money in is one-way')).toBeLessThan(body.indexOf('at MoonPay'))
    expect(body.indexOf('Your deposit address')).toBeLessThan(body.indexOf('at MoonPay'))
  })

  /** **The rejection case**: nothing in the URL identifies us or names a wallet. */
  it('passes no key, no signature and no address', async () => {
    const { cookie, own } = await withIdentity()
    const issued = await deposits.address(own.id)
    if (issued.outcome !== 'issued') throw new Error('no address')

    const body = (await funding(cookie)).body
    const link = /href="(https:\/\/buy\.moonpay\.com[^"]*)"/.exec(body)?.[1]

    expect(link).toBeDefined()
    expect(link).not.toContain('apiKey')
    expect(link).not.toContain('signature')
    expect(link).not.toContain('walletAddress')
    // The address is on the page for pasting and is not in the link.
    expect(link).not.toContain(issued.address)
    expect(body).toContain(issued.address)
  })

  it('says who the counterparty is, and that any other route works', async () => {
    const { cookie } = await withIdentity()

    const body = (await funding(cookie)).body

    expect(body).toContain('You buy from MoonPay, on your own name')
    expect(body).toContain('never sees your card')
    expect(body).toContain('any other on-ramp')
    // Not an endorsement of somebody we contracted with.
    expect(body).toContain('We have no relationship with them')
    // The earlier wording is left intact rather than replaced.
    expect(body).toContain('Buy USDC on Solana wherever you like')
  })

  /** Discovered here rather than at the payment step, having decided to buy. */
  it('states the provider’s minimum', async () => {
    const { cookie } = await withIdentity()

    expect((await funding(cookie)).body).toContain('4.99')
  })

  /**
   * Nothing to paste it into yet, so nothing to buy yet. A link that sent
   * somebody to buy before they had an address would be a way to hold USDC and
   * have nowhere to send it.
   */
  it('is absent for somebody with no address', async () => {
    const cookie = await signedInCookie()

    expect((await funding(cookie)).body).not.toContain('at MoonPay')
  })
})
