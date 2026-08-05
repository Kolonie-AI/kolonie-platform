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
  decide,
  realisedGain,
  SolanaTraderVerifier,
  TRADER_LOOKBACK_DAYS,
  TRADER_MAX_TRANSACTIONS,
} from './solana-trader.js'
import {
  USDC_MINT,
  type SolanaAddresses,
  type SolanaHistory,
  type SolanaRpc,
  type SolanaTransaction,
} from './solana-payment.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')
const WALLET = encodeBase58(Uint8Array.from({ length: 32 }, (_, index) => index + 1))
const VENUE = encodeBase58(Uint8Array.from({ length: 32 }, (_, index) => index + 40))

/** A token the Colony does not price — a memecoin, in the tests' shorthand. */
const MEME = encodeBase58(Uint8Array.from({ length: 32 }, (_, index) => index + 90))

const NOW = Date.parse('2026-07-31T12:00:00.000Z')
const clock = () => NOW
const daysAgo = (days: number) => Math.floor(NOW / 1000) - days * 24 * 60 * 60

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'trader',
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
    vocation: null,
    disposition: null,
    goal: null,
  },
  status: 'citizen',
  accountType: 'citizen',
  roles: [],
  skills: [],
  createdAt: '2026-07-01T10:00:00.000Z',
  updatedAt: '2026-07-01T10:00:00.000Z',
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
  submittedAt: '2026-07-31T10:00:00.000Z',
  verifiedAt: null,
  evidence: null,
}

/**
 * A transaction as balances, which is all this verifier reads. `sol` and `usdc`
 * are the wallet's own deltas; `meme` stands for anything the Colony cannot
 * price.
 */
function tx(options: {
  readonly signature: string
  readonly sol?: bigint
  readonly usdc?: bigint
  readonly meme?: bigint
  readonly err?: unknown
}): SolanaTransaction {
  const sol = options.sol ?? 0n
  const usdc = options.usdc ?? 0n
  const meme = options.meme ?? 0n
  const base = 100_000_000_000n

  const token = (mint: string, amount: bigint) => [{ owner: WALLET, mint, amount: String(amount) }]

  return {
    signature: options.signature,
    err: options.err ?? null,
    accountKeys: [WALLET, VENUE],
    preBalances: [Number(base), 0],
    postBalances: [Number(base + sol), 0],
    preTokenBalances: [...token(USDC_MINT, base), ...token(MEME, base)],
    postTokenBalances: [...token(USDC_MINT, base + usdc), ...token(MEME, base + meme)],
  }
}

const history = (
  signatures: readonly { signature: string; blockTime: number | null }[],
): SolanaHistory => ({
  signaturesFor: async () => ({ outcome: 'found', signatures }),
})

const chain = (transactions: readonly SolanaTransaction[]): SolanaRpc => ({
  getTransaction: async (txid) => {
    const found = transactions.find((transaction) => transaction.signature === txid)
    return found === undefined
      ? { outcome: 'not-found', reason: 'stub' }
      : { outcome: 'found', transaction: found }
  },
})

const addresses = (address: string | null): SolanaAddresses => ({
  verifiedAddress: async () => address,
})

/** A verifier over a set of transactions, all dated inside the window. */
function verifyOver(
  transactions: readonly SolanaTransaction[],
  options: { readonly address?: string | null; readonly at?: number } = {},
) {
  return new SolanaTraderVerifier({
    rpc: chain(transactions),
    history: history(
      transactions.map((transaction) => ({
        signature: transaction.signature,
        blockTime: options.at ?? daysAgo(3),
      })),
    ),
    addresses: addresses(options.address === undefined ? WALLET : options.address),
    clock,
  }).verify(submission, { agent })
}

describe('realisedGain', () => {
  /**
   * The discriminator that replaced the issue's list of DEX program addresses:
   * a swap gives something up and receives something back, a payment only
   * receives. It needs no list, so it cannot go stale — and the list the issue
   * shipped was already unusable, carrying a `'Jito4QyX....'` placeholder.
   */
  it('reads a swap as a trade and a payment as not one', () => {
    const swap = realisedGain([tx({ signature: 'a', sol: -1_000_000_000n, meme: 5n })], WALLET)
    const payment = realisedGain([tx({ signature: 'b', sol: 2_000_000_000n })], WALLET)

    expect(swap.trades).toBe(1)
    expect(payment.trades).toBe(0)
  })

  /**
   * Every transaction costs its fee payer lamports, so a payment the citizen
   * signed for itself shows a tiny negative SOL leg. Without the dust bound that
   * reads as "gave something up" and every payment becomes a trade.
   */
  it('does not read a fee as a leg', () => {
    const gain = realisedGain([tx({ signature: 'a', sol: -5_000n, usdc: 50_000_000n })], WALLET)

    expect(gain.trades).toBe(0)
  })

  it('sums a closed round trip, fees included', () => {
    // Out of SOL into the memecoin, then back out of it into more SOL.
    const gain = realisedGain(
      [
        tx({ signature: 'a', sol: -1_000_000_000n, meme: 500n }),
        tx({ signature: 'b', sol: 1_400_000_000n, meme: -500n }),
      ],
      WALLET,
    )

    expect(gain.trades).toBe(2)
    expect(gain.lamports).toBe(400_000_000n)
    expect(gain.usdc).toBe(0n)
  })

  it('ignores a transaction that failed on chain', () => {
    const gain = realisedGain(
      [tx({ signature: 'a', sol: -1_000_000_000n, meme: 5n, err: { some: 'error' } })],
      WALLET,
    )

    expect(gain.trades).toBe(0)
  })

  it('reads nothing for an address that is not the wallet', () => {
    expect(
      realisedGain([tx({ signature: 'a', sol: -1_000_000_000n, meme: 5n })], VENUE).trades,
    ).toBe(0)
  })
})

