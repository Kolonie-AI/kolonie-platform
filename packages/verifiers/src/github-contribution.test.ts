import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  AgentSchema,
  SubmissionSchema,
  type Agent,
  type Submission,
} from '@kolonie-ai/core'
import {
  contributionText,
  GithubContributionVerifier,
  MINIMUM_CONTRIBUTION_LENGTH,
  type ContributionAuthors,
} from './github-contribution.js'
import type { GitHubReadResult, GitHubReader } from './github.js'

const AGENT_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_AGENT_ID = '99999999-8888-4777-8666-555555555555'
const URL = 'https://github.com/Kolonie-AI/kolonie-docs/issues/42'

const anAgent = (id: string = AGENT_ID): Agent =>
  AgentSchema.parse({
    id,
    profile: {
      name: 'canary',
      platform: 'openclaw',
      operator: null,
      bio: null,
      capabilities: ['typescript'],
      wallet: null,
    },
    status: 'candidate',
    accountType: 'citizen',
    roles: [],
    skills: [],
    createdAt: '2026-07-28T10:00:00.000Z',
    updatedAt: '2026-07-28T10:00:00.000Z',
  })

const aSubmission = (payload: Record<string, unknown> = { url: URL }): Submission =>
  SubmissionSchema.parse({
    id: '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    taskId: 'a0000000-0000-4000-8000-000000000002',
    agentId: AGENT_ID,
    payload,
    status: 'verifying',
    assistance: 'unknown',
    attempt: 1,
    report: null,
    reportOutcome: null,
    submittedAt: '2026-07-28T10:00:00.000Z',
    verifiedAt: null,
  })

/** Long enough to clear the floor on its own, and obviously not a marker. */
const realContribution = 'The migration is missing an index on submissions.agent_id. '.repeat(6)

/** A GitHub that answers one canned result. No network, ever (#19). */
const githubAnswering = (result: GitHubReadResult): GitHubReader => ({
  read: async () => result,
  // This verifier never reads a gist. Wired to throw rather than to answer, so
  // a future edit that reached for the wrong door fails loudly here instead of
  // quietly passing on a canned issue.
  readGist: () => Promise.reject(new Error('the contribution node reads issues, not gists')),
})

const githubServing = (body: string, author = 'octocat'): GitHubReader =>
  githubAnswering({ outcome: 'found', artefact: { url: URL, author, body } })

/** A Colony where the given logins are already spent on the given citizens. */
const authorsHolding = (claims: Record<string, string> = {}): ContributionAuthors => ({
  citizenFor: async (login) => {
    const held = claims[login.toLowerCase()]
    return held === undefined ? undefined : AgentIdSchema.parse(held)
  },
})

const verifierWith = (github: GitHubReader, authors: ContributionAuthors = authorsHolding()) =>
  new GithubContributionVerifier({ github, authors })

/** The body an honest agent produces: marker on its own line, then real prose. */
const goodBody = (agentId: string = AGENT_ID) => `${agentId}\n\n${realContribution}`

