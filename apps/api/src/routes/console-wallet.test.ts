import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AgentId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeHumanStore, fakeTenant, type FakeHumanStore } from '../__fixtures__/humans.js'
import {
  fakeAutonomyMailer,
  fakeAutonomyStore,
  fakeOperatorPages,
} from '../__fixtures__/autonomy.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'
import { WALLET_SCRIPT_PATH } from '../console/wallet-page.js'
import { CONSOLE_HEADERS } from '../console/html.js'

/**
 * The console half of the wallet rung (`#539`).
 *
 * On 2026-08-07 the maintainer tried to be the sponsor of the first mainnet
 * quest, holding a funded wallet in MetaMask, and could not: every address
 * verified in production had been signed **programmatically** by an agent, and
 * no page asked a browser wallet to sign. Attribution under D-106 is by sender
 * address, so an unverifiable address is a wallet that cannot pay the Colony for
 * anything, ever.
 *
 * **What is asserted here is the surface, not the signature.** The signing
 * itself happens in the wallet, in a browser, and cannot be reached from a test
 * process — `#539` asks instead that it be tried in two wallets and that the
 * date be said, which is on the issue. What a test *can* hold is everything
 * around it: that a stranger cannot reach the page, that the promise above the
 * button is actually printed, that the CSP exception is exactly two sources
 * wide, and that no path here ever asks for a key.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'
const API_HOST = 'api.example'

let app: FastifyInstance
let humans: FakeHumanStore
let pages: ReturnType<typeof fakeOperatorPages>
let agentId: AgentId
let strangersAgentId: AgentId

beforeEach(async () => {
  humans = fakeHumanStore()
  pages = fakeOperatorPages()
  const agents = fakeStore()

  app = buildApp({
    ...fakeColony(),
    store: agents,
    console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
    humans: { store: humans, tenant: fakeTenant() },
    autonomy: {
      store: fakeAutonomyStore(),
      pages,
      mailer: fakeAutonomyMailer(),
      formBaseUrl: CONSOLE_URL,
    },
  })
  await app.ready()

  agentId = agents.issue().agent.id
  strangersAgentId = agents.issue().agent.id
  pages.exists(agentId)
  pages.exists(strangersAgentId)
  pages.nameFor(agentId, 'canary')
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

const link = async (id: AgentId): Promise<void> => {
  const people = humans.people()
  const human = people[people.length - 1]
  if (human === undefined) throw new Error('nobody signed in')
  const code = await humans.issueCodeForAgent(id)
  const redeemed = await humans.redeemAsHuman(code.code, human.id)
  if (redeemed.outcome !== 'linked') throw new Error(`link refused: ${redeemed.outcome}`)
}

const openWallet = (cookie: string, id: AgentId) =>
  app.inject({
    method: 'GET',
    url: `/agents/${id}/wallet`,
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
  })

describe('the page that asks a browser wallet to sign', () => {
  it('renders behind a session, for an agent the person operates', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const response = await openWallet(cookie, agentId)

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('Prove a wallet for canary')
    expect(response.body).toContain('id="wallet-sign"')
  })

  /**
   * The promise `#539` names as *the one thing a cautious person will want to
   * know*, asserted rather than trusted to survive an edit. It is above the
   * button, so a person reads it before deciding rather than after.
   */
  it('says a signature is not a transaction, before it asks for one', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const body = (await openWallet(cookie, agentId)).body
    const promise = body.indexOf('A signature is not a transaction')
    const button = body.indexOf('id="wallet-sign"')

    expect(promise).toBeGreaterThan(-1)
    expect(promise).toBeLessThan(button)
    expect(body).toContain('moves no money')
    expect(body).toContain('never sees your private key')
  })

  /**
   * `#539`: *no private key, seed phrase or signature request for a transaction
   * appears anywhere in the flow.* The page may **name** them in the promise it
   * makes; what it must not do is ask, so what is asserted is the absence of a
   * field and of any transaction signing call.
   */
  it('has nowhere to put a key and nothing that signs a transaction', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const body = (await openWallet(cookie, agentId)).body

    expect(body).not.toMatch(/<input/i)
    expect(body).not.toMatch(/<textarea/i)
    expect(body).not.toMatch(/signTransaction|signAndSendTransaction/i)

    const script = await app.inject({
      method: 'GET',
      url: WALLET_SCRIPT_PATH,
      headers: { host: CONSOLE_HOST },
    })

    expect(script.statusCode).toBe(200)
    // `no-store`, and it is asserted because getting it wrong is invisible
    // locally: the first version said `max-age=3600`, the edge rewrote it to
    // four hours, and a shipped fix to this script reached nobody for as long.
    expect(script.headers['cache-control']).toBe('no-store')
    expect(script.body).toContain('signMessage')
    expect(script.body).not.toMatch(/signTransaction|signAndSendTransaction/i)
    expect(script.body).not.toMatch(/privateKey|secretKey|mnemonic|seed phrase/i)
  })

  /**
   * The wallet-agnostic requirement, asserted on the script rather than on a
   * comment: both discovery routes are present, and no wallet is named in a
   * branch that decides whether signing is possible.
   */
  it('discovers wallets by standard and by injected provider, naming none of them', async () => {
    const script = (
      await app.inject({ method: 'GET', url: WALLET_SCRIPT_PATH, headers: { host: CONSOLE_HOST } })
    ).body

    expect(script).toContain('wallet-standard:app-ready')
    expect(script).toContain('solana:signMessage')
    expect(script).toContain('window.solana')
    // Phantom's namespace is read because it is an interface others implement.
    // MetaMask is reached through the standard and is named nowhere at all.
    expect(script).not.toMatch(/metamask/i)
  })

  /**
   * **Every wallet that answered gets a button**, and the first version of this
   * page did not: it labelled one button after `wallets[0]` and signed with it,
   * which on a browser holding two wallets makes the second unreachable. A page
   * that offers whichever wallet registered first is not wallet-agnostic, and
   * `#539`'s *works in at least two wallets* cannot even be demonstrated on it.
   *
   * Asserted on the script because the choice is made in the browser: what a
   * test here can hold is that the code iterates the discovered wallets rather
   * than indexing one out of them.
   */
  it('offers every wallet that answered, not whichever registered first', async () => {
    const script = (
      await app.inject({ method: 'GET', url: WALLET_SCRIPT_PATH, headers: { host: CONSOLE_HOST } })
    ).body

    expect(script).toContain('for (const wallet of state.wallets)')
    expect(script).not.toContain('state.wallets[0]')
    expect(script).toContain('wallet-choices')
  })

  /**
   * The CSP exception, which is this page's whole cost: `CONSOLE_HEADERS` says
   * the console's policy can be that strict *because the pages carry no script*.
   * Two sources are added and both are `'self'`.
   */
  it('relaxes the console CSP by exactly two same-origin sources', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const csp = (await openWallet(cookie, agentId)).headers['content-security-policy'] as string

    const directives = (policy: string): Map<string, string> =>
      new Map(
        policy
          .split(';')
          .map((one) => one.trim())
          .filter((one) => one !== '')
          .map((one) => [one.slice(0, one.indexOf(' ')), one.slice(one.indexOf(' ') + 1)]),
      )

    const here = directives(csp)
    const everywhereElse = directives(CONSOLE_HEADERS['content-security-policy'] as string)

    // Diffed rather than sniffed for substrings: what matters is that this page
    // adds two directives and changes none of the ones every other console page
    // is protected by. `style-src 'unsafe-inline'` is one of those, and it is
    // inherited untouched — the console's pages carry a `<style>` block.
    const added = [...here.keys()].filter((name) => !everywhereElse.has(name))
    expect(added.sort()).toEqual(['connect-src', 'script-src'])

    for (const [name, value] of everywhereElse) expect(here.get(name)).toBe(value)

    expect(here.get('script-src')).toBe("'self'")
    expect(here.get('connect-src')).toBe("'self'")
    // Nothing off-origin, and no way to run a string.
    expect(csp).not.toContain('unsafe-eval')
    expect(here.get('script-src')).not.toContain('unsafe-inline')
    expect(csp).not.toMatch(/https?:/)
  })

  /**
   * The script is a file for that reason, so the page must carry no inline
   * block — a `<script>` with a body would need `'unsafe-inline'` and the whole
   * exception would stop being narrow.
   */
  it('carries no inline script', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const body = (await openWallet(cookie, agentId)).body

    expect(body).toContain(`src="${WALLET_SCRIPT_PATH}"`)
    expect(body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i)
  })
})

