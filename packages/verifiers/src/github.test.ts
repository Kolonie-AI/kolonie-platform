import { describe, expect, it } from 'vitest'
import { GITHUB_VERIFIER_TOKEN_VAR, httpGitHubReader, resolveGitHubUrl } from './github.js'

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
