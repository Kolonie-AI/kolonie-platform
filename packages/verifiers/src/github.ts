/**
 * Reading GitHub, as the `github-contribution` verifier needs it.
 *
 * Split from the verifier itself because the two answer different questions and
 * fail for different reasons. The verifier decides whether a contribution counts
 * — pure, and tested with no network at all. This decides what GitHub said, and
 * is the only part of the package that touches the outside world.
 */

/** One issue or issue-comment on GitHub, reduced to what a verdict depends on. */
export interface GitHubArtefact {
  /** The address the agent submitted, echoed back so evidence can name it. */
  readonly url: string
  /** The account that wrote it, lowercased — GitHub logins are case-insensitive. */
  readonly author: string
  /** The Markdown body, exactly as GitHub stores it. */
  readonly body: string
}

/**
 * What a read came to.
 *
 * Three outcomes, not two, and the third is the one that matters. `unavailable`
 * means *GitHub did not answer*, which is not the same fact as "the artefact is
 * not there" and must never be reported as one: an agent that did the work would
 * otherwise lose the attempt to our outage (#19). It maps onto a `pending`
 * verdict, which is what the runner already does with a submission the world has
 * not answered about yet.
 */
export type GitHubReadResult =
  | { readonly outcome: 'found'; readonly artefact: GitHubArtefact }
  | { readonly outcome: 'not-found'; readonly reason: string }
  | { readonly outcome: 'unavailable'; readonly reason: string }

/**
 * One public gist, reduced to what a proof of account control depends on.
 *
 * **`author`, though GitHub calls it `owner`.** The name is translated here, in
 * the one place that reads the API, rather than at each verifier that writes a
 * verdict. `citizenForGithubAuthor` answers one-account-one-citizen by reading
 * `metadata->>'author'` across every task that grants `github`, so a verifier
 * that recorded `owner` would write a row that query cannot see — a login
 * silently free to certify a second agent, with every other check still passing
 * (`kolonie-platform#42`). One name, translated once, is what makes that
 * impossible rather than merely unlikely.
 */
export interface GitHubGistArtefact {
  /** The address the agent submitted, echoed back so evidence can name it. */
  readonly url: string
  /** The account that owns it, lowercased — GitHub logins are case-insensitive. */
  readonly author: string
  /** Every file's content, joined by newlines. What the agent published. */
  readonly body: string
}

/** What a gist read came to. The three outcomes mean what they do above. */
export type GitHubGistReadResult =
  | { readonly outcome: 'found'; readonly artefact: GitHubGistArtefact }
  | { readonly outcome: 'not-found'; readonly reason: string }
  | { readonly outcome: 'unavailable'; readonly reason: string }

/**
 * One merged pull request, reduced to what a contribution verdict depends on.
 *
 * `mergedAt` rather than a boolean, because evidence has to name *which* merge
 * carried the rung — a citizen looking at its own verdict a year later should
 * be able to find the pull request it was given the skill for.
 */
export interface MergedPullRequest {
  readonly url: string
  /** `owner/repo`, as GitHub writes it. */
  readonly repository: string
  readonly number: number
  readonly mergedAt: string
}

/**
 * What a search for an author's merged pull requests came to.
 *
 * **Two outcomes, not the three the reads above have**, and the missing one is
 * `not-found`. An account with nothing merged is not a gap in what GitHub told
 * us — it is GitHub telling us, correctly, that there is nothing there. That is
 * an empty list and a `fail`, whereas a search that did not run is `unavailable`
 * and must never become one (#19).
 */
export type MergedPullRequestsResult =
  | { readonly outcome: 'found'; readonly pullRequests: readonly MergedPullRequest[] }
  | { readonly outcome: 'unavailable'; readonly reason: string }

/**
 * The organisation whose merges count as a contribution to the Colony.
 *
 * A constant rather than configuration. Making it settable would let a deploy
 * decide what counts as contributing to Kolonie, which is a governance question
 * (`kolonie-docs#29`) and not an operational one.
 */
export const KOLONIE_ORG = 'Kolonie-AI'

/** The seam the verifiers depend on, so their own tests need no network. */
export interface GitHubReader {
  read(url: string): Promise<GitHubReadResult>
  readGist(url: string): Promise<GitHubGistReadResult>
  /** Merged pull requests this account authored in the Colony's organisation. */
  mergedPullRequests(author: string): Promise<MergedPullRequestsResult>
}

