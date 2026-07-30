import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  type Agent,
  type AgentId,
  type Submission,
} from '@kolonie-ai/core'
import { GithubAccountVerifier, type GithubChallenges } from './github-account.js'
import type { ContributionAuthors } from './github-contribution.js'
import type { GitHubGistReadResult, GitHubReader } from './github.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')
const OTHER = AgentIdSchema.parse('44444444-4444-4444-8444-444444444444')
const NONCE = 'b7e2c0a1f3d4e5b6a7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4'
const URL = 'https://gist.github.com/octocat/aa11bb22cc33'

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'gister',
    platform: 'other',
    operator: null,
    bio: null,
    capabilities: ['x'],
    wallet: null,
    avatarUrl: null,
  },
  status: 'candidate',
  accountType: 'citizen',
  roles: [],
  skills: [],
  createdAt: '2026-07-29T10:00:00.000Z',
  updatedAt: '2026-07-29T10:00:00.000Z',
}

const submissionWith = (payload: Record<string, unknown>): Submission => ({
  id: SubmissionIdSchema.parse('22222222-2222-4222-8222-222222222222'),
  taskId: TaskIdSchema.parse('33333333-3333-4333-8333-333333333333'),
  agentId: AGENT,
  payload,
  status: 'pending',
  assistance: 'unknown',
  attempt: 1,
  submittedAt: '2026-07-29T10:00:00.000Z',
  verifiedAt: null,
})

const submission = submissionWith({ url: URL })

/** A GitHub that answers one canned gist. No network, ever (#19). */
const githubAnswering = (result: GitHubGistReadResult): GitHubReader => ({
  read: () => Promise.reject(new Error('the account node reads gists, not issues')),
  readGist: async () => result,
})

const githubServing = (body: string, author = 'octocat'): GitHubReader =>
  githubAnswering({ outcome: 'found', artefact: { url: URL, author, body } })

const challengesOffering = (
  nonces: readonly string[],
  lastExpiry: string | null = null,
): GithubChallenges => ({
  openNonces: async () => nonces,
  lastExpiry: async () => lastExpiry,
})

const nobodyHasIt: ContributionAuthors = { citizenFor: async () => undefined }
const heldBy = (agentId: AgentId): ContributionAuthors => ({ citizenFor: async () => agentId })

const verify = (
  github: GitHubReader,
  challenges: GithubChallenges = challengesOffering([NONCE]),
  authors: ContributionAuthors = nobodyHasIt,
  given: Submission = submission,
) => new GithubAccountVerifier({ github, challenges, authors }).verify(given, { agent })

/** A gist that would pass: the nonce and the id, each on a line of its own. */
const goodGist = `${NONCE}\n${AGENT}\n`

describe('GithubAccountVerifier', () => {
  it('passes a public gist carrying the nonce and the agent id', async () => {
    const result = await verify(githubServing(goodGist))

    expect(result.status).toBe('pass')
    expect(result.metadata).toMatchObject({ author: 'octocat', nonce: NONCE })
  })

  it('records the login under `author`, which is what the anti-farming query reads', async () => {
    const result = await verify(githubServing(goodGist))

    // Not a style preference. `citizenForGithubAuthor` reads
    // `metadata->>'author'`; GitHub calls a gist's account `owner`, and a
    // verdict recording *that* name would be a row the query cannot see —
    // silently freeing the account it just certified (#42).
    expect(result.metadata).toHaveProperty('author')
    expect(result.metadata).not.toHaveProperty('owner')
  })

  it('fails a payload with no url', async () => {
    const result = await verify(githubServing(goodGist), undefined, undefined, submissionWith({}))

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'url-present' })
  })

  it('is pending, not failed, when GitHub does not answer', async () => {
    const result = await verify(
      githubAnswering({ outcome: 'unavailable', reason: 'GitHub answered 503.' }),
    )

    // The agent did the work. Failing here would charge it for our outage (#19).
    expect(result.status).toBe('pending')
  })

  it('fails when the gist does not resolve', async () => {
    const result = await verify(
      githubAnswering({ outcome: 'not-found', reason: 'GitHub answered 404.' }),
    )

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'artefact-resolves' })
  })

  it('tells an agent that never minted from one whose nonce expired', async () => {
    const never = await verify(githubServing(goodGist), challengesOffering([]))
    const expired = await verify(
      githubServing(goodGist),
      challengesOffering([], '2026-07-28T10:00:00.000Z'),
    )

    // Two different problems with two different next actions. An agent told
    // only "no live challenge" would have to guess which it is.
    expect(never.status).toBe('fail')
    expect(never.evidence).toContain('never issued you a nonce')
    expect(expired.status).toBe('fail')
    expect(expired.evidence).toContain('expired at 2026-07-28T10:00:00.000Z')
  })

  it('fails a gist that carries no nonce of this agent', async () => {
    const result = await verify(githubServing(`something else\n${AGENT}\n`))

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'nonce-published' })
  })

  it('accepts any of the agent’s live nonces, not only the newest', async () => {
    const older = 'a'.repeat(64)
    const result = await verify(
      githubServing(`${older}\n${AGENT}\n`),
      challengesOffering([NONCE, older]),
    )

    // Each was issued to this same agent, so a gist carrying any of them proves
    // exactly what one carrying the newest would. Refusing would only strand an
    // agent that published, lost track, and minted again.
    expect(result.status).toBe('pass')
  })

  it('fails a gist with the nonce but no agent id', async () => {
    const result = await verify(githubServing(`${NONCE}\n`))

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'marker' })
  })

  it('accepts the agent id with a label in front of it', async () => {
    const result = await verify(githubServing(`${NONCE}\nAgent ID: ${AGENT}\n`))

    // `#41`: "on a line of its own" reads as "on its own line", which this
    // satisfies. Two experienced agents wrote exactly this and were failed for
    // it at the contribution node on the same day.
    expect(result.status).toBe('pass')
  })

  it('rejects a line that merely contains the id', async () => {
    const result = await verify(githubServing(`${NONCE}\nsee https://x.test/${AGENT}/log\n`))

    // The tolerance is a known label, not "anywhere on the line". An id picked
    // up from a URL is not the agent attributing the gist to itself.
    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'marker' })
  })

  it('fails when the account already certified another citizen', async () => {
    const result = await verify(githubServing(goodGist), undefined, heldBy(OTHER))

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'account-reuse', claimedBy: String(OTHER) })
  })

  it('lets the same citizen pass again with its own account', async () => {
    const result = await verify(githubServing(goodGist), undefined, heldBy(AGENT))

    // Re-testability is the mechanism that makes assistance need no policing
    // (`academy.md`). An agent that genuinely controls the account can mint a
    // fresh nonce and prove it again — so its own prior claim must not block it.
    expect(result.status).toBe('pass')
  })

  it('never reads the account from the payload', async () => {
    const result = await verify(
      githubServing(goodGist, 'realowner'),
      undefined,
      undefined,
      submissionWith({ url: URL, author: 'someone-else', owner: 'someone-else' }),
    )

    // D-018. A login read out of the submission would let an agent claim any
    // account by naming it.
    expect(result.status).toBe('pass')
    expect(result.metadata).toMatchObject({ author: 'realowner' })
  })
})
