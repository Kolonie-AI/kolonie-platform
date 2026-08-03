import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  encodeBase58,
  SubmissionIdSchema,
  TaskIdSchema,
  type Agent,
  type Submission,
} from '@kolonie-ai/core'
import { SolanaEarningVerifier } from './solana-earning.js'
import {
  creditTo,
  formatAmount,
  MINIMUM_LAMPORTS,
  MINIMUM_USDC_UNITS,
  USDC_MINT,
  type PaymentClaims,
  type SolanaAddresses,
  type SolanaReadResult,
  type SolanaRpc,
  type SolanaTransaction,
} from './solana-payment.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')
const OTHER_AGENT = AgentIdSchema.parse('44444444-4444-4444-8444-444444444444')

/** The citizen's proved address, and a payer. Any 32 bytes encode to one. */
const WALLET = encodeBase58(Uint8Array.from({ length: 32 }, (_, index) => index + 1))
const PAYER = encodeBase58(Uint8Array.from({ length: 32 }, (_, index) => index + 40))
const THIRD = encodeBase58(Uint8Array.from({ length: 32 }, (_, index) => index + 80))

/** A well-formed transaction signature: 64 bytes in base58. */
const TXID = encodeBase58(Uint8Array.from({ length: 64 }, (_, index) => (index * 7) % 251))

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'earner',
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

/**
 * A native SOL transaction as the chain reports one: index-aligned balances
 * over the account keys, in lamports.
 */
function solTransfer(options: {
  readonly to?: string
  readonly from?: string
  readonly lamports: bigint
  /** The fee the *payer* is additionally out of pocket for. */
  readonly fee?: bigint
  readonly err?: unknown
}): SolanaTransaction {
  const to = options.to ?? WALLET
  const from = options.from ?? PAYER
  const fee = options.fee ?? 5_000n
  const same = to === from

  return same
    ? {
        signature: TXID,
        err: options.err ?? null,
        accountKeys: [to],
        preBalances: [1_000_000_000],
        postBalances: [Number(1_000_000_000n - fee)],
        preTokenBalances: [],
        postTokenBalances: [],
      }
    : {
        signature: TXID,
        err: options.err ?? null,
        accountKeys: [from, to],
        preBalances: [1_000_000_000, 0],
        postBalances: [Number(1_000_000_000n - options.lamports - fee), Number(options.lamports)],
        preTokenBalances: [],
        postTokenBalances: [],
      }
}

/** A USDC transaction: balances carry owners rather than being index-aligned. */
function usdcTransfer(options: {
  readonly to?: string
  readonly from?: string
  readonly units: bigint
  readonly mint?: string
}): SolanaTransaction {
  const to = options.to ?? WALLET
  const from = options.from ?? PAYER
  const mint = options.mint ?? USDC_MINT

  return {
    signature: TXID,
    err: null,
    // The payer signs and pays the fee, so its lamports move. The citizen's
    // wallet is not a key in the message at all — its token account is, and the
    // Colony never sees that address. This is the case that breaks if a reader
    // matches on token accounts rather than on owners.
    accountKeys: [from],
    preBalances: [1_000_000_000],
    postBalances: [999_995_000],
    preTokenBalances: [
      { owner: from, mint, amount: '5000000' },
      { owner: to, mint, amount: '0' },
    ],
    postTokenBalances: [
      { owner: from, mint, amount: String(5_000_000n - options.units) },
      { owner: to, mint, amount: String(options.units) },
    ],
  }
}

const rpc = (result: SolanaReadResult): SolanaRpc => ({ getTransaction: async () => result })
const found = (transaction: SolanaTransaction): SolanaRpc => rpc({ outcome: 'found', transaction })

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
  const verifier = new SolanaEarningVerifier(
    { taskType: 'api-monetize', earned: 'payment for something you offered' },
    {
      rpc: options.rpc ?? found(solTransfer({ lamports: MINIMUM_LAMPORTS })),
      addresses: addresses(options.address === undefined ? WALLET : options.address),
      claims: claims(options.claimed),
    },
  )

  return verifier.verify(submissionWith(options.payload ?? { txid: TXID }), { agent })
}