describe('decide', () => {
  it('calls up in one and level in the other a profit', () => {
    expect(decide({ trades: 2, lamports: 400_000_000n, usdc: 0n }).outcome).toBe('profit')
    expect(decide({ trades: 2, lamports: 0n, usdc: 5_000_000n }).outcome).toBe('profit')
  })

  it('calls down in both a loss', () => {
    expect(decide({ trades: 2, lamports: -1n, usdc: -1n }).outcome).toBe('loss')
  })

  it('calls exactly nothing flat', () => {
    expect(decide({ trades: 2, lamports: 0n, usdc: 0n }).outcome).toBe('flat')
  })

  /**
   * The case the whole design turns on. Value moved out of USDC and into SOL and
   * is sitting there; whether that was profitable is a question about the
   * SOL/USDC price at the moment of the trade. The Colony reads no price feed,
   * so it declines rather than guessing — and says so.
   */
  it('refuses to price a position that is still open', () => {
    expect(decide({ trades: 1, lamports: 5_000_000_000n, usdc: -800_000_000n }).outcome).toBe(
      'open-position',
    )
    expect(decide({ trades: 1, lamports: -5_000_000_000n, usdc: 800_000_000n }).outcome).toBe(
      'open-position',
    )
  })
})

describe('SolanaTraderVerifier', () => {
  it('passes a wallet that closed a round trip in profit', async () => {
    const result = await verifyOver([
      tx({ signature: 'a', sol: -1_000_000_000n, meme: 500n }),
      tx({ signature: 'b', sol: 1_400_000_000n, meme: -500n }),
    ])

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('0.4 SOL in')
    expect(result.metadata).toMatchObject({ trades: 2, lamports: '400000000', address: WALLET })
  })

  it('fails a wallet that traded at a loss, and says the window moves', async () => {
    const result = await verifyOver([
      tx({ signature: 'a', sol: -2_000_000_000n, meme: 500n }),
      tx({ signature: 'b', sol: 1_400_000_000n, meme: -500n }),
    ])

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('a loss')
    expect(result.evidence).toContain('better month')
  })

  it('tells an agent holding an open position how to come back', async () => {
    const result = await verifyOver([
      tx({ signature: 'a', sol: 5_000_000_000n, usdc: -800_000_000n }),
    ])

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('Close the position')
  })

  it('refuses an agent with no proved wallet', async () => {
    const result = await verifyOver([], { address: null })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('solana-wallet')
  })

  it('separates a wallet that was only paid from one that traded', async () => {
    const result = await verifyOver([tx({ signature: 'a', sol: 9_000_000_000n })])

    expect(result.status).toBe('fail')
    // The agent is pointed at the rung that *does* certify being paid, rather
    // than being told something vague about trades.
    expect(result.evidence).toContain('other three earning tasks')
  })

  it('fails a wallet with nothing in the window', async () => {
    const result = await verifyOver([tx({ signature: 'a', sol: -1_000_000_000n, meme: 5n })], {
      at: daysAgo(TRADER_LOOKBACK_DAYS + 5),
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain(`last ${TRADER_LOOKBACK_DAYS} days`)
  })

  /**
   * Reading the first N of a busier history and calling the total a net result
   * would be a number with no relationship to the wallet: the transactions left
   * out are exactly the ones that could reverse it.
   */
  it('declines to judge a wallet busier than it reads, rather than sampling it', async () => {
    const many = Array.from({ length: TRADER_MAX_TRANSACTIONS }, (_, index) =>
      tx({ signature: `sig-${index}`, sol: 1_000_000_000n, meme: -5n }),
    )
    const result = await verifyOver(many)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('more than this rung reads')
  })

  it('waits rather than failing when the history cannot be read', async () => {
    const result = await new SolanaTraderVerifier({
      rpc: chain([]),
      history: { signaturesFor: async () => ({ outcome: 'unavailable', reason: 'answered 429.' }) },
      addresses: addresses(WALLET),
      clock,
    }).verify(submission, { agent })

    expect(result.status).toBe('pending')
    // #253: our RPC endpoint, so the citizen is told the Colony may not know.
    expect(result.evidence).toContain('kolonie.support.open')
  })

  it('waits rather than failing when a transaction cannot be read', async () => {
    const result = await new SolanaTraderVerifier({
      rpc: { getTransaction: async () => ({ outcome: 'unavailable', reason: 'answered 429.' }) },
      history: history([{ signature: 'a', blockTime: daysAgo(2) }]),
      addresses: addresses(WALLET),
      clock,
    }).verify(submission, { agent })

    expect(result.status).toBe('pending')
    expect(result.evidence).toContain("Colony's problem")
    expect(result.evidence).toContain('kolonie.support.open')
  })

  /**
   * D-018: what an agent puts in a payload is a claim, not evidence. The address
   * comes from the Colony's own record, so a submission naming somebody else's
   * profitable wallet reads that agent's own wallet and finds nothing.
   */
  it('reads the Colony’s record rather than an address in the payload', async () => {
    const asked: string[] = []
    const result = await new SolanaTraderVerifier({
      rpc: chain([]),
      history: {
        signaturesFor: async (address) => {
          asked.push(address)
          return { outcome: 'found', signatures: [] }
        },
      },
      addresses: addresses(WALLET),
      clock,
    }).verify({ ...submission, payload: { address: VENUE } }, { agent })

    expect(asked).toEqual([WALLET])
    expect(result.status).toBe('fail')
  })
})
