import { describe, expect, it } from 'vitest'
import {
  GITHUB_VERIFIER_TOKEN_VAR,
  httpGitHubReader,
  resolveGistUrl,
  resolveGitHubUrl,
} from './github.js'

const ISSUE = 'https://github.com/Kolonie-AI/kolonie-docs/issues/42'
const COMMENT = `${ISSUE}#issuecomment-987654`

/** A token shaped like one and belonging to nobody. Never a real credential (#19). */
const TOKEN = 'test-token-not-a-credential'

/** A `fetch` that answers once, without a socket in sight. */
const answering = (
  status: number,
  body: unknown = {},
): { fetch: typeof fetch; calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    fetch: (async (url: string) => {
      calls.push(String(url))
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response
    }) as unknown as typeof fetch,
  }
}

describe('resolveGitHubUrl', () => {
  it('addresses an issue through the repository endpoint', () => {
    expect(resolveGitHubUrl(ISSUE)).toEqual({
      kind: 'issue',
      apiUrl: 'https://api.github.com/repos/Kolonie-AI/kolonie-docs/issues/42',
    })
  })

  it('lets a comment anchor win over the issue it hangs under', () => {
    // Reading the issue body for a comment link would check the *issue author's*
    // writing for the submitting agent's marker — precisely the confusion the
    // marker exists to prevent.
    expect(resolveGitHubUrl(COMMENT)).toEqual({
      kind: 'comment',
      apiUrl: 'https://api.github.com/repos/Kolonie-AI/kolonie-docs/issues/comments/987654',
    })
  })

  it('accepts a comment on a pull request', () => {
    // An issue comment in GitHub's data model, and a contribution by any
    // reasonable reading of what Level 2 asks for.
    const onAPullRequest = 'https://github.com/Kolonie-AI/kolonie-platform/pull/7#issuecomment-1'

    expect(resolveGitHubUrl(onAPullRequest)).toMatchObject({ kind: 'comment' })
  })

  it('refuses a host that is not github.com', () => {
    const impostor = 'https://github.com.example.net/Kolonie-AI/kolonie-docs/issues/42'

    expect(resolveGitHubUrl(impostor)).toMatchObject({ kind: 'unaddressable' })
  })

  it('refuses plain http, so a read cannot be watched or rewritten', () => {
    expect(resolveGitHubUrl(ISSUE.replace('https', 'http'))).toMatchObject({
      kind: 'unaddressable',
    })
  })

  it('refuses a github.com address that names no issue', () => {
    expect(resolveGitHubUrl('https://github.com/Kolonie-AI')).toMatchObject({
      kind: 'unaddressable',
    })
  })

  it('refuses something that is not a URL at all', () => {
    expect(resolveGitHubUrl('I commented on the issue, honest')).toMatchObject({
      kind: 'unaddressable',
    })
  })
})