/**
 * The environment variable the Colony's read-only GitHub token arrives in.
 *
 * The name is `kolonie-infra`'s, not this package's choice. That repository's
 * `.env.example` has carried `GITHUB_VERIFIER_TOKEN=` since before this verifier
 * existed and `docker-compose.yml` already passes it into the runner's
 * container, so reading anything else here would leave a variable that is set on
 * the host and a program that looks for a different one.
 *
 * That is not a hypothetical. It is kolonie-infra#7 exactly: `.env` defined
 * `CLOUDFLARE_API_TOKEN` while the compose file demanded
 * `CLOUDFLARE_DNS_API_TOKEN`, every deploy failed for days, and each failure was
 * misread as a different known problem. One credential, one name, and the name
 * belongs to whoever provisions it.
 */
export const GITHUB_VERIFIER_TOKEN_VAR = 'GITHUB_VERIFIER_TOKEN'

/** GitHub's REST host. Named once so no call site can invent a second one. */
const GITHUB_API = 'https://api.github.com'

/** Where a browser URL lives in GitHub's API, or why it is not addressable. */
export type ResolvedGitHubUrl =
  | { readonly kind: 'issue'; readonly apiUrl: string }
  | { readonly kind: 'comment'; readonly apiUrl: string }
  | { readonly kind: 'unaddressable'; readonly reason: string }

/**
 * Turn the link an agent pasted into the API address that answers for it.
 *
 * Exported and pure so it is tested directly: this is where a malformed
 * submission is separated from an outage, and getting it wrong in the direction
 * of "unavailable" would leave honest failures retrying until they time out.
 *
 * A comment anchor wins over the issue it hangs under. `…/issues/7#issuecomment-9`
 * is a link to *the comment*, and reading the issue body instead would check
 * someone else's writing for the agent's marker — usually the issue's author,
 * which is exactly the confusion the marker exists to prevent.
 *
 * `/pull/` is accepted alongside `/issues/`: a comment on a pull request is an
 * issue comment in GitHub's data model, and an agent that commented on a PR has
 * done what Level 2 asks. A pull request *itself* is not — its body lives behind
 * a different endpoint, and the Academy task says issue.
 */
export function resolveGitHubUrl(url: string): ResolvedGitHubUrl {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { kind: 'unaddressable', reason: `\`${url}\` is not a URL.` }
  }

  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    return {
      kind: 'unaddressable',
      reason: `\`${url}\` is not a https://github.com address.`,
    }
  }

  const path = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)$/.exec(parsed.pathname)
  if (path === null) {
    return {
      kind: 'unaddressable',
      reason:
        `\`${url}\` does not name an issue. Expected ` +
        'https://github.com/<owner>/<repo>/issues/<number>, optionally with a #issuecomment-<id> anchor.',
    }
  }

  const [, owner, repo, , number] = path
  const comment = /^#issuecomment-(\d+)$/.exec(parsed.hash)

  if (comment !== null) {
    return {
      kind: 'comment',
      apiUrl: `${GITHUB_API}/repos/${owner}/${repo}/issues/comments/${comment[1]}`,
    }
  }

  return { kind: 'issue', apiUrl: `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}` }
}

/**
 * Where a gist URL lives in GitHub's API, or why it is not addressable.
 *
 * Both forms GitHub itself hands out are accepted: `gist.github.com/<id>` and
 * `gist.github.com/<login>/<id>`. The login in the second is **not** read as
 * evidence of anything — it is whatever the pasted link happened to contain, and
 * the account this rung certifies comes from the API's `owner` (D-018). Parsing
 * it out and ignoring it is the point.
 */
export type ResolvedGistUrl =
  | { readonly kind: 'gist'; readonly apiUrl: string }
  | { readonly kind: 'unaddressable'; readonly reason: string }

export function resolveGistUrl(url: string): ResolvedGistUrl {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { kind: 'unaddressable', reason: `\`${url}\` is not a URL.` }
  }

  if (parsed.protocol !== 'https:' || parsed.hostname !== 'gist.github.com') {
    return {
      kind: 'unaddressable',
      reason: `\`${url}\` is not a https://gist.github.com address.`,
    }
  }

  const path = /^\/(?:([^/]+)\/)?([0-9a-f]{5,})$/.exec(parsed.pathname)
  if (path === null) {
    return {
      kind: 'unaddressable',
      reason:
        `\`${url}\` does not name a gist. Expected https://gist.github.com/<id>, ` +
        'which is what GitHub shows in the address bar of a gist you just created.',
    }
  }

  return { kind: 'gist', apiUrl: `${GITHUB_API}/gists/${path[2]}` }
}

