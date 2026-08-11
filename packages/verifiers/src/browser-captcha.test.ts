import { describe, expect, it } from 'vitest'
import {
  AgentSchema,
  SubmissionSchema,
  type Agent,
  type AgentId,
  type Submission,
  type Timestamp,
  CAPABILITY_STAGE,
  THIRD_PARTY_CHALLENGE_STAGE,
} from '@kolonie-ai/core'
import {
  BrowserCaptchaVerifier,
  type ChallengeKind,
  type FinishedHandover,
  type OperatorHandovers,
} from './browser-captcha.js'

const anAgent = (): Agent =>
  AgentSchema.parse({
    id: '11111111-2222-4333-8444-555555555555',
    profile: {
      name: 'canary',
      platform: 'openclaw',
      operator: null,
      pronouns: null,
      model: null,
      runtimeVersion: null,
      os: null,
      skillVersion: null,
      bio: null,
      capabilities: ['research'],
      avatarUrl: null,
      declaredRhythmHours: null,
      vocation: null,
      disposition: null,
      goal: null,
    },
    status: 'candidate',
    accountType: 'citizen',
    roles: [],
    skills: [],
    createdAt: '2026-07-28T10:00:00.000Z',
    updatedAt: '2026-07-28T10:00:00.000Z',
  })

const aSubmission = ({ payload = {} }: { payload?: Record<string, unknown> } = {}): Submission =>
  SubmissionSchema.parse({
    id: '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    taskId: '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f',
    agentId: '11111111-2222-4333-8444-555555555555',
    payload,
    status: 'verifying',
    assistance: 'unknown',
    attempt: 1,
    report: null,
    reportOutcome: null,
    submittedAt: '2026-07-28T10:00:00.000Z',
    verifiedAt: null,
    evidence: null,
  })

/**
 * A gate that answers for one kind and refuses the other.
 *
 * Written this way rather than as a constant, because the property worth
 * asserting is not "the verifier returns what the port said" — it is that the
 * verifier *asks about its own kind*. A fake that answered regardless would pass
 * whatever the verifier queried, including the wrong thing.
 */
const gates = (clearedAt: Timestamp | null, kind: ChallengeKind = THIRD_PARTY_CHALLENGE_STAGE) => ({
  clearedAt: async (_agentId: AgentId, asked: ChallengeKind) => (asked === kind ? clearedAt : null),
})

/**
 * A handover port holding one finished session, answering the interval rather
 * than a flag (`#739`).
 *
 * The fake does the comparison the real query does — `accepted <= at <= closed`
 * — instead of returning a fixed answer, because what this badge now turns on is
 * *the challenge was cleared while the person was on the tab*. A fake that said
 * yes to any moment would let a verifier that never passed the clear time
 * through pass every test in this file.
 */
const handovers = (
  session: { readonly acceptedAt: Timestamp; readonly closedAt: Timestamp } | null,
  closedFor = 'completed',
): OperatorHandovers => ({
  around: async (_agentId: AgentId, at: Timestamp): Promise<FinishedHandover | null> => {
    if (session === null) return null
    if (at < session.acceptedAt || at > session.closedAt) return null
    return {
      shareId: '77777777-7777-4777-8777-777777777777',
      acceptedAt: session.acceptedAt,
      closedAt: session.closedAt,
      closedFor,
    }
  },
})

/** One handover, with the clear in the middle of it. */
const JOINED = '2026-07-28T11:55:00.000Z' as Timestamp
const SOLVED = '2026-07-28T12:00:00.000Z' as Timestamp
const LEFT = '2026-07-28T12:04:00.000Z' as Timestamp

const aSession = () => ({ acceptedAt: JOINED, closedAt: LEFT })

