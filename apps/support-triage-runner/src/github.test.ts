import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { LogFields } from '@kolonie-ai/core'
import { githubIssues, transportReason, TRIAGE_REPOSITORIES } from './github.js'

/**
 * What a `fetch` that throws costs, and what it must not cost.
 *
 * `#586`: on 2026-08-08 at 17:03:27Z one `TypeError: fetch failed` inside
 * `closed()` escaped as far as `reconcile.failed`, so a network blip against
 * the first repository cost the other two their listing and every waiting
 * ticket its settling pass. Both listings had always handled an unreadable
 * *status* per repository; neither handled a call that never returned one.
 *
 * These tests pin the asymmetry closed from both sides: the throw is contained,
 * and the status path it was made to match still behaves as it did.
 */

/** A real key, because `appJwt` signs with it before any of this is reached. */
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

interface Recorded {
  readonly level: 'warn' | 'error'
  readonly message: string
  readonly fields: LogFields | undefined
}

function recording(): { lines: Recorded[]; log: Parameters<typeof githubIssues>[0]['log'] } {
  const lines: Recorded[] = []
  return {
    lines,
    log: {
      info: () => {},
      warn: (message, fields) => void lines.push({ level: 'warn', message, fields }),
      error: (message, _error, fields) => void lines.push({ level: 'error', message, fields }),
    },
  }
}

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

/**
 * A GitHub that authenticates, then answers each repository listing from
 * `answers` — a thrown value stands for a transport failure, a number for a
 * status, an array for a body.
 */
function github(answers: Record<string, unknown>) {
  const { lines, log } = recording()
  const asked: string[] = []

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/app/installations')) return ok([{ id: 7 }])
    if (url.endsWith('/access_tokens')) {
      return ok({
        token: 'installation-token',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      })
    }

    const repository = TRIAGE_REPOSITORIES.find((name) => url.includes(`/repos/${name}/issues`))
    if (repository === undefined) throw new Error(`unexpected call: ${url}`)
    asked.push(repository)

    const answer = answers[repository]
    if (answer instanceof Error) throw answer
    if (typeof answer === 'number') return new Response('', { status: answer })
    return ok(answer ?? [])
  }) as typeof fetch

  return { lines, asked, issues: githubIssues({ appId: '1', privateKey, log, fetchImpl }) }
}

const [FIRST, SECOND, THIRD] = TRIAGE_REPOSITORIES

/** What undici actually raises: one message, with the fact on `cause`. */
const fetchFailed = (code: string): Error =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('boom'), { code }),
  })

describe('a repository listing that throws', () => {
  it('does not cost the repositories after it — closed()', async () => {
    const { issues, asked } = github({
      [FIRST]: fetchFailed('ECONNRESET'),
      [SECOND]: [{ title: 'settled', html_url: 'https://example.invalid/2', closed_at: null }],
      [THIRD]: [{ title: 'also settled', html_url: 'https://example.invalid/3', closed_at: null }],
    })

    const found = await issues.closed()

    expect(asked).toEqual([...TRIAGE_REPOSITORIES])
    expect(found.map((issue) => issue.url)).toEqual([
      'https://example.invalid/2',
      'https://example.invalid/3',
    ])
  })

  it('does not cost the repositories after it — open()', async () => {
    const { issues, asked } = github({
      [FIRST]: fetchFailed('ENOTFOUND'),
      [SECOND]: [{ number: 2, title: 'known', html_url: 'https://example.invalid/2' }],
      [THIRD]: [],
    })

    const found = await issues.open()

    expect(asked).toEqual([...TRIAGE_REPOSITORIES])
    expect(found.issues.map((issue) => issue.number)).toEqual([2])
    // …and it says which one it lost, which is the whole of `#867`: an empty
    // listing and an unread one are the same listing to every caller that only
    // gets the array.
    expect(found.unreadable).toEqual([FIRST])
  })

  /**
   * A pass that read everything says so, and that is the value the callers act
   * on — `watchDebt` files against a corpus whose gaps are empty and withholds
   * against one whose are not.
   */
  it('names nothing as unreadable when every repository answered', async () => {
    const { issues } = github({
      [FIRST]: [{ number: 1, title: 'known', html_url: 'https://example.invalid/1' }],
      [SECOND]: [],
      [THIRD]: [],
    })

    await expect(issues.open()).resolves.toMatchObject({ unreadable: [] })
  })

  it('warns with the cause, so the next one can be told apart from a DNS outage', async () => {
    const { issues, lines } = github({ [FIRST]: fetchFailed('UND_ERR_CONNECT_TIMEOUT') })

    await issues.closed()

    const warned = lines.find((line) => line.fields?.event === 'github.issues.read.failed')
    expect(warned?.level).toBe('warn')
    expect(warned?.fields?.status).toBeNull()
    expect(String(warned?.fields?.reason)).toContain('UND_ERR_CONNECT_TIMEOUT')
    expect(warned?.message).toContain(FIRST)
  })

  it('is a warning and not an error, so the log detector does not file it', async () => {
    const { issues, lines } = github({ [FIRST]: fetchFailed('ECONNRESET') })

    await issues.closed()

    expect(lines.filter((line) => line.level === 'error')).toEqual([])
  })

  it('yields nothing at all when every repository throws, rather than raising', async () => {
    const { issues } = github({
      [FIRST]: fetchFailed('ECONNRESET'),
      [SECOND]: fetchFailed('ECONNRESET'),
      [THIRD]: fetchFailed('ECONNRESET'),
    })

    // `reconcile` reads an empty listing as *nothing was read*, never as
    // *nothing is closed*, so an empty answer is the safe one and a throw is not.
    await expect(issues.closed()).resolves.toEqual([])
  })
})

describe('the status path it was made to match', () => {
  it('still skips one repository and still records the status', async () => {
    const { issues, lines } = github({
      [FIRST]: 403,
      [SECOND]: [{ title: 'settled', html_url: 'https://example.invalid/2', closed_at: null }],
      [THIRD]: [],
    })

    const found = await issues.closed()

    expect(found.map((issue) => issue.url)).toEqual(['https://example.invalid/2'])
    const warned = lines.find((line) => line.fields?.event === 'github.issues.read.failed')
    expect(warned?.fields?.status).toBe(403)
    expect(warned?.fields?.reason).toBeUndefined()
  })

  it('rejects a body that is not a listing rather than reading fields off it', async () => {
    const { issues, lines } = github({
      [FIRST]: { message: 'Not Found' },
      [SECOND]: [],
      [THIRD]: [],
    })

    await expect(issues.closed()).resolves.toEqual([])
    expect(lines.some((line) => line.level === 'error')).toBe(false)
  })
})

describe('transportReason', () => {
  it('names the code undici hides under a fixed message', () => {
    expect(transportReason(fetchFailed('ECONNRESET'))).toBe('fetch failed ← boom (ECONNRESET)')
  })

  it('stops walking a cause chain that does not end', () => {
    const looping = new Error('round')
    Object.assign(looping, { cause: looping })
    expect(transportReason(looping).split(' ← ')).toHaveLength(4)
  })

  it('says something useful about a thrown non-error', () => {
    expect(transportReason('just a string')).toBe('just a string')
  })
})
