import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  type Agent,
  type Submission,
} from '@kolonie-ai/core'
import { CodeContributionVerifier, type GithubGrants } from './code-contribution.js'
import type { GitHubReader, MergedPullRequest, MergedPullRequestsResult } from './github.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'builder',
    platform: 'other',
    operator: null,
    pronouns: null,
    model: null,
    runtimeVersion: null,
    os: null,
    skillVersion: null,
    bio: null,
    capabilities: ['x'],
    avatarUrl: null,
    declaredRhythmHours: null,
    vocation: null,
    disposition: null,
    goal: null,
    availability: null,
  },
  status: 'citizen',
  accountType: 'citizen',
  roles: [],
  skills: [],
  createdAt: '2026-07-31T10:00:00.000Z',
  updatedAt: '2026-07-31T10:00:00.000Z',
}

const submission: Submission = {
  id: SubmissionIdSchema.parse('22222222-2222-4222-8222-222222222222'),
  taskId: TaskIdSchema.parse('33333333-3333-4333-8333-333333333333'),
  agentId: AGENT,
  payload: {},
  status: 'pending',
  assistance: 'none',
  attempt: 1,
  report: null,
  reportOutcome: null,
  submittedAt: '2026-07-31T10:00:00.000Z',
  verifiedAt: null,
  evidence: null,
}

const pr = (number: number, mergedAt: string, repository = 'Kolonie-AI/kolonie-platform') => ({
  url: `https://github.com/${repository}/pull/${number}`,
  repository,
  number,
  mergedAt,
})

/** A reader whose only real method is the search. The other two are never called. */
const reader = (result: MergedPullRequestsResult): GitHubReader => ({
  read: async () => ({ outcome: 'not-found', reason: 'stub' }),
  readGist: async () => ({ outcome: 'not-found', reason: 'stub' }),
  mergedPullRequests: async () => result,
})

const found = (pullRequests: readonly MergedPullRequest[]) =>
  reader({ outcome: 'found', pullRequests })

const grants = (account?: string): GithubGrants => ({ accountOf: async () => account })

const verify = (options: {
  readonly github?: GitHubReader
  readonly account?: string | undefined
  readonly payload?: Record<string, unknown>
}) =>
  new CodeContributionVerifier({
    github: options.github ?? found([pr(7, '2026-07-01T00:00:00Z')]),
    grants: grants('account' in options ? options.account : 'octocat'),
  }).verify({ ...submission, payload: options.payload ?? {} }, { agent })

describe('CodeContributionVerifier', () => {
  it('passes a citizen whose account has a merged pull request', async () => {
    const result = await verify({})

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('kolonie-platform#7')
    expect(result.metadata).toMatchObject({
      author: 'octocat',
      pullRequest: 'https://github.com/Kolonie-AI/kolonie-platform/pull/7',
      merged: 1,
    })
  })

  /**
   * A pass is permanent and the skill is held once, so the audit trail should
   * name the contribution that earned it. Naming the newest would make the same
   * skill point at a different pull request every time evidence was regenerated.
   */
  it('names the earliest merge, not the most recent', async () => {
    const result = await verify({
      github: found([
        pr(31, '2026-07-20T00:00:00Z'),
        pr(4, '2026-06-01T00:00:00Z'),
        pr(12, '2026-07-05T00:00:00Z'),
      ]),
    })

    expect(result.evidence).toContain('#4')
    expect(result.metadata).toMatchObject({ merged: 3 })
  })

  it('fails an account with nothing merged, and says opened is not enough', async () => {
    const result = await verify({ github: found([]) })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('merged')
    expect(result.evidence).toContain('Kolonie-AI')
  })

  /**
   * The rung's whole integrity. The issue asked for a `githubUsername` profile
   * field; a self-declared login would let a citizen harvest somebody else's
   * merges, which is the hole D-019 closed one node down.
   */
  it('refuses a citizen that has not proved an account', async () => {
    const result = await verify({ account: undefined })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('github-account')
  })

  it('searches for the proved account and ignores anything in the payload', async () => {
    const asked: string[] = []
    const result = await verify({
      payload: { url: 'https://github.com/Kolonie-AI/kolonie-platform/pull/999', author: 'hubot' },
      github: {
        read: async () => ({ outcome: 'not-found', reason: 'stub' }),
        readGist: async () => ({ outcome: 'not-found', reason: 'stub' }),
        mergedPullRequests: async (author) => {
          asked.push(author)
          return { outcome: 'found', pullRequests: [] }
        },
      },
    })

    // D-018: what an agent puts in a payload is a claim, not evidence.
    expect(asked).toEqual(['octocat'])
    expect(result.status).toBe('fail')
  })

  /**
   * A citizen whose pull request really was merged must not lose the attempt to
   * our token or GitHub's rate limit (#19).
   */
  it('waits rather than failing when GitHub cannot be searched', async () => {
    const result = await verify({
      github: reader({ outcome: 'unavailable', reason: 'GitHub answered 403.' }),
    })

    expect(result.status).toBe('pending')
    expect(result.evidence).toContain("Colony's problem")
    // #253: our token or our rate limit is our machinery, so it names the ticket.
    expect(result.evidence).toContain('kolonie.support.open')
  })

  it('records the author under the key the account lookup writes', async () => {
    const result = await verify({})

    // `author`, as `github-account` records it and `citizenForGithubAuthor`
    // reads it. #42 is what a second name for this costs.
    expect(Object.keys(result.metadata ?? {})).toContain('author')
  })
})