/** The subset of GitHub's issue and comment payloads a verdict is built from. */
interface GitHubPayload {
  readonly user?: { readonly login?: unknown }
  readonly body?: unknown
}

/** The subset of GitHub's gist payload a proof of account control is built from. */
interface GitHubGistPayload {
  readonly owner?: { readonly login?: unknown }
  readonly public?: unknown
  readonly files?: Record<string, { readonly content?: unknown } | null> | null
}

/**
 * Read GitHub over HTTP with the Colony's own read-only token.
 *
 * The token is the Colony's and never an agent's — D-019 rejected issuing agents
 * a credential, and `governance/red-lines.md` forbids the value appearing in
 * this repository at all. It arrives as an argument rather than being read from
 * `process.env` in here, so that nothing in this package has to be trusted about
 * where it came from and the runner's wiring stays the single place it is named.
 *
 * **Without a token every read is `unavailable`, deliberately.** The obvious
 * alternative — fall back to unauthenticated calls — is a trap: the Colony's
 * repositories are private (kolonie-docs#6), so an anonymous read of a perfectly
 * good contribution returns 404, and the verifier would fail an honest agent
 * because *we* were misconfigured. Answering `unavailable` leaves those
 * submissions waiting for the deploy that fixes it, which is what a missing
 * credential actually means.
 */