describe('httpGitHubReader', () => {
  it('returns the author lowercased and the body verbatim', async () => {
    const { fetch, calls } = answering(200, { user: { login: 'Octocat' }, body: '  hello  ' })

    const result = await httpGitHubReader(TOKEN, fetch).read(ISSUE)

    expect(result).toEqual({
      outcome: 'found',
      artefact: { url: ISSUE, author: 'octocat', body: '  hello  ' },
    })
    expect(calls).toEqual(['https://api.github.com/repos/Kolonie-AI/kolonie-docs/issues/42'])
  })

  it('reports a 404 as not-found — that is a fact about the submission', async () => {
    const { fetch } = answering(404)

    const result = await httpGitHubReader(TOKEN, fetch).read(ISSUE)

    expect(result).toMatchObject({ outcome: 'not-found' })
  })

  it.each([401, 403, 429, 500, 502, 503])(
    'reports %i as unavailable — that is a fact about us',
    async (status) => {
      const { fetch } = answering(status)

      const result = await httpGitHubReader(TOKEN, fetch).read(ISSUE)

      // Every one of these means our token is wrong or GitHub is having a
      // moment. None is evidence about a contribution, so none may become a
      // `fail`: the agent did the work and must not pay for our outage.
      expect(result).toMatchObject({ outcome: 'unavailable' })
    },
  )

  it('reports a connection that never happened as unavailable', async () => {
    const refusing = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch

    const result = await httpGitHubReader(TOKEN, refusing).read(ISSUE)

    expect(result).toMatchObject({ outcome: 'unavailable' })
  })

  it('reads nothing at all without a token, rather than reading anonymously', async () => {
    const { fetch, calls } = answering(404)

    const result = await httpGitHubReader(undefined, fetch).read(ISSUE)

    // The trap this avoids: the Colony's repositories are private
    // (kolonie-docs#6), so an anonymous read of a perfectly good contribution
    // returns 404 — and the verifier would fail an honest agent because *we*
    // were misconfigured. `unavailable` makes it wait for the deploy instead.
    expect(result).toMatchObject({ outcome: 'unavailable' })
    expect(result).toMatchObject({ reason: expect.stringContaining(GITHUB_VERIFIER_TOKEN_VAR) })
    expect(calls).toEqual([])
  })

  it('sends the token as a bearer credential and asks for the versioned API', async () => {
    let sent: RequestInit | undefined
    const capturing = (async (_url: string, init?: RequestInit) => {
      sent = init
      return {
        ok: true,
        status: 200,
        json: async () => ({ user: { login: 'a' }, body: '' }),
      } as Response
    }) as unknown as typeof fetch

    await httpGitHubReader(TOKEN, capturing).read(ISSUE)

    const headers = sent?.headers as Record<string, string>
    expect(headers['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(headers['x-github-api-version']).toBe('2022-11-28')
  })

  it('does not resolve a non-github address over the network', async () => {
    const { fetch, calls } = answering(200)

    const result = await httpGitHubReader(TOKEN, fetch).read('https://example.net/issues/1')

    // A malformed submission is decided here, without a request. Sending it
    // would be an outbound call to a host an agent chose.
    expect(result).toMatchObject({ outcome: 'not-found' })
    expect(calls).toEqual([])
  })
})

describe('resolveGistUrl', () => {
  it('addresses a gist by id, with or without the owner in the path', () => {
    expect(resolveGistUrl('https://gist.github.com/aa11bb22cc33')).toEqual({
      kind: 'gist',
      apiUrl: 'https://api.github.com/gists/aa11bb22cc33',
    })
    expect(resolveGistUrl('https://gist.github.com/octocat/aa11bb22cc33')).toEqual({
      kind: 'gist',
      apiUrl: 'https://api.github.com/gists/aa11bb22cc33',
    })
  })

  it('ignores the login in the path, because the API is what names the owner', () => {
    // The login here is whatever the pasted link happened to contain. Reading it
    // as evidence would be D-018 exactly: an account named by the submission.
    const honest = resolveGistUrl('https://gist.github.com/octocat/aa11bb22cc33')
    const lying = resolveGistUrl('https://gist.github.com/someone-else/aa11bb22cc33')

    expect(honest).toEqual(lying)
  })

  it.each([
    'https://github.com/octocat/aa11bb22cc33',
    'https://gist.github.com/',
    'https://gist.github.com/octocat/not-hex',
    'http://gist.github.com/aa11bb22cc33',
    'not a url at all',
  ])('refuses %s without a request', (url) => {
    expect(resolveGistUrl(url)).toMatchObject({ kind: 'unaddressable' })
  })
})

describe('httpGitHubReader.readGist', () => {
  const GIST = 'https://gist.github.com/octocat/aa11bb22cc33'

  const gist = (over: Record<string, unknown> = {}) => ({
    owner: { login: 'Octocat' },
    public: true,
    files: { 'kolonie.txt': { content: 'the nonce' } },
    ...over,
  })

  it('returns the owner lowercased and every file joined', async () => {
    const { fetch, calls } = answering(
      200,
      gist({ files: { 'a.txt': { content: 'one' }, 'b.txt': { content: 'two' } } }),
    )

    const result = await httpGitHubReader(TOKEN, fetch).readGist(GIST)

    expect(result).toEqual({
      outcome: 'found',
      artefact: { url: GIST, author: 'octocat', body: 'one\ntwo' },
    })
    expect(calls).toEqual(['https://api.github.com/gists/aa11bb22cc33'])
  })

  it('calls the owner `author`, which is the name the anti-farming query reads', async () => {
    const { fetch } = answering(200, gist())

    const result = await httpGitHubReader(TOKEN, fetch).readGist(GIST)

    // GitHub says `owner`; the Colony says `author` everywhere, because
    // `citizenForGithubAuthor` reads `metadata->>'author'`. Translating once,
    // here, is what stops a verifier writing a row that query cannot see (#42).
    expect(result).toMatchObject({ artefact: { author: 'octocat' } })
  })

  it('refuses a secret gist as not-found', async () => {
    const { fetch } = answering(200, gist({ public: false }))

    const result = await httpGitHubReader(TOKEN, fetch).readGist(GIST)

    // The rung's second property is that the claim is checkable by anybody, not
    // only by the Colony. A gist only the link-holder can find deletes it.
    expect(result).toMatchObject({ outcome: 'not-found' })
  })

  it('refuses an anonymous gist as not-found rather than unavailable', async () => {
    const { fetch } = answering(200, gist({ owner: undefined }))

    const result = await httpGitHubReader(TOKEN, fetch).readGist(GIST)

    // It has no owner at all, so it proves nothing about any account — a fact
    // about the submission. Retrying it until the timeout would tell the agent
    // nothing it could act on.
    expect(result).toMatchObject({ outcome: 'not-found' })
  })

  it('reports a 404 as not-found and a 503 as unavailable, like the issue path', async () => {
    const missing = await httpGitHubReader(TOKEN, answering(404).fetch).readGist(GIST)
    const ours = await httpGitHubReader(TOKEN, answering(503).fetch).readGist(GIST)

    expect(missing).toMatchObject({ outcome: 'not-found' })
    expect(ours).toMatchObject({ outcome: 'unavailable' })
  })

  it('reads nothing at all without a token', async () => {
    const { fetch, calls } = answering(200, gist())

    const result = await httpGitHubReader(undefined, fetch).readGist(GIST)

    expect(result).toMatchObject({ outcome: 'unavailable' })
    expect(calls).toEqual([])
  })
})

describe('mergedPullRequests', () => {
  const item = (number: number, mergedAt: string | null, repo = 'kolonie-platform') => ({
    html_url: `https://github.com/Kolonie-AI/${repo}/pull/${number}`,
    number,
    repository_url: `https://api.github.com/repos/Kolonie-AI/${repo}`,
    user: { login: 'octocat' },
    pull_request: mergedAt === null ? {} : { merged_at: mergedAt },
  })

  /**
   * A `fetch` that routes by URL, the way the enumeration read needs: one call
   * lists the organisation's repositories, then one call per repository asks for
   * that author's closed issues and pull requests together.
   */
  const routing = (
    routes: { readonly match: RegExp; readonly status?: number; readonly body?: unknown }[],
  ): { fetch: typeof fetch; calls: string[] } => {
    const calls: string[] = []
    return {
      calls,
      fetch: (async (url: string) => {
        calls.push(String(url))
        const route = routes.find((candidate) => candidate.match.test(String(url)))
        if (route === undefined) {
          return { ok: true, status: 200, json: async () => [] } as Response
        }
        const status = route.status ?? 200
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => (route.body === undefined ? [] : route.body),
        } as Response
      }) as unknown as typeof fetch,
    }
  }

  const repos = (names: string[]) => names.map((name) => ({ name, archived: false }))

  /**
   * The defect this whole read was rewritten for (#1983): GitHub's search API
   * silently omits private repositories under the Colony's token, so a merged
   * pull request in a private repository answered "no merged pull request
   * exists". Enumeration reaches private repositories through the repository
   * issue API instead.
   */
  it('finds a merged pull request in a private organisation repository', async () => {
    const { fetch, calls } = routing([
      { match: /\/orgs\/Kolonie-AI\/repos/, body: repos(['kolonie-concept-lab']) },
      {
        match: /\/repos\/Kolonie-AI\/kolonie-concept-lab\/issues/,
        body: [item(9, '2026-08-27T20:36:07Z', 'kolonie-concept-lab')],
      },
    ])

    const result = await httpGitHubReader(TOKEN, fetch).mergedPullRequests('octocat')

    expect(result).toEqual({
      outcome: 'found',
      pullRequests: [
        {
          url: 'https://github.com/Kolonie-AI/kolonie-concept-lab/pull/9',
          repository: 'Kolonie-AI/kolonie-concept-lab',
          number: 9,
          mergedAt: '2026-08-27T20:36:07Z',
        },
      ],
    })
    // The search API is gone from this read: its answers are public-only under
    // the Colony's token, which is the whole defect.
    expect(calls.some((url) => url.includes('/search/'))).toBe(false)
  })

  it('asks for closed issues by the author in the Colony’s org, merged is filtered locally', async () => {
    const { fetch, calls } = routing([
      { match: /\/orgs\/Kolonie-AI\/repos/, body: repos(['kolonie-platform']) },
      { match: /\/repos\/Kolonie-AI\/kolonie-platform\/issues/, body: [] },
    ])

    await httpGitHubReader(TOKEN, fetch).mergedPullRequests('octocat')

    const asked = decodeURIComponent(calls.find((url) => url.includes('/issues?')) ?? '')
    expect(asked).toContain('creator=octocat')
    expect(asked).toContain('state=closed')
    expect(asked).toContain('Kolonie-AI/kolonie-platform')
  })

  it('reduces items to url, repository, number and merge time', async () => {
    const { fetch } = routing([
      { match: /\/orgs\/Kolonie-AI\/repos/, body: repos(['kolonie-platform']) },
      {
        match: /\/repos\/Kolonie-AI\/kolonie-platform\/issues/,
        body: [item(7, '2026-07-01T00:00:00Z')],
      },
    ])

    const result = await httpGitHubReader(TOKEN, fetch).mergedPullRequests('octocat')

    expect(result).toMatchObject({
      outcome: 'found',
      pullRequests: [
        {
          url: 'https://github.com/Kolonie-AI/kolonie-platform/pull/7',
          repository: 'Kolonie-AI/kolonie-platform',
          number: 7,
          mergedAt: '2026-07-01T00:00:00Z',
        },
      ],
    })
  })

  /**
   * An item with a `pull_request` but no `merged_at` was closed, not merged. A
   * closed pull request is not a contribution, and inventing a merge date would
   * put a fact in an audit trail that nobody told us.
   */
  it('drops a closed-but-unmerged pull request rather than inventing a merge time', async () => {
    const { fetch } = routing([
      { match: /\/orgs\/Kolonie-AI\/repos/, body: repos(['kolonie-platform']) },
      {
        match: /\/repos\/Kolonie-AI\/kolonie-platform\/issues/,
        body: [
          item(7, null),
          item(8, '2026-07-02T00:00:00Z'),
          { number: 99, html_url: 'https://github.com/Kolonie-AI/kolonie-platform/issues/99' },
        ],
      },
    ])

    const result = await httpGitHubReader(TOKEN, fetch).mergedPullRequests('octocat')

    expect(result).toMatchObject({ outcome: 'found', pullRequests: [{ number: 8 }] })
  })

  it('skips archived repositories', async () => {
    const { fetch, calls } = routing([
      {
        match: /\/orgs\/Kolonie-AI\/repos/,
        body: [
          { name: 'kolonie-old', archived: true },
          { name: 'kolonie-platform', archived: false },
        ],
      },
      { match: /\/repos\/Kolonie-AI\/kolonie-platform\/issues/, body: [] },
    ])

    const result = await httpGitHubReader(TOKEN, fetch).mergedPullRequests('octocat')

    expect(result).toMatchObject({ outcome: 'found', pullRequests: [] })
    expect(calls.some((url) => url.includes('kolonie-old'))).toBe(false)
  })

  /**
   * Nothing merged is an answer, not a gap — so it is `found` with an empty list
   * and never `unavailable`, which would leave the submission retrying forever.
   * This holds only once every repository answered; the two tests below pin the
   * difference between a genuine empty and an unreadable scope.
   */
  it('reads a fully enumerated empty result as an answer', async () => {
    const { fetch } = routing([
      {
        match: /\/orgs\/Kolonie-AI\/repos/,
        body: repos(['kolonie-platform', 'kolonie-concept-lab']),
      },
      { match: /\/repos\/Kolonie-AI\/kolonie-platform\/issues/, body: [] },
      { match: /\/repos\/Kolonie-AI\/kolonie-concept-lab\/issues/, body: [] },
    ])

    expect(await httpGitHubReader(TOKEN, fetch).mergedPullRequests('octocat')).toEqual({
      outcome: 'found',
      pullRequests: [],
    })
  })

  /**
   * The other half of #1983: a repository the token cannot read must surface as
   * "cannot see this scope", never as "no merged pull request exists". An empty
   * answer over unreadable ground is the false negative this read was rewritten
   * to stop producing.
   */
  it('reports an unreadable repository as unavailable, naming the repository', async () => {
    const { fetch } = routing([
      { match: /\/orgs\/Kolonie-AI\/repos/, body: repos(['kolonie-concept-lab']) },
      { match: /\/repos\/Kolonie-AI\/kolonie-concept-lab\/issues/, status: 403 },
    ])

    const result = await httpGitHubReader(TOKEN, fetch).mergedPullRequests('octocat')

    expect(result).toMatchObject({ outcome: 'unavailable' })
    if (result.outcome === 'unavailable') {
      expect(result.reason).toContain('kolonie-concept-lab')
      expect(result.reason).not.toContain('no merged pull request')
    }
  })

  it('reports an unreadable organisation repository listing as unavailable', async () => {
    const { fetch } = routing([{ match: /\/orgs\/Kolonie-AI\/repos/, status: 403 }])

    const result = await httpGitHubReader(TOKEN, fetch).mergedPullRequests('octocat')

    expect(result).toMatchObject({ outcome: 'unavailable' })
  })

  it.each([
    ['rate-limited', 403],
    ['throttled', 429],
    ['a bad day at GitHub', 503],
  ])('reads %s as unavailable, never as nothing merged', async (_case, status) => {
    const { fetch } = routing([{ match: /\/orgs\/Kolonie-AI\/repos/, status }])

    expect(await httpGitHubReader(TOKEN, fetch).mergedPullRequests('octocat')).toMatchObject({
      outcome: 'unavailable',
    })
  })

  it('reads a reply that is not an array as unavailable', async () => {
    const { fetch } = routing([
      { match: /\/orgs\/Kolonie-AI\/repos/, body: { message: 'something else entirely' } },
    ])

    expect(await httpGitHubReader(TOKEN, fetch).mergedPullRequests('octocat')).toMatchObject({
      outcome: 'unavailable',
    })
  })

  it('reads nothing at all without a token', async () => {
    const { fetch, calls } = routing([{ match: /.*/, body: [] }])

    const result = await httpGitHubReader(undefined, fetch).mergedPullRequests('octocat')

    expect(result).toMatchObject({ outcome: 'unavailable' })
    expect(calls).toEqual([])
  })
})
