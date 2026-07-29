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
