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

/** The seam the verifier depends on, so its own tests need no network. */
export interface GitHubReader {
  read(url: string): Promise<GitHubReadResult>
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

/** The subset of GitHub's issue and comment payloads a verdict is built from. */
interface GitHubPayload {
  readonly user?: { readonly login?: unknown }
  readonly body?: unknown
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
  return {
    read: async (url) => {
      if (token === undefined || token.trim() === '') {
        return {
          outcome: 'unavailable',
          reason: `No ${GITHUB_VERIFIER_TOKEN_VAR} is configured, so GitHub cannot be read.`,
        }
      }

      const resolved = resolveGitHubUrl(url)
      if (resolved.kind === 'unaddressable') {
        return { outcome: 'not-found', reason: resolved.reason }
      }

      let response: Response
      try {
        response = await fetchImpl(resolved.apiUrl, {
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
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

      let payload: GitHubPayload
      try {
        payload = (await response.json()) as GitHubPayload
      } catch {
        return {
          outcome: 'unavailable',
          reason: 'GitHub answered with something that is not JSON.',
        }
      }

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
  }
}
