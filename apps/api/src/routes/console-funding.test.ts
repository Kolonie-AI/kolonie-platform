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