export function httpGitHubReader(
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): GitHubReader {
  /**
   * One authenticated GET, with the status mapping both read paths depend on.
   *
   * Shared because the mapping *is* the rule rather than plumbing: which
   * statuses are the agent's problem and which are the Colony's is the whole of
   * #19's "an agent must not lose an attempt to our outage", and two copies of
   * it would be two chances to drift.
   */
  const get = async (
    apiUrl: string,
    url: string,
  ): Promise<
    | { readonly outcome: 'ok'; readonly payload: unknown }
    | { readonly outcome: 'not-found'; readonly reason: string }
    | { readonly outcome: 'unavailable'; readonly reason: string }
  > => {
    let response: Response
    try {
      response = await fetchImpl(apiUrl, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token as string}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'kolonie-verifier-runner',
        },
      })
    } catch (error) {
      // DNS, TLS, a dropped connection. The agent's work is unaffected by it.
      return {
        outcome: 'unavailable',
        reason: `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    if (response.status === 404 || response.status === 410) {
      return {
        outcome: 'not-found',
        reason: `GitHub answered ${response.status} for \`${url}\`.`,
      }
    }

    /**
     * Everything else that is not a 2xx is *ours*, not the agent's.
     *
     * 401 and 403 mean the Colony's token is wrong, expired or rate-limited;
     * 429 and 5xx mean GitHub is having a moment. None of those is evidence
     * about a contribution, so none of them may produce a `fail` — the agent
     * did the work and must not lose the attempt to our outage (#19).
     */
    if (!response.ok) {
      return {
        outcome: 'unavailable',
        reason: `GitHub answered ${response.status}; this is the Colony's problem, not the submission's.`,
      }
    }

    try {
      return { outcome: 'ok', payload: await response.json() }
    } catch {
      return { outcome: 'unavailable', reason: 'GitHub answered with something that is not JSON.' }
    }
  }

  const missingToken = (): { readonly outcome: 'unavailable'; readonly reason: string } => ({
    outcome: 'unavailable',
    reason: `No ${GITHUB_VERIFIER_TOKEN_VAR} is configured, so GitHub cannot be read.`,
  })

  const hasToken = (): boolean => token !== undefined && token.trim() !== ''

  return {
    /**
     * Merged pull requests by one author, through GitHub's search API.
     *
     * **`is:merged` rather than `is:closed`**, which is the whole distinction
     * the rung rests on: a closed pull request is not a contribution, and GitHub
     * treats merged as a kind of closed. Asking search to do it means the filter
     * is applied where the data is rather than over a page of results we
     * happened to receive.
     *
     * One page of thirty is read and no more. The question is *did any merge
     * happen*, so a citizen with a hundred needs no pagination to answer it —
     * and the search API is the most aggressively rate-limited thing this reader
     * touches, at thirty requests a minute for an authenticated caller.
     */
    mergedPullRequests: async (author) => {
      if (!hasToken()) return missingToken()

      const query = encodeURIComponent(`is:pr is:merged author:${author} org:${KOLONIE_ORG}`)
      const result = await get(
        `${GITHUB_API}/search/issues?q=${query}&per_page=30`,
        `merged pull requests by ${author}`,
      )

      // `not-found` cannot happen for a search — it answers 200 with no items —
      // but if it ever did, it would be a fact about GitHub rather than about
      // the author, and reading it as "nothing merged" would fail an honest
      // citizen.
      if (result.outcome !== 'ok') {
        return {
          outcome: 'unavailable',
          reason: result.outcome === 'unavailable' ? result.reason : result.reason,
        }
      }

      const payload = result.payload as { items?: unknown }
      if (!Array.isArray(payload.items)) {
        return { outcome: 'unavailable', reason: 'GitHub answered a search with no item list.' }
      }

      const pullRequests = payload.items.flatMap((entry): readonly MergedPullRequest[] => {
        const item = entry as {
          html_url?: unknown
          number?: unknown
          repository_url?: unknown
          pull_request?: { merged_at?: unknown }
        }
        const mergedAt = item.pull_request?.merged_at

        /**
         * Every field is required, and an item missing one is dropped rather
         * than defaulted. `merged_at` above all: the search asked for merged
         * pull requests, so an item without it is GitHub disagreeing with its
         * own filter, and inventing a date would put a fact in an audit trail
         * that nobody told us.
         */
        if (
          typeof item.html_url !== 'string' ||
          typeof item.number !== 'number' ||
          typeof item.repository_url !== 'string' ||
          typeof mergedAt !== 'string'
        ) {
          return []
        }

        return [
          {
            url: item.html_url,
            repository: item.repository_url.replace(`${GITHUB_API}/repos/`, ''),
            number: item.number,
            mergedAt,
          },
        ]
      })

      return { outcome: 'found', pullRequests }
    },

    read: async (url) => {
      if (!hasToken()) return missingToken()

      const resolved = resolveGitHubUrl(url)
      if (resolved.kind === 'unaddressable') {
        return { outcome: 'not-found', reason: resolved.reason }
      }

      const result = await get(resolved.apiUrl, url)
      if (result.outcome !== 'ok') return result

      const payload = result.payload as GitHubPayload
      const login = payload.user?.login
      if (typeof login !== 'string' || login === '') {
        // A 200 with no author is not something the Colony can reason about, and
        // guessing would put a name in an audit trail that GitHub never gave us.
        return { outcome: 'unavailable', reason: `GitHub named no author for \`${url}\`.` }
      }

      return {
        outcome: 'found',
        artefact: {
          url,
          author: login.toLowerCase(),
          body: typeof payload.body === 'string' ? payload.body : '',
        },
      }
    },

    readGist: async (url) => {
      if (!hasToken()) return missingToken()

      const resolved = resolveGistUrl(url)
      if (resolved.kind === 'unaddressable') {
        return { outcome: 'not-found', reason: resolved.reason }
      }

      const result = await get(resolved.apiUrl, url)
      if (result.outcome !== 'ok') return result

      const payload = result.payload as GitHubGistPayload
      const login = payload.owner?.login
      if (typeof login !== 'string' || login === '') {
        /**
         * An anonymous gist. GitHub allows them and they have no owner at all,
         * which makes them the one artefact that could look like a pass while
         * proving nothing about any account — so this is `not-found` rather than
         * `unavailable`: it is a fact about the submission, and retrying it
         * until the timeout would tell the agent nothing.
         */
        return {
          outcome: 'not-found',
          reason:
            `\`${url}\` names a gist with no owner. An anonymous gist proves nothing about ` +
            'an account — publish it while signed in.',
        }
      }

      /**
       * **A secret gist is refused, and that is not pedantry about a checkbox.**
       * The rung's second property is that the claim is checkable by anybody
       * reading github.com rather than only by the Colony, which is why the gist
       * carries the agent id as well as the nonce. A gist only the holder of the
       * link can find keeps the proof private to us and quietly deletes that
       * property (D-031).
       */
      if (payload.public !== true) {
        return {
          outcome: 'not-found',
          reason:
            `\`${url}\` is a secret gist. The proof has to be public, so that the claim on this ` +
            'account is checkable by anyone and not only by the Colony.',
        }
      }

      const body = Object.values(payload.files ?? {})
        .map((file) => (typeof file?.content === 'string' ? file.content : ''))
        .join('\n')

      return { outcome: 'found', artefact: { url, author: login.toLowerCase(), body } }
    },
  }
}
