import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  encodeBase58,
  SubmissionIdSchema,
  TaskIdSchema,
  type Agent,
  type Submission,
} from '@kolonie-ai/core'
import { SolanaTransactionVerifier, SOLANA_TRANSACTION_WINDOW_DAYS } from './solana-transaction.js'
import type {
  PaymentClaims,
  SolanaAddresses,
  SolanaReadResult,
  SolanaRpc,
  SolanaTransaction,
} from './solana-payment.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')
const OTHER_AGENT = AgentIdSchema.parse('44444444-4444-4444-8444-444444444444')

/** The citizen's proved address and somebody else's. Any 32 bytes encode to one. */
const WALLET = encodeBase58(Uint8Array.from({ length: 32 }, (_, index) => index + 1))
const STRANGER = encodeBase58(Uint8Array.from({ length: 32 }, (_, index) => index + 40))

/** A well-formed signature: 64 bytes in base58. */
const TXID = encodeBase58(Uint8Array.from({ length: 64 }, (_, index) => (index * 7) % 251))

const NOW = new Date('2026-08-09T12:00:00.000Z')
const daysAgo = (days: number): number => Math.floor(NOW.getTime() / 1000) - days * 24 * 60 * 60

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'spender',
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

/**
 * A transaction as the chain reports one, with the fee payer first.
 *
 * **The balances are here because the shape carries them and are read by
 * nothing in this rung** — which is the property the tests below are largely
 * about. No amount is read, so a fee-only transaction and a large transfer are
 * the same evidence.
 */
const transaction = (options: {
  readonly payer?: string
  readonly blockTime?: number | null
  readonly err?: unknown
}): SolanaTransaction => ({
  signature: TXID,
  err: options.err ?? null,
  blockTime: options.blockTime === undefined ? daysAgo(1) : options.blockTime,
  accountKeys: [options.payer ?? WALLET],
  preBalances: [1_000_000_000],
  postBalances: [999_995_000],
  preTokenBalances: [],
  postTokenBalances: [],
})

const rpc = (result: SolanaReadResult): SolanaRpc => ({ getTransaction: async () => result })
const found = (tx: SolanaTransaction): SolanaRpc => rpc({ outcome: 'found', transaction: tx })
const addresses = (address: string | null): SolanaAddresses => ({
  verifiedAddress: async () => address,
})
const claims = (citizen?: string): PaymentClaims => ({ citizenFor: async () => citizen })

function verify(options: {
  readonly payload?: Record<string, unknown>
  readonly rpc?: SolanaRpc
  readonly address?: string | null
  readonly claimed?: string
}) {
  const verifier = new SolanaTransactionVerifier({
    rpc: options.rpc ?? found(transaction({})),
    addresses: addresses(options.address === undefined ? WALLET : options.address),
    claims: claims(options.claimed),
    now: () => NOW,
  })

  return verifier.verify(submissionWith(options.payload ?? { txid: TXID }), { agent })
}

/**
 * The rung that certifies a citizen has moved something (`#624`).
 *
 * `solana-wallet` proves control of an address and stops there. This proves the
 * citizen can build, sign, pay for and confirm a transaction — the capability
 * that decides whether it can pay for anything at all.
 */
describe('SolanaTransactionVerifier', () => {
  it('passes a confirmed transaction the citizen’s own address paid for', async () => {
    const result = await verify({})

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain(WALLET)
  })

  /**
   * **The property the whole rung rests on.** The Colony supplies no funds, so a
   * rung reading an amount would be a rung for citizens that arrived rich — and
   * a self-transfer proves construction, signing, fee payment and confirmation,
   * which is every part of the capability.
   */
  it('reads no amount, so a fee-only self-transfer passes', async () => {
    const feeOnly: SolanaTransaction = {
      ...transaction({}),
      preBalances: [5_000],
      postBalances: [0],
    }

    expect((await verify({ rpc: found(feeOnly) })).status).toBe('pass')
  })

  /**
   * The first rejection case. The fee payer is what makes this about *this
   * citizen*: being listed among the signers of somebody else's transaction
   * means it signed something, not that it constructed, submitted or paid for
   * anything.
   */
  it('refuses a transaction another address paid for', async () => {
    const result = await verify({ rpc: found(transaction({ payer: STRANGER })) })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('paid for by another address')
    expect(result.evidence).toContain(WALLET)
  })

  /** The second. One signature carries one citizen past one rung. */
  it('refuses a signature another citizen has already used', async () => {
    const result = await verify({ claimed: OTHER_AGENT })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('already been counted for another citizen')
  })

  it('refuses a signature this citizen has already used, and says so differently', async () => {
    const result = await verify({ claimed: AGENT })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('already carried you past a rung')
  })

  it('refuses one that landed outside the window, and names it', async () => {
    const old = transaction({ blockTime: daysAgo(SOLANA_TRANSACTION_WINDOW_DAYS + 1) })

    const result = await verify({ rpc: found(old) })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain(String(SOLANA_TRANSACTION_WINDOW_DAYS))
  })

  it('accepts one at the edge of the window', async () => {
    const edge = transaction({ blockTime: daysAgo(SOLANA_TRANSACTION_WINDOW_DAYS - 1) })

    expect((await verify({ rpc: found(edge) })).status).toBe('pass')
  })

  /**
   * A gap in the Colony's reading is not the citizen's failure. `blockTime` is
   * null when the endpoint has none for the slot, and treating that as *outside
   * the window* would refuse somebody for an absence.
   */
  it('does not treat a missing timestamp as old', async () => {
    expect((await verify({ rpc: found(transaction({ blockTime: null })) })).status).toBe('pass')
  })

  it('refuses a transaction that failed on chain', async () => {
    const result = await verify({ rpc: found(transaction({ err: { InstructionError: [0, {}] } })) })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('failed there')
  })

  it('refuses a citizen with no proved address, and names the rung that gives one', async () => {
    const result = await verify({ address: null })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('solana-wallet')
  })

  it('refuses a payload with no signature, and says what to send', async () => {
    const result = await verify({ payload: {} })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('txid')
  })

  /** Shape before network, so a typo fails in a second rather than waiting out the task. */
  it('refuses something that is not a signature without reading the chain', async () => {
    let asked = 0
    const counting: SolanaRpc = {
      getTransaction: async () => {
        asked += 1
        return { outcome: 'not-found', reason: 'never asked' }
      },
    }

    const result = await verify({ payload: { txid: 'not-base58' }, rpc: counting })

    expect(result.status).toBe('fail')
    expect(asked).toBe(0)
  })

  /**
   * Neither of these is a failed rung. The Colony's own outage must never spend
   * a citizen's attempt, and a transaction that has not confirmed *yet* is a
   * fact about the chain right now rather than for ever.
   */
  it('waits rather than failing when the chain cannot be read', async () => {
    const result = await verify({ rpc: rpc({ outcome: 'unavailable', reason: 'endpoint down.' }) })

    expect(result.status).toBe('pending')
  })

  it('waits rather than failing when the transaction has not confirmed yet', async () => {
    const result = await verify({ rpc: rpc({ outcome: 'not-found', reason: 'Nothing under it.' }) })

    expect(result.status).toBe('pending')
  })
})
