import { createSign } from 'node:crypto'
import type { Log } from './loop.js'
import { reachableFetch, REACHES } from './reachable.js'

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

/**
 * What actually went wrong under a `TypeError: fetch failed`.
 *
 * Undici reports every transport failure with that one message and puts the
 * distinguishing fact — `ENOTFOUND`, `ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT` —
 * on `cause`, sometimes a chain of them. A log line without it says only that
 * the network was involved, which is what the first occurrence of `#586` said
 * and why it could not be told apart from a DNS outage.
 *
 * Bounded at four links: a cause chain is a linked list and this runs inside a
 * catch, where an unbounded walk over hostile input is a second failure on top
 * of the first.
 */
export function transportReason(error: unknown): string {
  const links: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code
    links.push(typeof code === 'string' ? `${current.message} (${code})` : current.message)
    current = (current as { cause?: unknown }).cause
  }
  return links.length === 0 ? String(error) : links.join(' ← ')
}

/** An issue the Colony already has open, as much of it as triage needs. */
export interface KnownIssue {
  readonly repository: string
  readonly number: number
  readonly title: string
  /** Truncated. The corpus is for recognising a match, not for reading. */
  readonly body: string
  readonly url: string
}

/**
 * An issue that has been closed, as much of it as a citizen is owed.
 *
 * **`reason` is GitHub's own, and it is carried rather than interpreted.** An
 * issue closed as `completed` and one closed as `not_planned` are two different
 * endings for the citizen that reported it — the first says the thing it hit is
 * gone, the second says the Colony decided not to act. Collapsing them into one
 * sentence would be the Colony inventing an ending it was not given.
 *
 * There is no closing *comment* here, and that is a limitation worth naming
 * rather than working around: the list endpoint does not carry one, and fetching
 * each issue's comments would be a call per ticket — the cost this whole pass is
 * shaped to avoid. `reason` and the title are what can be had for free, and they
 * are enough to say something true.
 */
export interface ClosedIssue {
  readonly url: string
  readonly title: string
  /** `completed`, `not_planned`, or `null` where GitHub recorded nothing. */
  readonly reason: string | null
  /**
   * When it was closed, or `null` where GitHub recorded nothing.
   *
   * **Read rather than inferred, and it is what stops a fix being reported as a
   * regression** (`#560`). The list endpoint has always carried `closed_at` in
   * the same object as `state_reason`; it was dropped here, so `decide()` had no
   * way to ask whether the lines it was holding were older than the closure.
   * `#557` was filed fifty-eight seconds after `#526` closed, carrying only
   * pre-fix lines, saying *"This came back"*.
   */
  readonly closedAt: string | null
}

/**
 * One reading of what the Colony has open, and **what it could not see**.
 *
 * `Issues.available` was meant to be the whole of this: *without it the loop
 * cannot tell an empty corpus from an unreadable one*. It answers that question
 * for a runner with no App configured, and only for that — it is fixed at
 * construction. A pass that has an App and could not use it lands on the other
 * side of it, answering `[]` and looking exactly like a Colony with nothing
 * open.
 *
 * That happened on 2026-08-13 (`#867`). `github.installations.failed` logged a
 * 500 from GitHub at 14:37:04 (`#868`); two seconds later the debt watcher filed
 * a second copy of an alarm that had been open since 2026-08-11, because the
 * corpus it deduplicated against was empty and nothing said why.
 *
 * So the answer carries its own gaps. **Per repository, not one flag**, because
 * the callers do not want the same thing from it: triage matching a citizen's
 * ticket is better off with two repositories than none, while anything that
 * *files* into a repository it could not read is filing a duplicate.
 */
export interface IssueCorpus {
  readonly issues: readonly KnownIssue[]
  /** Repositories whose listing could not be read on this pass. */
  readonly unreadable: readonly string[]
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
  /**
   * Whether this seam can reach GitHub at all.
   *
   * **Not a nicety: without it the loop cannot tell an empty corpus from an
   * unreadable one**, and those must not be treated the same. With no App
   * configured, `open()` answers `[]` — and a model shown no open issues cannot
   * conclude `known` about a ticket that *is* already known. It would hold it for
   * a human or propose filing a duplicate, on a real citizen's report, which is
   * the noise this service exists to remove.
   *
   * So a runner with no App does not triage. That is a stronger promise than
   * degrading, and it is the honest one: the state before this service existed
   * was tickets nobody read, not tickets somebody guessed at.
   */
  readonly available: boolean
  /**
   * Every open issue across the repositories triage covers, and the ones that
   * could not be read this pass.
   *
   * `available` is the same question asked once, at construction; this is it
   * asked again on every pass, which is where a 500 arrives (`#867`).
   */
  open(): Promise<IssueCorpus>
  /**
   * Recently closed issues, most recently touched first (#165).
   *
   * **Sorted by update time, not by number, and that is what bounds it.** The
   * default order is newest-created-first, under which an old issue closed today
   * sits behind every issue opened since — so the one event this read exists to
   * notice is the one that falls off the page. Sorting by `updated` puts a
   * just-closed issue at the front whatever its age.
   *
   * One page per repository. At the half-hour tick in `loop.ts` that is a
   * hundred issues touched between two passes before anything could be missed,
   * and a Colony moving that fast has a louder problem than a late ticket.
   */
  closed(): Promise<readonly ClosedIssue[]>
  /** File one. Answers the URL, or `null` when GitHub refused. */
  create(issue: NewIssue): Promise<string | null>
  /** Say on an existing issue that another citizen reported the same thing. */
  comment(url: string, body: string): Promise<boolean>
  /**
   * Close one, saying why (`#720`).
   *
   * **The log detector must never call this and does not**, and the rule it
   * follows is unchanged: whether a defect in the logs is dealt with is a
   * person's call, because a model's reading of an error is a finding rather
   * than a measurement. What may close itself is an alarm whose **condition** is
   * measured and has a precise end — the shape Health Watch already has in
   * `kolonie-infra`, where an issue about unhealthy containers closes when the
   * host reports every container healthy again.
   *
   * The comment goes first and the close second, so an issue never ends without
   * saying what ended it.
   */
  close(url: string, comment: string): Promise<boolean>
}

