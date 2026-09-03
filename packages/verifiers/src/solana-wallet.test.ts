import { generateKeyPairSync, sign as signWith } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  encodeBase58,
  SubmissionIdSchema,
  TaskIdSchema,
  type Agent,
  type Submission,
} from '@kolonie-ai/core'
import {
  SolanaWalletVerifier,
  type SolanaWalletAttempt,
  type SolanaWallets,
} from './solana-wallet.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')

const NONCE = 'b7e2c0a1f3d4e5b6a7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4'

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'holder',
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
    declaredRhythmMinutes: null,
    vocation: null,
    disposition: null,
    goal: null,
    availability: null,
    profession: null,
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
  evidence: null,
}

/** A wallet as a Solana SDK presents one: base58 address, base58 signatures. */
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })

  return {
    address: encodeBase58(Uint8Array.from(spki.subarray(spki.length - 32))),
    sign: (message: string) =>
      encodeBase58(Uint8Array.from(signWith(null, Buffer.from(message, 'utf8'), privateKey))),
  }
}

const wallets = (attempt: SolanaWalletAttempt | null): SolanaWallets => ({
  latest: async () => attempt,
})

const verify = (attempt: SolanaWalletAttempt | null) =>
  new SolanaWalletVerifier({ wallets: wallets(attempt) }).verify(submission, { agent })

const cleared = (over: string, signer = wallet()): SolanaWalletAttempt => ({
  nonce: NONCE,
  expiresAt: '2026-07-29T11:00:00.000Z',
  address: signer.address,
  signature: signer.sign(over),
  verifiedAt: '2026-07-29T10:05:00.000Z',
})

describe('the solana wallet verifier', () => {
  it('passes a signature over the issued nonce', async () => {
    const signer = wallet()

    const result = await verify(cleared(NONCE, signer))

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain(signer.address)
    expect(result.metadata).toMatchObject({ address: signer.address })
  })

  /**
   * **The recomputation earning its keep.** The row says the endpoint accepted
   * this signature; the signature is over something else. Only one of the two
   * witnesses can be right, and the verifier is the one that decides.
   */
  it('fails a stored signature that does not verify, however it was recorded', async () => {
    const result = await verify(cleared('a value the Colony never issued'))

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ recomputed: false })
  })

  it('fails a valid signature stored under a different address', async () => {
    const signer = wallet()
    const other = wallet()

    const result = await verify({ ...cleared(NONCE, signer), address: other.address })

    expect(result.status).toBe('fail')
    expect(result.metadata).toMatchObject({ recomputed: false })
  })

  /** Each failure names the next move, because each is a different next move. */
  it('tells an agent that has minted nothing to mint a challenge', async () => {
    const result = await verify(null)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('kolonie.academy.solana.challenge')
  })

  it('tells an agent that minted and never signed to hand the signature back', async () => {
    const result = await verify({
      nonce: NONCE,
      expiresAt: '2026-07-29T11:00:00.000Z',
      address: null,
      signature: null,
      verifiedAt: null,
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain(NONCE)
    expect(result.evidence).toContain('kolonie.academy.answer with kind "solana.address"')
  })

  /** Base64 where the chain uses base58 is the likely first mistake, so it is named. */
  it('tells an agent whose signature was refused how to encode the next one', async () => {
    const signer = wallet()

    const result = await verify({
      nonce: NONCE,
      expiresAt: '2026-07-29T11:00:00.000Z',
      address: signer.address,
      signature: signer.sign('the wrong thing'),
      verifiedAt: null,
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('base58')
  })

  /**
   * A malformed value in the row must be a verdict, never an exception. The
   * runner has no better answer to a throw than to leave the submission
   * pending forever.
   */
  it('fails rather than throws on a stored value that is not base58', async () => {
    const result = await verify({
      nonce: NONCE,
      expiresAt: '2026-07-29T11:00:00.000Z',
      address: 'not an address at all!',
      signature: 'not a signature!',
      verifiedAt: '2026-07-29T10:05:00.000Z',
    })

    expect(result.status).toBe('fail')
  })

  /**
   * **A pass is permanent.** The nonce's hour is long gone and the wallet is
   * still the agent's, so an expiry in the past changes nothing about a row
   * that was signed while it was open.
   */
  it('passes a cleared attempt whose nonce has since expired', async () => {
    const result = await verify({ ...cleared(NONCE), expiresAt: '2026-07-29T09:00:00.000Z' })

    expect(result.status).toBe('pass')
  })

  it('reads nothing from the submission payload (D-018)', async () => {
    const signer = wallet()
    const claimed = wallet()
    const verifier = new SolanaWalletVerifier({ wallets: wallets(cleared(NONCE, signer)) })

    const result = await verifier.verify(
      { ...submission, payload: { address: claimed.address, signature: 'whatever' } },
      { agent },
    )

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain(signer.address)
    expect(result.evidence).not.toContain(claimed.address)
  })
})
