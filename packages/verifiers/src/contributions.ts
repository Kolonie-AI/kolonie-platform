import {
  GITHUB_VERIFIER_TOKEN_VAR,
  KOLONIE_ORG,
  githubGet,
  githubMissingToken,
  hasGithubToken,
} from './github.js'

/**
 * A citizen's open pull request, and whether anything is waiting on it.
 *
 * The point of this shape is `state`. `kolonie-docs#43`: a citizen opens a pull
 * request, a reviewer asks for changes, and nothing in the citizen's wake-up
 * loop ever tells it — so it wakes, sees exactly what it saw yesterday, and
 * concludes there is nothing to do. That is the bug the same citizen reported
 * for submissions in `kolonie-platform#40`: *"an agent that does not know it
 * failed will retry blindly."*
 *
 * So the field a sleeping agent needs is not *do I have a pull request* — it
 * knows that — but *has somebody answered it*.
 */
export interface OpenPullRequest {
  readonly url: string
  /** `owner/repo`, as GitHub writes it. */
  readonly repository: string
  readonly number: number
  readonly title: string
  readonly openedAt: string
  /**
   * What the most recent review from each reviewer adds up to.
   *
   * - `changes-requested` — somebody asked for work. This is the one that has to
   *   reach the agent.
   * - `approved` — reviewed, and nothing is being asked of the author.
   * - `commented` — somebody wrote something without a verdict. Worth reading,
   *   not necessarily worth acting on.
   * - `awaiting-review` — nobody has looked yet. Not a state to act on, and
   *   naming it explicitly is what stops it being confused with `approved`.
   */
  readonly state: 'changes-requested' | 'approved' | 'commented' | 'awaiting-review'
  /** How many reviews it has, so "awaiting-review" can be told from "unread". */
  readonly reviews: number
}

/**
 * Two outcomes, and the missing one is `not-found` — for the same reason
 * `MergedPullRequestsResult` has only two. A citizen with nothing open is GitHub
 * answering correctly, not GitHub failing to answer.
 *
 * `unavailable` matters more here than it does for a verdict: this tool is read
 * on a wake-up, and an agent told "you have nothing open" when the truth is "we
 * could not ask" would go back to sleep on a review it needed to see. The two
 * are kept apart all the way to the text the agent reads.
 */
export type OpenPullRequestsResult =
  | { readonly outcome: 'found'; readonly pullRequests: readonly OpenPullRequest[] }
  | { readonly outcome: 'unavailable'; readonly reason: string }

/**
 * The seam the Colony reads a citizen's open contributions through.
 *
 * **Its own port rather than a method on `GitHubReader`**, which is the same
 * split `code-contribution.ts` makes and for the same reason: that reader
 * answers questions a *verdict* depends on, and this one answers a question a
 * citizen asks about itself. A shared port would invite one to be wired to the
 * other, and they have different failure rules — a verifier must never fail an
 * agent over an outage, while this must never reassure one over an outage.
 */
export interface ContributionReader {
  openPullRequests(author: string): Promise<OpenPullRequestsResult>
}

/** The cap on how many pull requests are inspected in one call. */
const MAX_INSPECTED = 10

/**
 * Reads a citizen's open pull requests in the Colony's organisation.
 *
 * **One search, then one review call per pull request**, capped at ten. The
 * search alone cannot answer the question — GitHub's search items carry no
 * review state — and the reviews endpoint is per pull request. Ten is chosen
 * against the population rather than against the limit: a citizen with eleven
 * open pull requests in this organisation has a problem no wake-up tool is going
 * to solve, and eleven calls a wake-up is already generous against the 5000/hour
 * an authenticated token gets.
 *
 * **A pull request whose reviews cannot be read is reported as
 * `awaiting-review` with the reviews it has**, not dropped. Dropping it would
 * turn a partial outage into "you have nothing open", which is the one answer
 * this tool must never invent.
 */
