import { describe, expect, it } from 'vitest'
import type { AgentId } from '@kolonie-ai/core'
import type { OpenPullRequest, OpenPullRequestsResult } from '@kolonie-ai/verifiers'
import { contributionsAsText, listContributions } from './contributions.js'

const AGENT = 'agent-1' as AgentId

const pr = (over: Partial<OpenPullRequest> = {}): OpenPullRequest => ({
  url: 'https://github.com/Kolonie-AI/kolonie-platform/pull/44',
  repository: 'Kolonie-AI/kolonie-platform',
  number: 44,
  title: 'Tell an agent that it failed',
  openedAt: '2026-07-29T10:00:00Z',
  state: 'awaiting-review',
  reviews: 0,
  ...over,
})

const deps = (account: string | undefined, result?: OpenPullRequestsResult) => ({
  grants: { accountOf: () => Promise.resolve(account) },
  reader: result === undefined ? undefined : { openPullRequests: () => Promise.resolve(result) },
})

describe('listContributions', () => {
  it('serves the pull requests GitHub reported, under the account they were found for', async () => {
    const found: OpenPullRequestsResult = {
      outcome: 'found',
      pullRequests: [pr({ state: 'changes-requested', reviews: 1 })],
    }

    const { response } = await listContributions(AGENT, deps('someagent', found))

    expect(response.account).toBe('someagent')
    expect(response.pullRequests).toHaveLength(1)
    expect(response.unavailable).toBeUndefined()
  })

  /**
   * The rejection case this whole module exists for. An outage that reads as
   * "nothing is waiting on you" sends a citizen back to sleep on a review it
   * needed — which is kolonie-docs#43 happening again, through the tool built to
   * prevent it.
   */
  it('never reports an outage as an empty list', async () => {
    const { response } = await listContributions(
      AGENT,
      deps('someagent', { outcome: 'unavailable', reason: 'GitHub answered 503.' }),
    )

    expect(response.pullRequests).toEqual([])
    expect(response.unavailable).toContain('503')
    expect(contributionsAsText(response)).toContain('could not read')
    expect(contributionsAsText(response)).not.toContain('Nothing open')
  })

  it('says the same when the Colony holds no GitHub token at all', async () => {
    const { response } = await listContributions(AGENT, deps('someagent'))

    expect(response.unavailable).toContain('no GitHub token')
    expect(contributionsAsText(response)).toContain('not the same as having none')
  })

  /**
   * An agent that has not done the GitHub rung is not in an error state, and the
   * account is read from the grant rather than from anything the agent typed —
   * D-019's hole, which here would be a disclosure rather than a mis-grant.
   */
  it('answers emptily, and without asking GitHub, for an agent holding no account', async () => {
    let asked = false
    const { response } = await listContributions(AGENT, {
      grants: { accountOf: () => Promise.resolve(undefined) },
      reader: {
        openPullRequests: () => {
          asked = true
          return Promise.resolve({ outcome: 'found', pullRequests: [] })
        },
      },
    })

    expect(asked).toBe(false)
    expect(response.account).toBeUndefined()
    expect(contributionsAsText(response)).toContain('github-account')
  })
})

describe('contributionsAsText', () => {
  it('puts the pull request that wants something first, whatever order it arrived in', () => {
    const text = contributionsAsText({
      account: 'someagent',
      pullRequests: [
        pr({ number: 1, state: 'approved' }),
        pr({ number: 2, state: 'awaiting-review' }),
        pr({ number: 3, state: 'changes-requested', reviews: 2 }),
      ],
    })

    const first = text.indexOf('#3')
    expect(first).toBeGreaterThan(-1)
    expect(first).toBeLessThan(text.indexOf('#1'))
    expect(first).toBeLessThan(text.indexOf('#2'))
    expect(text).toContain('Read the review before you do anything else')
  })

  it('does not raise an alarm when nothing is being asked of the agent', () => {
    const text = contributionsAsText({
      account: 'someagent',
      pullRequests: [pr({ state: 'approved' })],
    })

    expect(text).not.toContain('waiting on you')
    expect(text).toContain('1 open pull request under someagent')
  })

  it('reports an empty list as an empty list', () => {
    expect(contributionsAsText({ account: 'someagent', pullRequests: [] })).toContain(
      'Nothing open under someagent',
    )
  })
})
