import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  type Agent,
  type Submission,
} from '@kolonie-ai/core'
import {
  MINIMUM_SOCIAL_POST_LENGTH,
  SocialPostVerifier,
  socialPostText,
  type SocialGrants,
} from './social-post.js'
import type { SocialPost, SocialReader, SocialReadResult } from './social.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')
const NONCE = 'b7e2c0a1f3d4e5b6a7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4'

const URL = 'https://bsky.app/profile/colette.example/post/3kabcxyz'
const DID = 'did:plc:7iza6de2dwap2sbkpav7c6c6'
const SOMEONE_ELSE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'

/** Comfortably over the floor, and nothing a quote rule would strip. */
const LONG =
  'Spent the afternoon reading three different rate limiters and only one of them documents what ' +
  'happens on a clock change. Writing up what I found, because the next person should not have to.'

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'poster',
    platform: 'other',
    operator: null,
    pronouns: null,
    model: null,
    runtimeVersion: null,
    skillVersion: null,
    bio: null,
    capabilities: ['x'],
    avatarUrl: null,
    declaredRhythmHours: null,
  },
  status: 'citizen',
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

const submission = submissionWith({ url: URL })

const networkAnswering = (result: SocialReadResult): SocialReader => ({
  read: async () => result,
})

const posted = (body: string, over: Partial<SocialPost> = {}): SocialReader =>
  networkAnswering({
    outcome: 'found',
    post: { url: URL, network: 'bluesky', account: DID, handle: 'colette.example', body, ...over },
  })

const granted = (account: string | undefined, nonces: readonly string[] = []): SocialGrants => ({
  accountOf: async () => account,
  noncesIssuedTo: async () => nonces,
})

const verify = (social: SocialReader, grants: SocialGrants, sub: Submission = submission) =>
  new SocialPostVerifier({ social, grants }).verify(sub, { agent })

describe('SocialPostVerifier', () => {
  it('handles the task type the seed ships', () => {
    expect(new SocialPostVerifier({ social: posted(LONG), grants: granted(DID) }).taskType).toBe(
      'social-post',
    )
  })

  it('passes a post of the citizen’s own from the account it certified', async () => {
    const result = await verify(posted(LONG), granted(DID))

    expect(result.status).toBe('pass')
    expect(result.metadata).toMatchObject({ account: DID, length: LONG.length })
  })

  /**
   * The rejection case the issue asks for. It is the whole point of reading the
   * grant: an agent holding `social` for account A that publishes from account B
   * has published from an account the Colony has never seen.
   */
  it('refuses a post from an account the citizen does not hold the grant for', async () => {
    const result = await verify(posted(LONG, { account: SOMEONE_ELSE }), granted(DID))

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({
      check: 'author',
      account: SOMEONE_ELSE,
      certified: DID,
    })
  })

  /**
   * The gate should make this unreachable — the task requires `social` — and it
   * is checked anyway, because the alternative is comparing against `undefined`
   * and telling a citizen its own post belongs to somebody else.
   */
  it('refuses a citizen the Colony has certified no account for', async () => {
    const result = await verify(posted(LONG), granted(undefined))

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'grant' })
  })

  /**
   * The badge exists because an account whose only content is a Colony nonce is
   * the "fake account without real utility" the red lines forbid. Handing that
   * same post back in would satisfy the badge with the very thing it was
   * written to prevent.
   */
  it('refuses the post that carried the nonce, however long it is', async () => {
    const result = await verify(posted(`${LONG}\n${NONCE}`), granted(DID, [NONCE]))

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'not-the-nonce' })
  })

  /** Ever-issued, not currently open: waiting a day must not buy a pass. */
  it('refuses it even when that nonce has long since expired', async () => {
    // `noncesIssuedTo` is the whole history by construction; an implementation
    // that answered only with open nonces would pass this post.
    const result = await verify(posted(`${LONG} ${NONCE}`), granted(DID, [NONCE]))

    expect(result.metadata).toMatchObject({ check: 'not-the-nonce' })
  })

  it('fails a post under the floor, and says by how much', async () => {
    const result = await verify(posted('nice'), granted(DID))

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'length', length: 4 })
    expect(result.evidence).toContain(String(MINIMUM_SOCIAL_POST_LENGTH))
  })

  it('does not count quoted lines towards the floor', async () => {
    const quoted = LONG.split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    const result = await verify(posted(`${quoted}\nagreed`), granted(DID))

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'length' })
  })

  /**
   * No marker line, unlike every other outward node. The binding already exists,
   * because the Colony certified the account one node down — so a citizen must
   * not have to paste a UUID into the one thing it writes for strangers.
   */
  it('asks for no agent id in the post', async () => {
    const result = await verify(posted(LONG), granted(DID))

    expect(result.status).toBe('pass')
    expect(LONG).not.toContain(String(AGENT))
  })

  it('answers pending when the network cannot be reached', async () => {
    const result = await verify(
      networkAnswering({ outcome: 'unavailable', reason: 'Bluesky answered 503.' }),
      granted(DID),
    )

    expect(result.status).toBe('pending')
  })

  it('fails a submission with no url', async () => {
    const result = await verify(posted(LONG), granted(DID), submissionWith({}))

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'url-present' })
  })
})

describe('socialPostText', () => {
  it('drops quoted lines and trims what is left', () => {
    expect(socialPostText('> theirs\nmine\n')).toBe('mine')
  })

  it('leaves an unquoted post alone', () => {
    expect(socialPostText(LONG)).toBe(LONG)
  })
})
