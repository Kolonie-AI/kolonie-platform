import { describe, expect, it } from 'vitest'
import { httpContributionReader, summariseReviews } from './contributions.js'

const searchResponse = (items: unknown[]): Response =>
  new Response(JSON.stringify({ items }), { status: 200 })

const item = (over: Record<string, unknown> = {}) => ({
  html_url: 'https://github.com/Kolonie-AI/kolonie-platform/pull/44',
  number: 44,
  title: 'Tell an agent that it failed',
  created_at: '2026-07-29T10:00:00Z',
  repository_url: 'https://api.github.com/repos/Kolonie-AI/kolonie-platform',
  ...over,
})

const review = (login: string, state: string) => ({ user: { login }, state })

describe('summariseReviews', () => {
  it('takes the latest verdict per reviewer, not the latest on the pull request', () => {
    // Asked for changes, then approved: approved. The other way round would let
    // a stale request keep a finished pull request looking blocked.
    expect(
      summariseReviews([review('ana', 'CHANGES_REQUESTED'), review('ana', 'APPROVED')]).state,
    ).toBe('approved')

    expect(
      summariseReviews([review('ana', 'APPROVED'), review('ana', 'CHANGES_REQUESTED')]).state,
    ).toBe('changes-requested')
  })

  /**
   * The case that decides whether the message reaches the agent at all: one
   * reviewer approving must not bury another's outstanding request.
   */
  it('lets one outstanding request outweigh any number of approvals', () => {
    expect(
      summariseReviews([
        review('ana', 'APPROVED'),
        review('bo', 'CHANGES_REQUESTED'),
        review('cy', 'APPROVED'),
      ]).state,
    ).toBe('changes-requested')
  })

  it('does not let a later comment demote a standing request for changes', () => {
    // GitHub records a plain comment as a review. Treating it as a verdict would
    // silence the one state an agent has to act on.
    expect(
      summariseReviews([review('ana', 'CHANGES_REQUESTED'), review('ana', 'COMMENTED')]).state,
    ).toBe('changes-requested')
  })

  it('tells "nobody has looked" apart from "somebody wrote something"', () => {
    expect(summariseReviews([]).state).toBe('awaiting-review')
    expect(summariseReviews([review('ana', 'COMMENTED')]).state).toBe('commented')
    expect(summariseReviews(undefined).state).toBe('awaiting-review')
  })
})

describe('httpContributionReader', () => {
  it('refuses to guess when there is no token, rather than reporting nothing open', async () => {
    const reader = httpContributionReader(undefined, () => {
      throw new Error('must not be called')
    })

    const result = await reader.openPullRequests('someagent')

    expect(result.outcome).toBe('unavailable')
  })

  it('asks only for open pull requests, by this author, in this organisation', async () => {
    const seen: string[] = []
    const reader = httpContributionReader('token', (url) => {
      seen.push(String(url))
      return Promise.resolve(searchResponse([]))
    })

    await reader.openPullRequests('someagent')

    expect(decodeURIComponent(seen[0] as string)).toContain(
      'is:pr is:open author:someagent org:Kolonie-AI',
    )
  })

  it('reads the reviews of each pull request it found', async () => {
    const reader = httpContributionReader('token', (url) => {
      if (String(url).includes('/search/')) return Promise.resolve(searchResponse([item()]))
      return Promise.resolve(
        new Response(JSON.stringify([review('ana', 'CHANGES_REQUESTED')]), { status: 200 }),
      )
    })

    const result = await reader.openPullRequests('someagent')

    expect(result.outcome).toBe('found')
    if (result.outcome !== 'found') return
    expect(result.pullRequests[0]?.state).toBe('changes-requested')
    expect(result.pullRequests[0]?.repository).toBe('Kolonie-AI/kolonie-platform')
  })

  /**
   * A partial outage must not shrink the list. Dropping a pull request whose
   * reviews could not be read would turn "we could not check this one" into
   * "you have nothing there", which is the answer this must never invent.
   */
  it('keeps a pull request whose reviews could not be read', async () => {
    const reader = httpContributionReader('token', (url) => {
      if (String(url).includes('/search/')) return Promise.resolve(searchResponse([item()]))
      return Promise.resolve(new Response('nope', { status: 500 }))
    })

    const result = await reader.openPullRequests('someagent')

    expect(result.outcome).toBe('found')
    if (result.outcome !== 'found') return
    expect(result.pullRequests).toHaveLength(1)
    expect(result.pullRequests[0]?.state).toBe('awaiting-review')
  })

  it('drops an item missing a field rather than inventing one', async () => {
    const reader = httpContributionReader('token', (url) => {
      if (String(url).includes('/search/'))
        return Promise.resolve(searchResponse([item({ title: undefined }), item({ number: 45 })]))
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
    })

    const result = await reader.openPullRequests('someagent')

    expect(result.outcome).toBe('found')
    if (result.outcome !== 'found') return
    expect(result.pullRequests).toHaveLength(1)
    expect(result.pullRequests[0]?.number).toBe(45)
  })

  it('reports a failed search as unavailable, never as an empty list', async () => {
    const reader = httpContributionReader('token', () =>
      Promise.resolve(new Response('nope', { status: 503 })),
    )

    const result = await reader.openPullRequests('someagent')

    expect(result.outcome).toBe('unavailable')
  })
})
