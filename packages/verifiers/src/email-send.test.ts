import { describe, expect, it } from 'vitest'
import { AgentSchema, SubmissionSchema, type Agent, type Submission } from '@kolonie-ai/core'
import { EmailSendVerifier, type EmailSendState, type MailboxGrants } from './email-send.js'

const AGENT_ID = '11111111-2222-4333-8444-555555555555'

const anAgent = (): Agent =>
  AgentSchema.parse({
    id: AGENT_ID,
    profile: {
      name: 'postmaster',
      platform: 'openclaw',
      operator: null,
      bio: null,
      capabilities: [],
      avatarUrl: null,
    },
    status: 'citizen',
    accountType: 'citizen',
    roles: [],
    skills: ['profile', 'mailbox'],
    createdAt: '2026-07-28T10:00:00.000Z',
    updatedAt: '2026-07-28T10:00:00.000Z',
  })

const aSubmission = (payload: Record<string, unknown> = {}): Submission =>
  SubmissionSchema.parse({
    id: '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    taskId: '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f',
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

const inTheFuture = () => new Date(Date.now() + 60_000).toISOString()
const inThePast = () => new Date(Date.now() - 60_000).toISOString()

const granted = (address: string | undefined): MailboxGrants => ({
  grantOf: async () =>
    address === undefined ? undefined : { address, grantedAt: '2026-07-29T09:00:00.000Z' },
})

const verify = async (grant: string | undefined, state: EmailSendState | null, payload = {}) =>
  new EmailSendVerifier({
    sends: { latest: async () => state },
    grants: granted(grant),
  }).verify(aSubmission(payload), { agent: anAgent() })

describe('EmailSendVerifier', () => {
  it('handles the email-send task type', () => {
    expect(
      String(
        new EmailSendVerifier({
          sends: { latest: async () => null },
          grants: granted(undefined),
        }).taskType,
      ),
    ).toBe('email-send')
  })

  /**
   * The badge is about a mailbox the citizen proved. Without the grant it is
   * about nothing, and the refusal has to say that rather than reading as "your
   * mail did not arrive".
   */
  it('refuses a citizen holding no mailbox grant, and says why', async () => {
    const result = await verify(undefined, null)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('no mailbox on record')
    expect(result.metadata).toMatchObject({ check: 'grant-held' })
  })

  it('passes once mail from the granted address has arrived', async () => {
    const result = await verify('citizen@example.org', {
      address: 'citizen@example.org',
      expiresAt: inTheFuture(),
      inboundAt: '2026-07-30T09:00:00.000Z',
      verifiedAt: '2026-07-30T09:00:00.000Z',
    })

    expect(result.status).toBe('pass')
    expect(result.metadata).toMatchObject({ address: 'citizen@example.org' })
  })

  /** A pass is permanent — the challenge expires, the badge does not. */
  it('passes a badge whose challenge has since expired', async () => {
    const result = await verify('citizen@example.org', {
      address: 'citizen@example.org',
      expiresAt: inThePast(),
      inboundAt: '2026-07-30T09:00:00.000Z',
      verifiedAt: '2026-07-30T09:00:00.000Z',
    })

    expect(result.status).toBe('pass')
  })

  it('tells a citizen with the grant but no challenge which address to send from', async () => {
    const result = await verify('citizen@example.org', null)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('citizen@example.org')
    expect(result.metadata).toMatchObject({ check: 'challenge-open' })
  })

  it('fails while the challenge is open and no mail has arrived', async () => {
    const result = await verify('citizen@example.org', {
      address: 'citizen@example.org',
      expiresAt: inTheFuture(),
      inboundAt: null,
      verifiedAt: null,
    })

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ check: 'mail-arrived' })
  })

  /**
   * A badge grants nothing, so failing it takes nothing away. Saying so where an
   * agent reads it is the difference between a badge and a punishment.
   */
  it('says the mailbox skill is untouched when the challenge expired unused', async () => {
    const result = await verify('citizen@example.org', {
      address: 'citizen@example.org',
      expiresAt: inThePast(),
      inboundAt: null,
      verifiedAt: null,
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('`mailbox` skill is untouched')
  })

  /**
   * D-018, and the reason this badge reads the grant at all. Everything it
   * proves happened in an SMTP conversation the API never saw, so a payload
   * naming a different address has to change nothing.
   */
  it('ignores a payload naming another address', async () => {
    const result = await verify(
      'citizen@example.org',
      {
        address: 'citizen@example.org',
        expiresAt: inTheFuture(),
        inboundAt: null,
        verifiedAt: null,
      },
      { address: 'somewhere-else@example.net', sent: true },
    )

    expect(result.status).toBe('fail')
    expect(result.evidence).not.toContain('somewhere-else@example.net')
  })

  /** Every verdict carries evidence, passes included — AGENTS.md §6. */
  it('always says why', async () => {
    const states: [string | undefined, EmailSendState | null][] = [
      [undefined, null],
      ['a@example.org', null],
      [
        'a@example.org',
        { address: 'a@example.org', expiresAt: inTheFuture(), inboundAt: null, verifiedAt: null },
      ],
      [
        'a@example.org',
        { address: 'a@example.org', expiresAt: inTheFuture(), inboundAt: 'x', verifiedAt: 'y' },
      ],
    ]

    for (const [grant, state] of states) {
      expect((await verify(grant, state)).evidence.length).toBeGreaterThan(0)
    }
  })
})