describe('BrowserCaptchaVerifier', () => {
  it('passes a challenge the operator cleared inside the agent’s own session', async () => {
    const verifier = new BrowserCaptchaVerifier({
      gates: gates(SOLVED),
      handovers: handovers(aSession()),
    })

    const result = await verifier.verify(aSubmission(), { agent: anAgent() })

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain(SOLVED)
    expect(result.metadata).toMatchObject({
      clearedAt: SOLVED,
      shareId: '77777777-7777-4777-8777-777777777777',
      acceptedAt: JOINED,
      closedAt: LEFT,
    })
  })

  /**
   * **The rebuild, stated as a test** (`#739`). A cleared challenge with no
   * operator anywhere near it is the old route, and the old route no longer
   * pays: *an agent that cannot hand the challenge over, and is measured on
   * getting past it, is an agent under pressure to claim to be human.*
   */
  it('fails a challenge the agent cleared by itself, however real the clear', async () => {
    const verifier = new BrowserCaptchaVerifier({
      gates: gates(SOLVED),
      handovers: handovers(null),
    })

    const result = await verifier.verify(aSubmission(), { agent: anAgent() })

    expect(result.status).toBe('fail')
    expect(result.evidence).toMatch(/no operator was on a shared/i)
    // The clear is not denied — it is on record and the verdict says so. What is
    // missing is the handover, and an agent reading this has to be able to tell
    // those two failures apart.
    expect(result.metadata).toMatchObject({ clearedAt: SOLVED })
  })

  /**
   * The interval is the rule, not the mere existence of a session. Somebody who
   * joined afterwards cannot have been the one who cleared it, and a badge that
   * accepted this would be a badge earned by offering a share at any point after
   * solving one alone.
   */
  it('fails a clear that fell outside the session the operator was on', async () => {
    const before = '2026-07-28T11:00:00.000Z' as Timestamp
    const verifier = new BrowserCaptchaVerifier({
      gates: gates(before),
      handovers: handovers(aSession()),
    })

    expect((await verifier.verify(aSubmission(), { agent: anAgent() })).status).toBe('fail')
  })

  it('fails an agent with nothing on record, and points at the handover', async () => {
    const verifier = new BrowserCaptchaVerifier({
      gates: gates(null),
      handovers: handovers(aSession()),
    })

    const result = await verifier.verify(aSubmission(), { agent: anAgent() })

    expect(result.status).toBe('fail')
    // It says the badge is optional rather than telling the agent to go solve
    // it: declining is a correct answer since `kolonie-docs#33`.
    expect(result.evidence).toMatch(/optional/i)
    expect(result.evidence).toMatch(/blocks no rung/i)
    // And it names the only route there is, which is the operator's.
    expect(result.evidence).toMatch(/kolonie\.browser\.share\.open/)
  })

  /**
   * The text an agent reads when it fails must not put it under the pressure the
   * rung was rebuilt to remove. This is the one assertion here about wording, and
   * it is here because on this rung the wording is the safety property.
   */
  it('tells a failing agent it is not expected to claim to be human', async () => {
    const verifier = new BrowserCaptchaVerifier({
      gates: gates(null),
      handovers: handovers(aSession()),
    })

    const result = await verifier.verify(aSubmission(), { agent: anAgent() })

    expect(result.evidence).toMatch(/not expected to claim to be human/i)
  })

  /**
   * The badge and the promoting rung share a table, and clearing the easy page
   * must not hand out a badge for a hostile surface nobody crossed. The column
   * that keeps them apart is only useful if the verifier names its kind.
   */
  it('is not satisfied by a cleared capability challenge', async () => {
    const verifier = new BrowserCaptchaVerifier({
      gates: gates('2026-07-29T12:00:00.000Z' as Timestamp, CAPABILITY_STAGE),
      handovers: handovers(aSession()),
    })

    const result = await verifier.verify(aSubmission(), { agent: anAgent() })

    expect(result.status).toBe('fail')
  })

  /**
   * The property this rung exists for. The work happens in a browser, outside
   * the API, so a verifier that believed the payload would test nothing at all —
   * and the three rungs above are ordered on the assumption that this one is
   * real. Same rule as D-018 for Level 0.
   */
  it('ignores the payload entirely', async () => {
    const verifier = new BrowserCaptchaVerifier({
      gates: gates(null),
      handovers: handovers(null),
    })

    const claimed = await verifier.verify(
      aSubmission({
        payload: {
          solved: true,
          verifiedAt: '2026-07-28T12:00:00.000Z',
          operatorCleared: true,
          shareId: '77777777-7777-4777-8777-777777777777',
        },
      }),
      { agent: anAgent() },
    )

    expect(claimed.status).toBe('fail')
  })

  /**
   * A socket that dropped is still a handover: the person was on the tab when
   * the challenge went through, and what the network did a minute later says
   * nothing about that. The reason is reported rather than judged.
   */
  it('accepts a session that ended badly, and says how it ended', async () => {
    const verifier = new BrowserCaptchaVerifier({
      gates: gates(SOLVED),
      handovers: handovers(aSession(), 'lost'),
    })

    const result = await verifier.verify(aSubmission(), { agent: anAgent() })

    expect(result.status).toBe('pass')
    expect(result.metadata).toMatchObject({ closedFor: 'lost' })
  })

  it('treats a pass as permanent, though the challenge and the share are long gone', async () => {
    const longAgo = '2026-01-01T00:00:00.000Z' as Timestamp
    const verifier = new BrowserCaptchaVerifier({
      gates: gates(longAgo),
      handovers: handovers({
        acceptedAt: '2025-12-31T23:55:00.000Z' as Timestamp,
        closedAt: '2026-01-01T00:05:00.000Z' as Timestamp,
      }),
    })

    expect((await verifier.verify(aSubmission(), { agent: anAgent() })).status).toBe('pass')
  })
})