/** An `Issues` that reads nothing and writes nothing, for a runner with no App. */
export const noIssues: Issues = {
  available: false,
  // Nothing read, and every repository named as unread rather than left out —
  // `[]` with an empty gap list would be this seam claiming the Colony has
  // nothing open. Callers check `available` first, so nothing depends on it;
  // saying it anyway is what stops the next caller depending on the wrong one.
  open: async () => ({ issues: [], unreadable: [...TRIAGE_REPOSITORIES] }),
  // Empty for the same reason `open` is, and it matters in the same way: a seam
  // that reads nothing must not be read as *nothing is closed*. The caller
  // checks `available` before it acts on either.
  closed: async () => [],
  create: async () => null,
  comment: async () => false,
  close: async () => false,
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
  const doFetch = reachableFetch(REACHES.github, options.fetchImpl ?? fetch)
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
        log.error(`could not list the App's installations: ${response.status}`, undefined, {
          event: 'github.installations.failed',
          status: response.status,
        })
        return undefined
      }
      const installs = (await response.json()) as ReadonlyArray<{ id?: number }>
      installationId = installs[0]?.id
      if (installationId === undefined) {
        log.warn('the App is not installed anywhere — nothing will be filed', {
          event: 'github.not-installed',
        })
        return undefined
      }
    }

    const response = await doFetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      { method: 'POST', headers: asApp() },
    )
    if (!response.ok) {
      log.error(`could not mint an installation token: ${response.status}`, undefined, {
        event: 'github.token.failed',
        status: response.status,
      })
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

  /**
   * One repository's issue listing, or `undefined` where it could not be read.
   *
   * **A transport failure is treated exactly as an unreadable status is**, and
   * that is the whole of this helper. Both listings already refused to let one
   * repository decide the answer for all three — but only for a response that
   * arrived. A `fetch` that *throws* escaped that care, out through `reconcile`
   * and into `reconcile.failed`, taking the two repositories that had not been
   * read yet and the settling loop that had not run yet with it.
   *
   * Measured once, 2026-08-08 at 17:03:27Z (`#586`): `TypeError: fetch failed`
   * at `Object.closed`, `poll.done` in the same second, and **no listing warning
   * before it** — which is how the stack proves it was the repository call and
   * not the token call.
   *
   * **Warned rather than raised, and the line is deliberate.** A status says
   * something about the App — its installation, its permissions, a repository
   * that moved — and it is a maintainer's to fix. A throw says something about
   * the network during one tick, and the next tick is half an hour away; the
   * ticket stays `acknowledged`, which is still true, and the citizen is told
   * nothing wrong in the meantime.
   *
   * **The cause is carried** because `TypeError: fetch failed` on its own does
   * not distinguish a DNS answer from a reset connection from a connect
   * timeout, and the first occurrence could not be diagnosed for exactly that
   * reason: `Log`'s error shape keeps `name`, `message` and `stack`, and drops
   * `cause`. Serialising it here rather than there, because that shape is
   * shared by every service and this is one call site's problem.
   */
  const listing = async (
    repository: string,
    state: 'open' | 'closed',
    url: string,
    headers: Record<string, string>,
  ): Promise<readonly unknown[] | undefined> => {
    const unreadable = (why: string, fields: Record<string, unknown>): undefined => {
      log.warn(`could not read ${state} issues in ${repository}: ${why}`, {
        event: 'github.issues.read.failed',
        repository,
        state,
        ...fields,
      })
      return undefined
    }

    const response = await doFetch(url, { headers }).catch((error: unknown) =>
      unreadable(transportReason(error), { status: null, reason: transportReason(error) }),
    )
    if (response === undefined) return undefined
    if (!response.ok) return unreadable(String(response.status), { status: response.status })

    // A body that stops arriving half way through fails here rather than above,
    // and it is the same fact about the network with the same remedy.
    const body = await response.json().catch((error: unknown) =>
      unreadable(transportReason(error), {
        status: response.status,
        reason: transportReason(error),
      }),
    )
    return Array.isArray(body) ? (body as readonly unknown[]) : undefined
  }

  return {
    available: true,
    open: async () => {
      const headers = await authed()
      // No token this pass. Every repository is unread, and the reason is
      // already in the log as `github.installations.failed` or
      // `github.token.failed` — what was missing was anybody downstream being
      // able to tell that from a quiet Colony (`#867`).
      if (headers === undefined) return { issues: [], unreadable: [...TRIAGE_REPOSITORIES] }

      const found: KnownIssue[] = []
      const unreadable: string[] = []
      for (const repository of TRIAGE_REPOSITORIES) {
        // One unreadable repository must not empty the corpus: a triage run
        // with a partial corpus files a duplicate, which a maintainer closes
        // in a second. One with an empty corpus files a duplicate of
        // *everything*. `listing` holds that for a throw as well as a status.
        //
        // It is *named* as well as skipped, because that trade is triage's and
        // not everybody's — a caller that files into this repository would be
        // filing against a corpus with the matching issue missing from it.
        const read = await listing(
          repository,
          'open',
          `https://api.github.com/repos/${repository}/issues?state=open&per_page=100`,
          headers,
        )
        if (read === undefined) {
          unreadable.push(repository)
          continue
        }

        const issues = read as ReadonlyArray<{
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
      return { issues: found, unreadable }
    },

    closed: async () => {
      const headers = await authed()
      if (headers === undefined) return []

      const found: ClosedIssue[] = []
      for (const repository of TRIAGE_REPOSITORIES) {
        // One unreadable repository costs the tickets pointing into it another
        // half hour, and nothing else: the next tick asks again, and a ticket
        // that stays `acknowledged` is telling the citizen the truth in the
        // meantime. Warn rather than throw, so the other two are still read —
        // which is what `listing` now also holds for a `fetch` that throws.
        const read = await listing(
          repository,
          'closed',
          `https://api.github.com/repos/${repository}/issues` +
            `?state=closed&sort=updated&direction=desc&per_page=100`,
          headers,
        )
        if (read === undefined) continue

        const issues = read as ReadonlyArray<{
          title?: string
          html_url?: string
          state_reason?: string | null
          closed_at?: string | null
          pull_request?: unknown
        }>

        for (const issue of issues) {
          // A merged pull request is not a citizen's ticket ending, for the same
          // reason `open` skips them: no ticket was ever matched to one.
          if (issue.pull_request !== undefined) continue
          if (issue.title === undefined || issue.html_url === undefined) continue

          found.push({
            url: issue.html_url,
            title: issue.title,
            reason: issue.state_reason ?? null,
            closedAt: issue.closed_at ?? null,
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
        log.error(`could not open an issue in ${issue.repository}: ${response.status}`, undefined, {
          event: 'github.issue.create.failed',
          repository: issue.repository,
          status: response.status,
        })
        return null
      }

      const body = (await response.json()) as { html_url?: string }
      return body.html_url ?? null
    },

    comment: async (url, body) => {
      const headers = await authed()
      if (headers === undefined) return false

      const at = issueApiPath(url)
      if (at === undefined) return false

      const response = await doFetch(`${at}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body }),
      })
      if (!response.ok)
        log.warn(`could not comment on ${url}: ${response.status}`, {
          event: 'github.comment.failed',
          url,
          status: response.status,
        })
      return response.ok
    },

    close: async (url, body) => {
      const headers = await authed()
      if (headers === undefined) return false

      const at = issueApiPath(url)
      if (at === undefined) return false

      /**
       * **The comment first, and the close only if it landed.** An issue that
       * closes without saying what ended it is an issue whose reader has to
       * guess, and the guess a person makes about a machine-closed alarm is that
       * somebody closed it by hand. Failing the other way round costs a comment
       * on a still-open issue, which the next pass simply supersedes.
       */
      const said = await doFetch(`${at}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body }),
      })
      if (!said.ok) {
        log.warn(`could not say why ${url} is being closed: ${said.status}`, {
          event: 'github.close.comment.failed',
          url,
          status: said.status,
        })
        return false
      }

      const response = await doFetch(at, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
      })
      if (!response.ok)
        log.warn(`could not close ${url}: ${response.status}`, {
          event: 'github.close.failed',
          url,
          status: response.status,
        })
      return response.ok
    },
  }
}

/**
 * An issue's API address, derived from its web address rather than stored.
 *
 * The corpus carries `html_url` because that is what a citizen can open.
 * `undefined` for anything that is not one, which is how a malformed URL becomes
 * a refusal to act rather than a request to a guessed path.
 */
function issueApiPath(url: string): string | undefined {
  const match = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(url)
  if (match === null) return undefined
  const [, owner, repo, number] = match
  return `https://api.github.com/repos/${owner}/${repo}/issues/${number}`
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