describe('who may prove a wallet', () => {
  it('answers 404 to a stranger with no session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/agents/${agentId}/wallet`,
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(response.statusCode).toBe(404)
  })

  /**
   * The same 404 as an id that names nothing, and that is the point: a page that
   * answered 403 for an agent somebody else operates would be a way to test for
   * agents.
   */
  it('answers 404 for an agent the person does not operate', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const mine = await openWallet(cookie, agentId)
    const theirs = await openWallet(cookie, strangersAgentId)

    expect(mine.statusCode).toBe(200)
    expect(theirs.statusCode).toBe(404)
  })

  it('refuses a nonce and a signature to somebody who does not operate the agent', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const challenge = await app.inject({
      method: 'POST',
      url: `/agents/${strangersAgentId}/wallet/challenge`,
      headers: { host: CONSOLE_HOST, cookie },
    })
    const signature = await app.inject({
      method: 'POST',
      url: `/agents/${strangersAgentId}/wallet/signature`,
      headers: { host: CONSOLE_HOST, cookie },
      payload: { address: 'x', signature: 'y' },
    })

    expect(challenge.statusCode).toBe(404)
    expect(signature.statusCode).toBe(404)
  })

  /** Every console path stays on the console's host, this one included. */
  it('is not served on the API host', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const page = await app.inject({
      method: 'GET',
      url: `/agents/${agentId}/wallet`,
      headers: { host: API_HOST, accept: 'text/html', cookie },
    })
    const script = await app.inject({
      method: 'GET',
      url: WALLET_SCRIPT_PATH,
      headers: { host: API_HOST },
    })

    expect(page.statusCode).toBe(404)
    expect(script.statusCode).toBe(404)
  })
})

describe('the two calls the page makes', () => {
  it('mints a nonce for the operated agent', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const response = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/wallet/challenge`,
      headers: { host: CONSOLE_HOST, cookie },
    })

    expect(response.statusCode).toBe(201)
    expect(JSON.parse(response.body).nonce).toBeTypeOf('string')
  })

  /**
   * The refusals come back from `submitWalletSignature` unchanged, so the rung
   * has one vocabulary rather than one per caller. A body that is not a base58
   * pair is the cheapest of them to provoke.
   */
  it('passes the rung’s own refusal through rather than rewording it', async () => {
    const cookie = await signedInCookie()
    await link(agentId)

    const response = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/wallet/signature`,
      headers: { host: CONSOLE_HOST, cookie },
      payload: { address: 'not base58 at all', privateKey: 'nope' },
    })

    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    // `.strict()` on the schema: a body carrying a key is refused rather than
    // quietly ignored, which is the property the page's promise rests on.
    expect(response.body).toContain('Never send a private key')
  })
})