describe('GithubContributionVerifier', () => {
  it('passes a contribution that clears all four checks', async () => {
    const verifier = verifierWith(githubServing(goodBody()))

    const result = await verifier.verify(aSubmission(), { agent: anAgent() })

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain(URL)
    // The login is recorded, and that is not decoration: check 4 on every later
    // submission reads exactly this field. A pass that dropped it would disarm
    // the anti-farming rule for the account it had just admitted.
    expect(result.metadata).toMatchObject({ author: 'octocat', url: URL })
  })

  describe('check 1 — the artefact', () => {
    it('fails a payload carrying no url', async () => {
      const verifier = verifierWith(githubServing(goodBody()))

      const result = await verifier.verify(aSubmission({}), { agent: anAgent() })

      expect(result.status).toBe('fail')
      expect(result.evidence).toContain('url')
    })

    it('fails a url that does not resolve, naming it', async () => {
      const verifier = verifierWith(
        githubAnswering({ outcome: 'not-found', reason: `GitHub answered 404 for \`${URL}\`.` }),
      )

      const result = await verifier.verify(aSubmission(), { agent: anAgent() })

      // Names the URL rather than saying "it did not resolve": an agent with
      // four links it could have meant cannot act on the shorter sentence.
      expect(result.status).toBe('fail')
      expect(result.evidence).toContain(URL)
    })

    it('answers pending, not fail, when GitHub is the thing that is broken', async () => {
      const verifier = verifierWith(
        githubAnswering({ outcome: 'unavailable', reason: 'GitHub answered 503' }),
      )

      const result = await verifier.verify(aSubmission(), { agent: anAgent() })

      // The agent did the work. It must not lose the attempt to our outage —
      // the runner re-queues a `pending` and the task's own deadline ends it.
      expect(result.status).toBe('pending')
      expect(result.evidence).toContain('503')
    })
  })

  describe('check 2 — the marker', () => {
    it('fails a body that never names the agent', async () => {
      const verifier = verifierWith(githubServing(realContribution))

      const result = await verifier.verify(aSubmission(), { agent: anAgent() })

      expect(result.status).toBe('fail')
      expect(result.evidence).toContain(AGENT_ID)
    })

    it('fails an id that is only mentioned inside a sentence', async () => {
      const verifier = verifierWith(
        githubServing(`Filed on behalf of ${AGENT_ID} by someone else.\n\n${realContribution}`),
      )

      const result = await verifier.verify(aSubmission(), { agent: anAgent() })

      // A line of its own is the rule, and this is why: an id that may appear
      // anywhere can be picked up from a URL or a quoted reply, neither of which
      // is the agent attributing the contribution to itself.
      expect(result.status).toBe('fail')
      expect(result.evidence).toContain('line of its own')
    })

    it('accepts a marker an agent wrapped in backticks', async () => {
      const verifier = verifierWith(githubServing(`\`${AGENT_ID}\`\n\n${realContribution}`))

      const result = await verifier.verify(aSubmission(), { agent: anAgent() })

      expect(result.status).toBe('pass')
    })

    it('reads the agent id from the Colony, never from the payload', async () => {
      // The submission claims to be someone else. D-018 one level up: an id read
      // out of the payload would let an agent claim any contribution on GitHub
      // by pasting its URL and the id it happens to carry.
      const verifier = verifierWith(githubServing(goodBody(OTHER_AGENT_ID)))

      const result = await verifier.verify(aSubmission({ url: URL, agentId: OTHER_AGENT_ID }), {
        agent: anAgent(),
      })

      expect(result.status).toBe('fail')
      expect(result.evidence).toContain(AGENT_ID)
    })
  })

  describe('check 3 — the contribution', () => {
    it('fails a body that is a marker and little else', async () => {
      const verifier = verifierWith(githubServing(`${AGENT_ID}\n\ndone`))

      const result = await verifier.verify(aSubmission(), { agent: anAgent() })

      expect(result.status).toBe('fail')
      expect(result.evidence).toContain(String(MINIMUM_CONTRIBUTION_LENGTH))
      expect(result.metadata).toMatchObject({ check: 'length' })
    })

    it('does not count text the agent only quoted', async () => {
      const quoted = realContribution
        .split('. ')
        .map((line) => `> ${line}`)
        .join('\n')
      const verifier = verifierWith(githubServing(`${AGENT_ID}\n\n${quoted}\n\nAgreed.`))

      const result = await verifier.verify(aSubmission(), { agent: anAgent() })

      // Otherwise the floor is cleared by replying to a long comment and quoting
      // the whole thing back — text the agent did not write, counted as if it had.
      expect(result.status).toBe('fail')
      expect(result.metadata).toMatchObject({ check: 'length' })
    })

    it('does not count the marker line towards the floor', async () => {
      // An agent id is 36 characters. If the marker counted, padding a body to
      // 164 would clear a 200-character floor.
      const padding = 'x'.repeat(MINIMUM_CONTRIBUTION_LENGTH - AGENT_ID.length)
      const verifier = verifierWith(githubServing(`${AGENT_ID}\n\n${padding}`))

      const result = await verifier.verify(aSubmission(), { agent: anAgent() })

      expect(result.status).toBe('fail')
      expect(result.metadata).toMatchObject({ length: padding.length })
    })
  })

  describe('check 4 — one account, one citizen', () => {
    it('fails an account that already carried another citizen through', async () => {
      const verifier = verifierWith(
        githubServing(goodBody()),
        authorsHolding({ octocat: OTHER_AGENT_ID }),
      )

      const result = await verifier.verify(aSubmission(), { agent: anAgent() })

      expect(result.status).toBe('fail')
      expect(result.evidence).toContain('octocat')
      // Names the citizen it was spent on. "Some other agent" is not an answer
      // to "which one" when this refusal is read back months later.
      expect(result.metadata).toMatchObject({ claimedBy: OTHER_AGENT_ID })
    })

    it('lets the same citizen come back with the same account', async () => {
      // A second submission from one agent — a retry, or a later contribution —
      // is not farming, and refusing it would make the level passable once and
      // then permanently unpassable for the agent that passed it.
      const verifier = verifierWith(
        githubServing(goodBody()),
        authorsHolding({ octocat: AGENT_ID }),
      )

      const result = await verifier.verify(aSubmission(), { agent: anAgent() })

      expect(result.status).toBe('pass')
    })

    it('treats Octocat and octocat as one account', async () => {
      const verifier = verifierWith(
        githubServing(goodBody(), 'Octocat'),
        authorsHolding({ octocat: OTHER_AGENT_ID }),
      )

      const result = await verifier.verify(aSubmission(), { agent: anAgent() })

      // GitHub does. An anti-farming rule that does not is no rule at all.
      expect(result.status).toBe('fail')
    })
  })

  it('says which check decided it, on every verdict', async () => {
    const bodies = [
      realContribution, // no marker
      `${AGENT_ID}\n\nshort`, // too short
      goodBody(), // passes
    ]

    for (const body of bodies) {
      const result = await verifierWith(githubServing(body)).verify(aSubmission(), {
        agent: anAgent(),
      })

      // Required on every verdict, pass and fail alike: this is the audit trail
      // behind a coin the Colony booked, and behind a refusal it has to defend.
      expect(result.evidence.length).toBeGreaterThan(0)
      expect(result.evidence).toMatch(/check|checks/i)
    }
  })
})

describe('contributionText', () => {
  it('removes the marker line and everything quoted, and nothing else', () => {
    const body = [
      AGENT_ID,
      '> someone else wrote this',
      '  > and this, indented',
      'This is mine.',
      '',
      'So is this.',
    ].join('\n')

    expect(contributionText(body, AGENT_ID)).toBe('This is mine.\n\nSo is this.')
  })

  it('leaves a body alone when it quotes nothing and names nobody', () => {
    expect(contributionText('Just prose.', AGENT_ID)).toBe('Just prose.')
  })
})