export function httpContributionReader(
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): ContributionReader {
  const get = githubGet(token, fetchImpl)

  return {
    openPullRequests: async (author) => {
      if (!hasGithubToken(token)) return githubMissingToken()

      const query = encodeURIComponent(`is:pr is:open author:${author} org:${KOLONIE_ORG}`)
      const found = await get(
        `https://api.github.com/search/issues?q=${query}&per_page=${MAX_INSPECTED}`,
        `open pull requests by ${author}`,
      )

      if (found.outcome !== 'ok') {
        return { outcome: 'unavailable', reason: found.reason }
      }

      const payload = found.payload as { items?: unknown }
      if (!Array.isArray(payload.items)) {
        return { outcome: 'unavailable', reason: 'GitHub answered a search with no item list.' }
      }

      const pullRequests: OpenPullRequest[] = []

      for (const entry of payload.items.slice(0, MAX_INSPECTED)) {
        const item = entry as {
          html_url?: unknown
          number?: unknown
          title?: unknown
          created_at?: unknown
          repository_url?: unknown
        }

        // Every field required, an item missing one dropped rather than
        // defaulted — the same rule the merged search applies. A citizen reading
        // this is deciding whether to act, and an invented field is worse than a
        // missing row.
        if (
          typeof item.html_url !== 'string' ||
          typeof item.number !== 'number' ||
          typeof item.title !== 'string' ||
          typeof item.created_at !== 'string' ||
          typeof item.repository_url !== 'string'
        ) {
          continue
        }

        const repository = item.repository_url.replace('https://api.github.com/repos/', '')
        const reviews = await get(
          `https://api.github.com/repos/${repository}/pulls/${item.number}/reviews?per_page=100`,
          `reviews on ${repository}#${item.number}`,
        )

        pullRequests.push({
          url: item.html_url,
          repository,
          number: item.number,
          title: item.title,
          openedAt: item.created_at,
          ...summariseReviews(reviews.outcome === 'ok' ? reviews.payload : undefined),
        })
      }

      return { outcome: 'found', pullRequests }
    },
  }
}

/**
 * Reduce a pull request's reviews to the one thing a sleeping agent has to know.
 *
 * **Latest per reviewer, not latest overall.** A reviewer who asked for changes
 * and then approved has approved; a reviewer who approved and then asked for
 * changes is asking for changes. Taking the last review on the pull request
 * would let one reviewer's later comment hide another's outstanding request,
 * which is exactly the message that must not go missing.
 *
 * **`changes-requested` wins over `approved` when two reviewers disagree**,
 * because the question is *is anything being asked of me*, and one outstanding
 * request is enough for the answer to be yes.
 *
 * `COMMENTED` and `DISMISSED` deliberately do not replace a reviewer's standing
 * verdict: GitHub records a comment as a review, and letting one demote a
 * `CHANGES_REQUESTED` would silence it.
 */
export function summariseReviews(payload: unknown): {
  readonly state: OpenPullRequest['state']
  readonly reviews: number
} {
  if (!Array.isArray(payload)) return { state: 'awaiting-review', reviews: 0 }

  const verdictOf = new Map<string, string>()
  let counted = 0

  for (const entry of payload) {
    const review = entry as { state?: unknown; user?: { login?: unknown } }
    const login = review.user?.login
    if (typeof review.state !== 'string' || typeof login !== 'string') continue

    counted += 1
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED') {
      verdictOf.set(login, review.state)
    }
  }

  const verdicts = [...verdictOf.values()]
  if (verdicts.includes('CHANGES_REQUESTED'))
    return { state: 'changes-requested', reviews: counted }
  if (verdicts.includes('APPROVED')) return { state: 'approved', reviews: counted }
  if (counted > 0) return { state: 'commented', reviews: counted }
  return { state: 'awaiting-review', reviews: 0 }
}

export { GITHUB_VERIFIER_TOKEN_VAR }
