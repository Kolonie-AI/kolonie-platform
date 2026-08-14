import { describe, expect, it } from 'vitest'
import { SubmissionSchema, type Submission } from '@kolonie-ai/core'
import { BrowserCaptchaVerifier } from './browser-captcha.js'

const aSubmission = ({
  payload = {},
  attempt = 1,
}: { payload?: Record<string, unknown>; attempt?: number } = {}): Submission =>
  SubmissionSchema.parse({
    id: '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    taskId: '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f',
    agentId: '11111111-2222-4333-8444-555555555555',
    payload,
    status: 'verifying',
    assistance: 'unknown',
    attempt,
    report: null,
    reportOutcome: null,
    submittedAt: '2026-07-28T10:00:00.000Z',
    verifiedAt: null,
    evidence: null,
  })

/**
 * **Rewritten for the retirement** (`#910`), and the handover assertions this
 * file used to carry are gone rather than skipped. They asserted a mechanism
 * that no longer exists (`#911`–`#914`), and a disabled test of a deleted
 * mechanism is a note in the wrong place — the history is on the task row and in
 * the class docblock, which is where somebody asking *why did this go* looks.
 *
 * What is left is the one property the class exists for: a submission that was
 * already open when the status flipped ends with a verdict rather than with
 * silence.
 */
describe('BrowserCaptchaVerifier', () => {
  it('fails every submission, because the badge cannot be earned', async () => {
    const result = await new BrowserCaptchaVerifier().verify(aSubmission())

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ retired: true, attempt: 1 })
  })

  /**
   * `#910`'s rejection case, and the reason this class was reduced rather than
   * deleted. An agent whose attempt was open when the rung was retired is
   * allowed to finish it (`storage/submissions.ts`: a retired task cannot be
   * started, only finished), and with no verifier registered `verifySubmission`
   * answers `skipped` and releases the row — leaving that submission in
   * `verifying` for as long as the runner keeps looking at it.
   */
  it('names the retirement rather than the share instructions', async () => {
    const result = await new BrowserCaptchaVerifier().verify(aSubmission())

    expect(result.evidence).toMatch(/retired on 2026-08-14/i)
    expect(result.evidence).toMatch(/cannot be earned/i)
    // The tools it used to send an agent to are being withdrawn. A verdict that
    // still named one would send a citizen looking for a fault in its own
    // runtime.
    expect(result.evidence).not.toMatch(/kolonie\.browser\.share/)
  })

  /**
   * The wording is the safety property on this rung, and retiring it does not
   * make that less true — a citizen reads this verdict at the moment it is
   * losing the one sanctioned way past such a page, which is exactly when the
   * pressure the rung was rebuilt to remove would come back.
   */
  it('tells the agent it is not expected to claim to be human', async () => {
    const result = await new BrowserCaptchaVerifier().verify(aSubmission())

    expect(result.evidence).toMatch(/not expected to claim to be human/i)
    // And that nothing is lost by the failure, which is true: it granted no
    // skill and nothing requires it.
    expect(result.evidence).toMatch(/costs you nothing/i)
  })

  /**
   * Unchanged from before the retirement, and for the same reason: the work
   * happened in a browser, outside the API, so a verifier that believed the
   * payload would test nothing. Retiring the rung is a poor moment to start
   * trusting a claim.
   */
  it('ignores the payload entirely', async () => {
    const result = await new BrowserCaptchaVerifier().verify(
      aSubmission({
        payload: {
          solved: true,
          verifiedAt: '2026-07-28T12:00:00.000Z',
          operatorCleared: true,
          shareId: '77777777-7777-4777-8777-777777777777',
        },
      }),
    )

    expect(result.status).toBe('fail')
  })

  it('reports the attempt it answered, as every verdict here does', async () => {
    const result = await new BrowserCaptchaVerifier().verify(aSubmission({ attempt: 3 }))

    expect(result.metadata).toMatchObject({ attempt: 3 })
  })
})
