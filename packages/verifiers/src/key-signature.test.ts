import { generateKeyPairSync, sign as signWith } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  type Agent,
  type Submission,
} from '@kolonie-ai/core'
import { KeySignatureVerifier, type KeyAttempt, type SignedKeys } from './key-signature.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')

const NONCE = 'b7e2c0a1f3d4e5b6a7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4'

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'signer',
    platform: 'other',
    operator: null,
    bio: null,
    capabilities: ['x'],
    wallet: null,
  },
  status: 'candidate',
  accountType: 'citizen',
  roles: [],
  skills: [],
  createdAt: '2026-07-29T10:00:00.000Z',
  updatedAt: '2026-07-29T10:00:00.000Z',
}

const submission: Submission = {
  id: SubmissionIdSchema.parse('22222222-2222-4222-8222-222222222222'),
  taskId: TaskIdSchema.parse('33333333-3333-4333-8333-333333333333'),
  agentId: AGENT,
  payload: {},
  status: 'pending',
  assistance: 'unknown',
  attempt: 1,
  report: null,
  reportOutcome: null,
  submittedAt: '2026-07-29T10:00:00.000Z',
  verifiedAt: null,
}

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: (message: string) =>
      signWith(null, Buffer.from(message, 'utf8'), privateKey).toString('base64'),
  }
}

const keys = (attempt: KeyAttempt | null): SignedKeys => ({ latest: async () => attempt })

const verify = (attempt: KeyAttempt | null) =>
  new KeySignatureVerifier({ keys: keys(attempt) }).verify(submission, { agent })

const cleared = (over: string, key = ed25519()): KeyAttempt => ({
  nonce: NONCE,
  expiresAt: '2026-07-29T11:00:00.000Z',
  algorithm: 'ed25519',
  publicKey: key.publicKey,
  signature: key.sign(over),
  verifiedAt: '2026-07-29T10:05:00.000Z',
})

describe('KeySignatureVerifier', () => {
  it('passes a signature that recomputes over the issued nonce', async () => {
    const result = await verify(cleared(NONCE))

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('ed25519')
  })

  it('fails an agent that never minted a challenge, and says how to', async () => {
    const result = await verify(null)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('kolonie.academy.key.challenge')
  })

  it('fails an agent that minted and never signed, naming the open nonce', async () => {
    const result = await verify({
      nonce: NONCE,
      expiresAt: '2026-07-29T11:00:00.000Z',
      algorithm: null,
      publicKey: null,
      signature: null,
      verifiedAt: null,
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain(NONCE)
  })

  /**
   * **The assertion the recomputation exists for.** The row says the endpoint
   * accepted this signature; the signature is over something else. Nothing an
   * agent does produces this state — it is the two witnesses disagreeing, and
   * reading `verifiedAt` as the verdict would have paid for it.
   */
  it('fails a row marked cleared whose signature does not recompute', async () => {
    const result = await verify(cleared('a value the Colony never issued'))

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ recomputed: false })
  })

  it('fails a signature the endpoint never accepted', async () => {
    const key = ed25519()

    const result = await verify({
      nonce: NONCE,
      expiresAt: '2026-07-29T11:00:00.000Z',
      algorithm: 'ed25519',
      publicKey: key.publicKey,
      signature: key.sign(NONCE),
      verifiedAt: null,
    })

    expect(result.status).toBe('fail')
  })

  /**
   * A pass is permanent: the nonce expires, the capability does not. The expiry
   * here is in the past and the verdict is still a pass, because what is being
   * judged is whether the agent signed *while the nonce was open* — which
   * `verifiedAt` records and the constraint in `schema/keys.ts` enforces.
   */
  it('passes on an expired challenge that was signed in time', async () => {
    const result = await verify({ ...cleared(NONCE), expiresAt: '2020-01-01T00:00:00.000Z' })

    expect(result.status).toBe('pass')
  })

  it('never reads the submission payload (D-018)', async () => {
    const key = ed25519()
    const verifier = new KeySignatureVerifier({ keys: keys(null) })

    const result = await verifier.verify(
      { ...submission, payload: { publicKey: key.publicKey, signature: key.sign(NONCE) } },
      { agent },
    )

    expect(result.status).toBe('fail')
  })
})
