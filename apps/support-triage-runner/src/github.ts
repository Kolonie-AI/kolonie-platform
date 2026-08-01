import { createSign } from 'node:crypto'
import type { Log } from './loop.js'

/**
 * How this process talks to GitHub, and why it is an App rather than a token.
 *
 * `kolonie-infra#55` settled it. The short version, because the long one is in
 * that issue: a machine account costs a seat on the `team` plan and can only be
 * created at a signup form GitHub's Terms close to automation, and a fine-grained
 * token has a fixed expiry that ends with a service quietly not triaging any more.
 * An App's installation token lives an hour and renews itself, so there is no date
 * anybody has to remember and no credential to rotate by hand.
 *
 * **It is deliberately not `GITHUB_VERIFIER_TOKEN`.** That one is read-only,
 * because the `github-contribution` verifier reads it to decide whether a
 * citizen's pull request was merged. A credential that could both mint coins and
 * create the artefacts it pays for gates itself — `AGENTS.md` §87.
 *
 * **A missing key degrades this process; it does not stop it.** Same rule the
 * model key follows in `apps/moderation-runner`, and it matters more here: a
 * runner that refuses to start takes down the health endpoint that is how anyone
 * would find out it was misconfigured, and a triage loop that links what it finds
 * and opens nothing is still doing most of its job.
 */

export const APP_ID_VAR = 'GITHUB_TRIAGE_APP_ID'
export const APP_KEY_PATH_VAR = 'GITHUB_TRIAGE_APP_KEY_PATH'

/** Where the Colony files work, in the order triage should prefer. */
export const TRIAGE_REPOSITORIES = [
  'Kolonie-AI/kolonie-platform',
  'Kolonie-AI/kolonie-infra',
  'Kolonie-AI/kolonie-docs',
] as const

/** An issue the Colony already has open, as much of it as triage needs. */
export interface KnownIssue {
  readonly repository: string
  readonly number: number
  readonly title: string
  /** Truncated. The corpus is for recognising a match, not for reading. */
  readonly body: string
  readonly url: string
}

export interface NewIssue {
  readonly repository: string
  readonly title: string
  readonly body: string
  readonly labels: readonly string[]
}

/**
 * What triage needs from GitHub, as a seam.
 *
 * A seam rather than a client, for the reason `apps/moderation-runner/tripwire.ts`
 * gives for the same shape: *what to write* is then testable without a credential,
 * and a runner with none degrades rather than stops.
 */
export interface Issues {
  /** Every open issue across the repositories triage covers. */
  open(): Promise<readonly KnownIssue[]>
  /** File one. Answers the URL, or `null` when GitHub refused. */
  create(issue: NewIssue): Promise<string | null>
  /** Say on an existing issue that another citizen reported the same thing. */
  comment(url: string, body: string): Promise<boolean>
}

/** An `Issues` that reads nothing and writes nothing, for a runner with no App. */
export const noIssues: Issues = {
  open: async () => [],
  create: async () => null,
  comment: async () => false,
}

/**
 * The App's own credential: a short JWT it signs with its private key.
 *
 * Ten minutes is GitHub's ceiling and five is plenty. `iat` is backdated a minute
 * because GitHub rejects a token whose issue time is in its future, and two
 * machines' clocks are never quite the same — a skew of seconds would otherwise
 * turn into an authentication failure that looks like a bad key.
 *
 * Written with `node:crypto` rather than a JWT library: this is two base64url
 * segments and a signature, and a dependency that has to be audited and updated is
 * a poor trade for thirty lines.
 */
export function appJwt(appId: string, privateKey: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000)
  const segment = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')

  const signingInput =
    segment({ alg: 'RS256', typ: 'JWT' }) +
    '.' +
    segment({ iat: seconds - 60, exp: seconds + 300, iss: appId })

  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey, 'base64url')

  return `${signingInput}.${signature}`
}

interface TokenCache {
  token: string
  /** When it stops being usable, already reduced by the safety margin. */
  usableUntil: number
}

/**
 * How long before a token's stated expiry it is treated as spent.
 *
 * A token that expires mid-request fails the request, and the failure looks like
 * a permissions problem rather than a timing one. Sixty seconds is longer than any
 * call this process makes.
 */
const TOKEN_MARGIN_MS = 60_000

interface GitHubOptions {
  readonly appId: string
  readonly privateKey: string
  readonly log: Log
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
}

/**
 * An `Issues` backed by the real GitHub, authenticating as the App's installation.
 *
 * The token is fetched on demand and cached until shortly before it expires, which
 * is the whole reason an App is cheaper to operate than a token: nothing here has
 * to be rotated, and a key that leaks buys an hour rather than a year.
 */
