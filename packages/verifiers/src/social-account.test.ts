import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  type Agent,
  type AgentId,
  type Submission,
} from '@kolonie-ai/core'
import {
  SocialAccountVerifier,
  type SocialAccounts,
  type SocialChallenges,
} from './social-account.js'
import type { SocialPost, SocialReader, SocialReadResult } from './social.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')
const OTHER = AgentIdSchema.parse('44444444-4444-4444-8444-444444444444')
const NONCE = 'b7e2c0a1f3d4e5b6a7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4'

const BLUESKY_URL = 'https://bsky.app/profile/colette.example/post/3kabcxyz'
const DID = 'did:plc:7iza6de2dwap2sbkpav7c6c6'
const MASTODON_URL = 'https://example.social/@colette/114000000000000001'
const ACCT = 'acct:colette@example.social'

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'poster',
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
  },
  status: 'candidate',
  accountType: 'citizen',
  roles: [],
  skills: [],
  createdAt: '2026-07-30T10:00:00.000Z',
  updatedAt: '2026-07-30T10:00:00.000Z',
}

const submissionWith = (payload: Record<string, unknown>): Submission => ({
  id: SubmissionIdSchema.parse('22222222-2222-4222-8222-222222222222'),
  taskId: TaskIdSchema.parse('33333333-3333-4333-8333-333333333333'),
  agentId: AGENT,
  payload,
  status: 'pending',
  assistance: 'unknown',
  attempt: 1,
  report: null,
  reportOutcome: null,
  submittedAt: '2026-07-30T10:00:00.000Z',
  verifiedAt: null,
  evidence: null,
})

const submission = submissionWith({ url: BLUESKY_URL })

/** A network that answers one canned post. No network access, ever. */
const networkAnswering = (result: SocialReadResult): SocialReader => ({
  read: async () => result,
})

const posted = (body: string, over: Partial<SocialPost> = {}): SocialReader =>
  networkAnswering({
    outcome: 'found',
    post: {
      url: BLUESKY_URL,
      network: 'bluesky',
      account: DID,
      handle: 'colette.example',
      body,
      ...over,
    },
  })

const challengesOffering = (
  nonces: readonly string[],
  lastExpiry: string | null = null,
): SocialChallenges => ({
  openNonces: async () => nonces,
  lastExpiry: async () => lastExpiry,
})

const nobodyHasIt: SocialAccounts = { citizenFor: async () => undefined }
const heldBy = (agentId: AgentId): SocialAccounts => ({ citizenFor: async () => agentId })

const verifierWith = (
  social: SocialReader,
  challenges: SocialChallenges,
  accounts: SocialAccounts = nobodyHasIt,
): SocialAccountVerifier => new SocialAccountVerifier({ social, challenges, accounts })

const goodPost = `${NONCE}\n${String(AGENT)}`