describe('SolanaEarningVerifier', () => {
  it('passes a SOL payment from another wallet', async () => {
    const result = await verify({ rpc: found(solTransfer({ lamports: 2_000_000n })) })

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('0.002 SOL')
    expect(result.evidence).toContain(WALLET)
    expect(result.metadata).toMatchObject({
      txid: TXID,
      address: WALLET,
      source: PAYER,
      amount: '2000000',
      asset: 'SOL',
    })
  })

  it('passes a USDC payment, which the citizen holds through a token account', async () => {
    const result = await verify({ rpc: found(usdcTransfer({ units: 250_000n })) })

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('0.25 USDC')
    expect(result.metadata).toMatchObject({ asset: 'USDC', amount: '250000', source: PAYER })
  })

  /**
   * The metadata key is what `citizenForPaymentTxid` reads back out of
   * `verifications.metadata` in SQL, which no typechecker can hold to this file.
   * #42 is that hazard exactly, one rung over.
   */
  it('records the transaction under the key the claims query reads', async () => {
    const result = await verify({})

    expect(Object.keys(result.metadata ?? {})).toContain('txid')
  })

  it('refuses a payload with no txid', async () => {
    const result = await verify({ payload: {} })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('txid')
  })

  it('refuses a txid that is not a signature without asking the chain', async () => {
    let asked = false
    const result = await verify({
      payload: { txid: 'https://solscan.io/tx/whatever' },
      rpc: {
        getTransaction: async () => {
          asked = true
          return { outcome: 'not-found', reason: '' }
        },
      },
    })

    expect(result.status).toBe('fail')
    // The point of the syntactic check: a typo fails in a second rather than
    // sitting `pending` until the task times out three days later.
    expect(asked).toBe(false)
  })

  it('refuses an agent with no proved wallet, and names the rung below', async () => {
    const result = await verify({ address: null })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('solana-wallet')
  })

  it('refuses a transaction this citizen has already earned with', async () => {
    const result = await verify({ claimed: AGENT })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('already earned you')
  })

  it('refuses a transaction another citizen has already earned with', async () => {
    const result = await verify({ claimed: OTHER_AGENT })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('another citizen')
  })

  it('checks the claim before spending an RPC call on it', async () => {
    let asked = false
    await verify({
      claimed: AGENT,
      rpc: {
        getTransaction: async () => {
          asked = true
          return { outcome: 'not-found', reason: '' }
        },
      },
    })

    expect(asked).toBe(false)
  })

  it('refuses a transaction that failed on chain', async () => {
    const result = await verify({
      rpc: found(solTransfer({ lamports: 2_000_000n, err: { InstructionError: [0, 'Custom'] } })),
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('failed')
  })

  /**
   * Money appearing at the wallet with nobody out of pocket for it. A token
   * minted straight to the citizen is the reachable shape of this: real units,
   * a real balance increase, and no payer anywhere in the transaction.
   */
  it('refuses a credit that nobody funded', async () => {
    const result = await verify({
      rpc: found({
        signature: TXID,
        err: null,
        accountKeys: [WALLET],
        preBalances: [1_000_000_000],
        postBalances: [999_995_000],
        preTokenBalances: [{ owner: WALLET, mint: USDC_MINT, amount: '0' }],
        postTokenBalances: [{ owner: WALLET, mint: USDC_MINT, amount: '5000000' }],
      }),
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('not an earning')
  })

  /**
   * Moving USDC between two token accounts the same wallet owns nets to zero,
   * because the credit is summed over the *owner*. Shuffling your own money is
   * not a payment that failed a check — nothing arrived at all.
   */
  it('reads a citizen shuffling its own token accounts as nothing arriving', async () => {
    const result = await verify({
      rpc: found({
        signature: TXID,
        err: null,
        accountKeys: [WALLET],
        preBalances: [1_000_000_000],
        postBalances: [999_995_000],
        preTokenBalances: [
          { owner: WALLET, mint: USDC_MINT, amount: '5000000' },
          { owner: WALLET, mint: USDC_MINT, amount: '0' },
        ],
        postTokenBalances: [
          { owner: WALLET, mint: USDC_MINT, amount: '0' },
          { owner: WALLET, mint: USDC_MINT, amount: '5000000' },
        ],
      }),
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('nothing in it credits')
  })

  it('refuses dust', async () => {
    const result = await verify({ rpc: found(solTransfer({ lamports: 999_999n })) })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('below the floor')
  })

  it('accepts exactly the floor, so the boundary is inclusive', async () => {
    const result = await verify({ rpc: found(solTransfer({ lamports: MINIMUM_LAMPORTS })) })

    expect(result.status).toBe('pass')
  })

  it('refuses a transaction that credits some other wallet', async () => {
    const result = await verify({ rpc: found(solTransfer({ to: THIRD, lamports: 5_000_000n })) })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('nothing in it credits')
  })

  it('refuses a token that is not USDC, and says which one it counts', async () => {
    const result = await verify({
      rpc: found(usdcTransfer({ units: 5_000_000n, mint: PAYER })),
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain(USDC_MINT)
  })

  /**
   * An agent that was really paid must not lose its attempt to our outage
   * (#19), and it must not lose one to a chain that has not caught up either.
   * Both re-queue; neither is a verdict about the submission.
   */
  it('waits rather than failing when the endpoint cannot be read', async () => {
    const result = await verify({ rpc: rpc({ outcome: 'unavailable', reason: 'answered 429.' }) })

    expect(result.status).toBe('pending')
    expect(result.evidence).toContain("Colony's problem")
    // #253: the RPC endpoint is one the Colony chose and configured.
    expect(result.evidence).toContain('kolonie.support.open')
  })

  it('waits rather than failing when the transaction has not confirmed', async () => {
    const result = await verify({
      rpc: rpc({ outcome: 'not-found', reason: 'The endpoint returned no transaction for it.' }),
    })

    expect(result.status).toBe('pending')
    expect(result.evidence).toContain('stays')
    /**
     * **The second rejection case for `#253`.** A transaction that has not
     * confirmed is the chain working, not the Colony broken — the retry
     * genuinely is the whole answer, so no ticket is invited.
     */
    expect(result.evidence).not.toContain('kolonie.support.open')
  })

  it('verifies the task type it was configured for', () => {
    const verifier = new SolanaEarningVerifier(
      { taskType: 'bounty-hunter', earned: 'a bounty payout' },
      { rpc: found(solTransfer({ lamports: 1n })), addresses: addresses(WALLET), claims: claims() },
    )

    expect(verifier.taskType).toBe('bounty-hunter')
  })
})

describe('creditTo', () => {
  /**
   * The citizen may be the fee payer on the transaction that pays it — an x402
   * settlement is often submitted by the receiver. Its own lamport delta is then
   * credit minus fee, still positive, and the source must be the wallet that
   * actually paid rather than the citizen itself.
   */
  it('names the payer, not the citizen, when the citizen paid the fee', () => {
    const credit = creditTo(
      {
        signature: TXID,
        err: null,
        accountKeys: [WALLET, PAYER],
        preBalances: [10_000, 9_000_000],
        postBalances: [Number(10_000n - 5_000n + 3_000_000n), 6_000_000],
        preTokenBalances: [],
        postTokenBalances: [],
      },
      WALLET,
    )

    expect(credit).toMatchObject({ outcome: 'credited', source: PAYER, amount: 2_995_000n })
  })

  /** Lamports arriving with nobody debited — a staking reward, not an earning. */
  it('refuses a native credit nobody funded', () => {
    const credit = creditTo(
      {
        signature: TXID,
        err: null,
        accountKeys: [WALLET],
        preBalances: [0],
        postBalances: [5_000_000],
        preTokenBalances: [],
        postTokenBalances: [],
      },
      WALLET,
    )

    expect(credit.outcome).toBe('self-funded')
  })

  it('names the largest debit as the source, not whichever came first', () => {
    const credit = creditTo(
      {
        signature: TXID,
        err: null,
        accountKeys: [THIRD, PAYER, WALLET],
        preBalances: [1_000_000, 9_000_000, 0],
        postBalances: [900_000, 1_000_000, 8_100_000],
        preTokenBalances: [],
        postTokenBalances: [],
      },
      WALLET,
    )

    expect(credit).toMatchObject({ outcome: 'credited', source: PAYER })
  })

  it('reads nothing for an address the transaction never touched', () => {
    expect(creditTo(solTransfer({ lamports: 5_000_000n }), THIRD).outcome).toBe('nothing-arrived')
  })

  /**
   * A transaction that moves both is real — a swap that also refunds rent — and
   * the SOL leg is reported. Comparing the two would mean pricing SOL against
   * USDC, which is a market question a verifier has no business asking.
   */
  it('reports the native leg when a transaction moves both', () => {
    const credit = creditTo(
      {
        signature: TXID,
        err: null,
        accountKeys: [PAYER, WALLET],
        preBalances: [1_000_000_000, 0],
        postBalances: [990_000_000, 9_000_000],
        preTokenBalances: [{ owner: PAYER, mint: USDC_MINT, amount: '5000000' }],
        postTokenBalances: [
          { owner: PAYER, mint: USDC_MINT, amount: '4000000' },
          { owner: WALLET, mint: USDC_MINT, amount: '1000000' },
        ],
      },
      WALLET,
    )

    expect(credit).toMatchObject({ outcome: 'credited', asset: 'SOL' })
  })

  it('sums a wallet that holds the mint across two token accounts', () => {
    const credit = creditTo(
      {
        signature: TXID,
        err: null,
        accountKeys: [PAYER],
        preBalances: [1_000_000_000],
        postBalances: [999_995_000],
        preTokenBalances: [{ owner: PAYER, mint: USDC_MINT, amount: '5000000' }],
        postTokenBalances: [
          { owner: PAYER, mint: USDC_MINT, amount: '4000000' },
          { owner: WALLET, mint: USDC_MINT, amount: '600000' },
          { owner: WALLET, mint: USDC_MINT, amount: '400000' },
        ],
      },
      WALLET,
    )

    expect(credit).toMatchObject({ outcome: 'credited', asset: 'USDC', amount: 1_000_000n })
  })

  it('holds the USDC floor', () => {
    expect(creditTo(usdcTransfer({ units: MINIMUM_USDC_UNITS - 1n }), WALLET).outcome).toBe(
      'below-threshold',
    )
    expect(creditTo(usdcTransfer({ units: MINIMUM_USDC_UNITS }), WALLET).outcome).toBe('credited')
  })
})

describe('formatAmount', () => {
  it('renders lamports and USDC units at their own decimals', () => {
    expect(formatAmount(1_000_000n, 'SOL')).toBe('0.001 SOL')
    expect(formatAmount(1_500_000_000n, 'SOL')).toBe('1.5 SOL')
    expect(formatAmount(2_000_000_000n, 'SOL')).toBe('2 SOL')
    expect(formatAmount(10_000n, 'USDC')).toBe('0.01 USDC')
    expect(formatAmount(1_234_567n, 'USDC')).toBe('1.234567 USDC')
  })
})