export function githubIssues(options: GitHubOptions): Issues {
  const doFetch = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const log = options.log

  let cached: TokenCache | undefined
  let installationId: number | undefined

  const asApp = (): Record<string, string> => ({
    authorization: `Bearer ${appJwt(options.appId, options.privateKey, now())}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  })

  const installationToken = async (): Promise<string | undefined> => {
    if (cached !== undefined && cached.usableUntil > now()) return cached.token

    if (installationId === undefined) {
      const response = await doFetch('https://api.github.com/app/installations', {
        headers: asApp(),
      })
      if (!response.ok) {
        // The status and nothing else. A body from GitHub can echo the request,
        // and the request carries the JWT.
        log.error(`could not list the App's installations: ${response.status}`)
        return undefined
      }
      const installs = (await response.json()) as ReadonlyArray<{ id?: number }>
      installationId = installs[0]?.id
      if (installationId === undefined) {
        log.warn('the App is not installed anywhere — nothing will be filed')
        return undefined
      }
    }

    const response = await doFetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      { method: 'POST', headers: asApp() },
    )
    if (!response.ok) {
      log.error(`could not mint an installation token: ${response.status}`)
      // The installation may have been removed. Forgetting it means the next
      // attempt looks it up again rather than retrying a dead id forever.
      installationId = undefined
      return undefined
    }

    const body = (await response.json()) as { token?: string; expires_at?: string }
    if (body.token === undefined) return undefined

    const expiresAt =
      body.expires_at === undefined ? now() + 3_600_000 : Date.parse(body.expires_at)
    cached = { token: body.token, usableUntil: expiresAt - TOKEN_MARGIN_MS }
    return cached.token
  }

  const authed = async (): Promise<Record<string, string> | undefined> => {
    const token = await installationToken()
    if (token === undefined) return undefined
    return {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    }
  }

  return {
    open: async () => {
      const headers = await authed()
      if (headers === undefined) return []

      const found: KnownIssue[] = []
      for (const repository of TRIAGE_REPOSITORIES) {
        const response = await doFetch(
          `https://api.github.com/repos/${repository}/issues?state=open&per_page=100`,
          { headers },
        )
        if (!response.ok) {
          // One unreadable repository must not empty the corpus: a triage run
          // with a partial corpus files a duplicate, which a maintainer closes
          // in a second. One with an empty corpus files a duplicate of
          // *everything*.
          log.warn(`could not read open issues in ${repository}: ${response.status}`)
          continue
        }

        const issues = (await response.json()) as ReadonlyArray<{
          number?: number
          title?: string
          body?: string | null
          html_url?: string
          pull_request?: unknown
        }>

        for (const issue of issues) {
          // `/issues` returns pull requests too, and a pull request is not a
          // report of a problem — matching a ticket to one would point a citizen
          // at somebody's branch.
          if (issue.pull_request !== undefined) continue
          if (
            issue.number === undefined ||
            issue.title === undefined ||
            issue.html_url === undefined
          )
            continue

          found.push({
            repository,
            number: issue.number,
            title: issue.title,
            body: (issue.body ?? '').slice(0, ISSUE_BODY_SAMPLE),
            url: issue.html_url,
          })
        }
      }
      return found
    },

    create: async (issue) => {
      const headers = await authed()
      if (headers === undefined) return null

      const response = await doFetch(`https://api.github.com/repos/${issue.repository}/issues`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: issue.title,
          body: issue.body,
          labels: [...issue.labels],
        }),
      })

      if (!response.ok) {
        log.error(`could not open an issue in ${issue.repository}: ${response.status}`)
        return null
      }

      const body = (await response.json()) as { html_url?: string }
      return body.html_url ?? null
    },

    comment: async (url, body) => {
      const headers = await authed()
      if (headers === undefined) return false

      // The issue's API address, derived from its web address rather than stored.
      // The corpus carries html_url because that is what a citizen can open.
      const match = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(url)
      if (match === null) return false
      const [, owner, repo, number] = match

      const response = await doFetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
        { method: 'POST', headers, body: JSON.stringify({ body }) },
      )
      if (!response.ok) log.warn(`could not comment on ${url}: ${response.status}`)
      return response.ok
    },
  }
}

/**
 * How much of an existing issue's body reaches the model.
 *
 * Enough to tell two issues about the same subsystem apart, and not so much that
 * a hundred open issues become a prompt nothing can read. The title carries most
 * of the signal; the body is there for the cases where two titles are both
 * "verifier is broken".
 */
export const ISSUE_BODY_SAMPLE = 600