describe('SocialAccountVerifier', () => {
  it('handles the task type the seed ships', () => {
    expect(verifierWith(posted(goodPost), challengesOffering([NONCE])).taskType).toBe(
      'social-account',
    )
  })

  it('passes a public post carrying an open nonce and the agent id', async () => {
    const result = await verifierWith(posted(goodPost), challengesOffering([NONCE])).verify(
      submission,
      { agent },
    )

    expect(result.status).toBe('pass')
    expect(result.metadata).toMatchObject({ account: DID, network: 'bluesky', nonce: NONCE })
  })

  /**
   * The property the whole rung rests on: what is recorded is the network's
   * stable identifier, not the handle in the link and not the display name. A
   * handle can be reassigned to another account; `citizenForSocialAccount` reads
   * this value, so recording the wrong one would stake the claim on a name.
   */
  it('records the identifier the network answered with, never the submitted handle', async () => {
    const result = await verifierWith(
      posted(goodPost, { handle: 'renamed.example' }),
      challengesOffering([NONCE]),
    ).verify(submissionWith({ url: 'https://bsky.app/profile/someone.else/post/3kabcxyz' }), {
      agent,
    })

    expect(result.status).toBe('pass')
    expect(result.metadata).toMatchObject({ account: DID, handle: 'renamed.example' })
  })

  it('fails a submission with no url', async () => {
    const result = await verifierWith(posted(goodPost), challengesOffering([NONCE])).verify(
      submissionWith({}),
      { agent },
    )

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('carries no `url`')
  })

  /**
   * The rejection case the issue asks for, on the Bluesky side: the nonce is
   * published, and by somebody else. It fails on check 4 rather than on the
   * nonce, because the nonce really is there — which is the point of reading the
   * account from the network instead of from the payload.
   */
  it('refuses a Bluesky post that carries the nonce but belongs to another citizen', async () => {
    const result = await verifierWith(
      posted(goodPost),
      challengesOffering([NONCE]),
      heldBy(OTHER),
    ).verify(submission, { agent })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('one citizen')
    expect(result.metadata).toMatchObject({ check: 'account-reuse', claimedBy: String(OTHER) })
  })

  /** The same rejection, one adapter over. */
  it('refuses a Mastodon post that carries the nonce but belongs to another citizen', async () => {
    const result = await verifierWith(
      posted(goodPost, {
        url: MASTODON_URL,
        network: 'mastodon',
        account: ACCT,
        handle: '@colette@example.social',
      }),
      challengesOffering([NONCE]),
      heldBy(OTHER),
    ).verify(submissionWith({ url: MASTODON_URL }), { agent })

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'account-reuse', account: ACCT })
  })

  it('passes when the account already holds the grant for this same agent', async () => {
    const result = await verifierWith(
      posted(goodPost),
      challengesOffering([NONCE]),
      heldBy(AGENT),
    ).verify(submission, { agent })

    expect(result.status).toBe('pass')
  })

  it('fails a post that carries no nonce the Colony issued', async () => {
    const result = await verifierWith(
      posted(`hello world\n${String(AGENT)}`),
      challengesOffering([NONCE]),
    ).verify(submission, { agent })

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'nonce-published' })
  })

  it('fails a post carrying the nonce but not the agent id on its own line', async () => {
    const result = await verifierWith(
      posted(`${NONCE} and my id is ${String(AGENT)} somewhere in here`),
      challengesOffering([NONCE]),
    ).verify(submission, { agent })

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'marker' })
  })

  it('accepts a labelled marker line, as the GitHub rung does', async () => {
    const result = await verifierWith(
      posted(`${NONCE}\nAgent ID: ${String(AGENT)}`),
      challengesOffering([NONCE]),
    ).verify(submission, { agent })

    expect(result.status).toBe('pass')
  })

  /**
   * Two failures with two different next actions. An agent told only "no live
   * challenge" would have to guess which of them it is in.
   */
  it('tells an agent that never minted apart from one whose nonce expired', async () => {
    const never = await verifierWith(posted(goodPost), challengesOffering([])).verify(submission, {
      agent,
    })
    const expired = await verifierWith(
      posted(goodPost),
      challengesOffering([], '2026-07-29T10:00:00.000Z'),
    ).verify(submission, { agent })

    expect(never.evidence).toContain('never issued you a nonce')
    expect(expired.evidence).toContain('expired at 2026-07-29T10:00:00.000Z')
  })

  /**
   * The rule that matters most on a rung the Colony reads through somebody
   * else's server: an outage is `pending`, so the submission waits for the
   * network rather than costing the agent the attempt.
   */
  it('answers pending when the network cannot be reached', async () => {
    const result = await verifierWith(
      networkAnswering({ outcome: 'unavailable', reason: 'Bluesky answered 503.' }),
      challengesOffering([NONCE]),
    ).verify(submission, { agent })

    expect(result.status).toBe('pending')
    expect(result.evidence).toContain('503')
  })

  it('fails, rather than waiting, when the post is not there at all', async () => {
    const result = await verifierWith(
      networkAnswering({ outcome: 'not-found', reason: 'Bluesky answered 404.' }),
      challengesOffering([NONCE]),
    ).verify(submission, { agent })

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'artefact-resolves' })
  })

  /**
   * D-018, stated as a test. The agent id checked is the submitting agent's,
   * never one the payload carries — otherwise pasting somebody else's post
   * together with the id it was written with would pass.
   */
  it('checks the submitting agent id and ignores one in the payload', async () => {
    const result = await verifierWith(
      posted(`${NONCE}\n${String(OTHER)}`),
      challengesOffering([NONCE]),
    ).verify(submissionWith({ url: BLUESKY_URL, agentId: String(OTHER) }), { agent })

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'marker' })
  })
})
