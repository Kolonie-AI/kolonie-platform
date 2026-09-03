import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { recordingLog, type RecordingLog } from '../__fixtures__/console.js'
import { registeredCitizen } from '../__fixtures__/mcp.js'
import type { FakeVault } from '../__fixtures__/vault.js'
import { GUEST_HANDOFF_HEADERS } from '../guest-handoff-page.js'

const SITE = 'https://kolonie.ai'
const HOST = new URL(SITE).host
const SECRET = 'sentinel-value-not-for-preview'

let app: FastifyInstance
let vault: FakeVault
let token: string
let createdHandoffId: string
let log: RecordingLog

beforeEach(async () => {
  log = recordingLog()
  const registered = await registeredCitizen()
  const { colony, agent, apiKey } = registered
  const agentId = agent.id
  vault = colony.vault.vault
  await vault.set(String(apiKey), agentId, 'service/account', SECRET, 'machine account')
  const created = await vault.createGuestHandoff?.({
    token: String(apiKey),
    agentId,
    key: 'service/account',
    purpose: 'open the machine account',
    minutes: 15,
    passphrase: 'separate phrase',
  })
  if (created === undefined || created.outcome !== 'created') throw new Error('fixture failed')
  token = created.bearerToken
  createdHandoffId = created.handoff.id
  app = buildApp({ ...colony, websiteUrl: SITE, log })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const ask = (
  method: 'HEAD' | 'GET' | 'POST',
  bearer = token,
  extra: Record<string, unknown> = {},
) => app.inject({ method, url: `/handoff/${bearer}`, headers: { host: HOST }, ...extra })

const csrfFrom = (body: string): string => {
  const found = body.match(/name="csrf" value="([^"]+)"/)
  if (found?.[1] === undefined) throw new Error('csrf absent')
  return found[1]
}

const cookieFrom = (header: string | string[] | undefined): string => {
  const raw = Array.isArray(header) ? header[0] : header
  if (raw === undefined) throw new Error('cookie absent')
  return raw.split(';')[0] as string
}

describe('the public guest handoff page', () => {
  it('lets HEAD and repeated crawler GETs preview without disclosing or consuming', async () => {
    expect((await ask('HEAD')).statusCode).toBe(200)

    for (const userAgent of ['link-unfurler', 'mail-security-scanner', 'browser-prefetch']) {
      const preview = await ask('GET', token, { headers: { host: HOST, 'user-agent': userAgent } })
      expect(preview.statusCode).toBe(200)
      expect(preview.body).toContain('open the machine account')
      expect(preview.body).toContain('Created by')
      expect(preview.body).toContain('Reveal once')
      expect(preview.body).toContain('type="password"')
      expect(preview.body).not.toContain(SECRET)
      expect(preview.body).not.toContain('<strong>Description:</strong>')
      expect(preview.body).not.toContain('<script')
    }
  })

  it('requires same-origin CSRF proof before it asks storage to reveal', async () => {
    const preview = await ask('GET')
    const csrf = csrfFrom(preview.body)
    const cookie = cookieFrom(preview.headers['set-cookie'])
    const payload = `csrf=${encodeURIComponent(csrf)}&passphrase=${encodeURIComponent('separate phrase')}`

    for (const headers of [
      { host: HOST, cookie, 'content-type': 'application/x-www-form-urlencoded' },
      {
        host: HOST,
        origin: 'https://elsewhere.example',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      {
        host: HOST,
        origin: SITE,
        cookie: 'wrong=cookie',
        'content-type': 'application/x-www-form-urlencoded',
      },
    ]) {
      const refused = await ask('POST', token, { headers, payload })
      expect(refused.statusCode).toBe(404)
      expect(refused.body).not.toContain(SECRET)
    }

    expect((await ask('GET')).statusCode).toBe(200)
  })

  it('reveals exactly once after an explicit form POST, then every retry is terminal', async () => {
    const preview = await ask('GET')
    const csrf = csrfFrom(preview.body)
    const cookie = cookieFrom(preview.headers['set-cookie'])
    const headers = {
      host: HOST,
      origin: SITE,
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
    }
    const payload = `csrf=${encodeURIComponent(csrf)}&passphrase=${encodeURIComponent('separate phrase')}`

    const [first, second] = await Promise.all([
      ask('POST', token, { headers, payload }),
      ask('POST', token, { headers, payload }),
    ])
    const responses = [first, second]

    expect(responses.filter((response) => response.body.includes(SECRET))).toHaveLength(1)
    expect(responses.filter((response) => response.statusCode === 404)).toHaveLength(1)
    const disclosed = responses.find((response) => response.body.includes(SECRET))
    expect(disclosed?.headers['set-cookie']).toContain('Max-Age=0')
    expect((await ask('GET')).statusCode).toBe(404)
    expect((await ask('HEAD')).statusCode).toBe(404)
    expect((await ask('POST', token, { headers, payload })).body).not.toContain(SECRET)
    expect(log.lines()).toEqual([
      {
        level: 'info',
        message: 'a guest vault handoff was consumed',
        fields: {
          event: 'vault.guest-handoffs.consumed',
          handoffId: createdHandoffId,
        },
      },
    ])
    expect(JSON.stringify(log.lines())).not.toContain(token)
    expect(JSON.stringify(log.lines())).not.toContain(SECRET)
    expect(JSON.stringify(log.lines())).not.toContain('separate phrase')
    expect(Object.keys(log.lines()[0]?.fields ?? {}).sort()).toEqual(['event', 'handoffId'])
  })

  it('re-renders a wrong passphrase without putting it in a URL or consuming', async () => {
    const preview = await ask('GET')
    const csrf = csrfFrom(preview.body)
    const cookie = cookieFrom(preview.headers['set-cookie'])
    const wrong = await ask('POST', token, {
      headers: {
        host: HOST,
        origin: SITE,
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `csrf=${encodeURIComponent(csrf)}&passphrase=wrong-phrase`,
    })

    expect(wrong.statusCode).toBe(422)
    expect(wrong.body).toContain('not accepted')
    expect(wrong.body).not.toContain('wrong-phrase')
    expect(wrong.body).not.toContain(SECRET)
    expect((await ask('GET')).statusCode).toBe(200)
  })

  it('applies the complete no-store, no-referrer and noindex policy to every state', async () => {
    const responses = [await ask('HEAD'), await ask('GET'), await ask('GET', 'unknown-token')]
    for (const response of responses) {
      for (const [name, value] of Object.entries(GUEST_HANDOFF_HEADERS)) {
        expect(response.headers[name]).toBe(value)
      }
    }
  })

  it('renders escaped creator and purpose text and requires no JavaScript or clipboard API', async () => {
    const registered = await registeredCitizen()
    const { colony, agent, apiKey } = registered
    const malicious = '<script>alert("creator")</script>'
    await colony.vault.vault.set(String(apiKey), agent.id, 'unsafe', SECRET)
    const created = await colony.vault.vault.createGuestHandoff?.({
      token: String(apiKey),
      agentId: agent.id,
      key: 'unsafe',
      purpose: malicious,
      minutes: 15,
    })
    if (created === undefined || created.outcome !== 'created') throw new Error('fixture failed')
    const unsafeApp = buildApp({ ...colony, websiteUrl: SITE })
    await unsafeApp.ready()

    const response = await unsafeApp.inject({
      method: 'GET',
      url: `/handoff/${created.bearerToken}`,
      headers: { host: HOST },
    })

    expect(response.body).toContain('&lt;script&gt;alert(&quot;creator&quot;)&lt;/script&gt;')
    expect(response.body).not.toContain(malicious)
    expect(response.body).not.toContain('navigator.clipboard')
    expect(response.body).not.toContain('<script')
    expect(response.body).toContain('<button type="submit">Reveal once</button>')
    await unsafeApp.close()
  })

  it('uses one indistinguishable terminal page for unknown and consumed links', async () => {
    const unknown = await ask('GET', 'unknown-token')
    const preview = await ask('GET')
    const csrf = csrfFrom(preview.body)
    const cookie = cookieFrom(preview.headers['set-cookie'])
    await ask('POST', token, {
      headers: {
        host: HOST,
        origin: SITE,
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `csrf=${encodeURIComponent(csrf)}&passphrase=${encodeURIComponent('separate phrase')}`,
    })
    const consumed = await ask('GET')

    expect(consumed.statusCode).toBe(unknown.statusCode)
    expect(consumed.body).toBe(unknown.body)
    expect(consumed.body).not.toContain(token)
  })

  it('answers only on the configured website host', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/handoff/${token}`,
      headers: { host: 'api.example' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.body).not.toContain('open the machine account')
    expect(response.body).not.toContain(token)
  })
})
