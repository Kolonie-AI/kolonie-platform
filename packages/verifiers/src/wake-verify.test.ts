import { describe, expect, it } from 'vitest'
import {
  WAKE_KNOCK_HEADER,
  WAKE_SIGNATURE_HEADER,
  WAKE_TIMESTAMP_HEADER,
  wakeSignatureMatches,
  type AgentId,
  type Submission,
} from '@kolonie-ai/core'
import { WakeVerifyVerifier, type WakeChallengeTarget } from './wake-verify.js'

/**
 * The `wake` verifier (`#518`).
 *
 * **What is being checked is that the proof is an echo and not a signature.** A
 * citizen holds the secret from the moment it mints, so anything computed from
 * the secret proves nothing about having *received* a request — and a verifier
 * that accepted one would pass every agent that stood up no handler at all.
 */
describe('the wake verifier', () => {
  const agentId = '11111111-1111-4111-8111-111111111111' as AgentId
  const submission = { payload: {} } as unknown as Submission
  const context = { agent: { id: agentId } } as never

  const challenge: WakeChallengeTarget = {
    challengeId: '22222222-2222-4222-8222-222222222222',
    url: 'https://example.org/wake',
    secret: 'b'.repeat(64),
    knockNonce: 'c'.repeat(32),
  }

  const reader = (row: WakeChallengeTarget | null = challenge) => ({
    liveChallenge: async () => row ?? undefined,
  })

  it('passes when the handler answers with what it was sent', async () => {
    let seen: Record<string, string> | undefined

    const verifier = new WakeVerifyVerifier({
      challenges: reader(),
      fetch: async (_url, init) => {
        seen = init.headers as Record<string, string>
        return new Response(`{"knock":"${challenge.knockNonce}"}`, { status: 200 })
      },
    })

    const result = await verifier.verify(submission, context)

    expect(result.status).toBe('pass')

    // The knock is the delivery plus one header, so a handler that passes this
    // is a handler that will answer the real thing.
    const timestamp = seen?.[WAKE_TIMESTAMP_HEADER] as string
    expect(
      wakeSignatureMatches(challenge.secret, timestamp, seen?.[WAKE_SIGNATURE_HEADER] as string),
    ).toBe(true)
    expect(seen?.[WAKE_KNOCK_HEADER]).toBe(challenge.knockNonce)

    // The address is promoted by the verdict's transaction, from this.
    expect((result.metadata as { wake: { challengeId: string } }).wake.challengeId).toBe(
      challenge.challengeId,
    )
  })

  it('fails when the handler answers without the nonce, however correctly', async () => {
    const verifier = new WakeVerifyVerifier({
      challenges: reader(),
      // A handler that answers 200 and says nothing is the ordinary near-miss:
      // it is listening, and it has not shown that it read what arrived.
      fetch: async () => new Response('ok', { status: 200 }),
    })

    const result = await verifier.verify(submission, context)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain(WAKE_KNOCK_HEADER)
    expect(result.metadata).toBeUndefined()
  })

  it('fails when the handler answers with a status outside 2xx', async () => {
    const verifier = new WakeVerifyVerifier({
      challenges: reader(),
      fetch: async () => new Response(challenge.knockNonce, { status: 404 }),
    })

    const result = await verifier.verify(submission, context)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('404')
  })

  it('fails without contacting anything when the address is not public', async () => {
    let called = false

    const verifier = new WakeVerifyVerifier({
      challenges: reader({ ...challenge, url: 'https://127.0.0.1/wake' }),
      fetch: async () => {
        called = true
        return new Response(challenge.knockNonce, { status: 200 })
      },
    })

    const result = await verifier.verify(submission, context)

    expect(called).toBe(false)
    expect(result.status).toBe('fail')
  })

  it('fails with something to do when the citizen has no challenge open', async () => {
    const verifier = new WakeVerifyVerifier({
      challenges: reader(null),
      // Nothing should be contacted, and an injected fetch that throws says so
      // rather than letting a regression reach the network.
      fetch: async () => {
        throw new Error('the verifier contacted something with no challenge open')
      },
    })

    const result = await verifier.verify(submission, context)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('wake.endpoint')
  })

  it('says the deadline is for acknowledging when nothing answered in time', async () => {
    const verifier = new WakeVerifyVerifier({
      challenges: reader(),
      timeoutMs: 5_000,
      fetch: async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      },
    })

    const result = await verifier.verify(submission, context)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('acknowledgement')
  })
})
