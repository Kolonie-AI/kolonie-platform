import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  encodeBase58,
  PAYOUT_WALLET_SECRET_VAR,
  solanaAddressFromSeed,
  TREASURY_ADDRESS_VAR,
} from '@kolonie-ai/core'
import { FEE_RESERVE_LAMPORTS } from './payouts.js'
import {
  runTreasurySweep,
  sweepableLamports,
  type TreasuryDesk,
  type TreasurySweepDependencies,
} from './treasury.js'

/**
 * Moving the earned fee out of the hot wallet — `#507`.
 *
 * The first block is the one the issue calls *the one thing that cannot be got
 * wrong*, and it is deliberately asserted against the source and the exports
 * rather than against behaviour: a test that only exercised the happy path would
 * pass just as well on a version that had gained a Treasury key.
 */

/** A real seed and the address it actually derives, as `transfer.test.ts` does. */
const SEED = 'F'.repeat(43)
const WALLET = solanaAddressFromSeed(SEED) as string
const TREASURY = encodeBase58(Uint8Array.from({ length: 32 }, (_, index) => index + 1))

const desk = (over: Partial<Record<keyof TreasuryDesk, unknown>> = {}): TreasuryDesk => {
  const recorded: { lamports: number; signature: string; address: string }[] = []

  return {
    earned: async () => 0,
    swept: async () => 0,
    owed: async () => 0,
    lastSweepAt: async () => undefined,
    record: async (transfer) => {
      recorded.push(transfer)
      return true
    },
    ...(over as Partial<TreasuryDesk>),
    // Exposed for the assertions below without widening the port.
    ...({ recorded } as unknown as Partial<TreasuryDesk>),
  }
}

const chain = (balance: number) => ({
  balance: async () => balance,
  funded: async () => true,
  rentExemptMinimum: async () => 890_880,
  latestBlockhash: async () => '11111111111111111111111111111111',
  send: async () => 'a-signature',
})

const deps = (over: Partial<TreasurySweepDependencies> = {}): TreasurySweepDependencies => ({
  desk: desk(),
  chain: chain(10_000_000),
  wallet: { address: WALLET, secret: SEED },
  treasuryAddress: TREASURY,
  ...over,
})

describe('the one thing that cannot be got wrong', () => {
  const source = readFileSync(fileURLToPath(new URL('./treasury.ts', import.meta.url)), 'utf8')

  /**
   * **The Treasury key is never on the host, and the type is what enforces it.**
   * `TreasurySweepDependencies` carries exactly one secret and it is the payout
   * wallet's. A later change that reached for a Treasury key would have to add a
   * field, and this fails when it does.
   */
  it('names no Treasury secret anywhere in the module', () => {
    expect(source).not.toMatch(/treasurySecret|TREASURY_SECRET|treasuryKey|treasurySeed/i)
    // And it reads no environment at all: what it is given, it is given.
    expect(source).not.toContain('process.env')
  })

  /**
   * **`fromSeed` is the payout wallet's secret and nothing else.** This is the
   * one call that can move value, so what it is given is the whole of the
   * one-way property — and a regex over the source is the only check that
   * survives a refactor which keeps the behaviour and changes the argument.
   */
  it('signs only from the payout wallet', () => {
    const call = source.slice(source.indexOf('signSolTransfer({'))

    expect(call).toContain('fromSeed: wallet.secret')
    expect(call).toContain('fromAddress: wallet.address')
    expect(call).toContain('toAddress: treasuryAddress')
  })

  /**
   * And the direction, stated as an assertion rather than as a comment: the
   * Treasury is only ever a destination.
   */
  it('never uses the Treasury address as a source', () => {
    expect(source).not.toMatch(/fromAddress:\s*treasuryAddress/)
    expect(source).not.toMatch(/fromSeed:\s*treasury/i)
  })

  it('refuses to sweep to the wallet it sweeps from', async () => {
    const outcome = await runTreasurySweep(
      deps({ treasuryAddress: WALLET, desk: desk({ earned: async () => 5_000_000 }) }),
    )

    expect(outcome.sweptLamports).toBe(0)
    expect(outcome.refusal).toBe('not-configured')
  })
})

describe('what may be moved', () => {
  /**
   * The whole safety argument, stated without a chain: **the smaller of what has
   * been earned and what the wallet can spare.** A sweep sized by what is on
   * chain would take money the Colony owes somebody, which is the defect `#507`
   * names first.
   */
  it('is bounded by the earned fee', () => {
    const amount = sweepableLamports({
      earned: 1_000_000,
      swept: 0,
      balance: 50_000_000,
      owed: 0,
      reserve: FEE_RESERVE_LAMPORTS,
    })

    expect(amount).toBe(1_000_000)
  })

  it('is bounded by what the wallet can spare, and never touches what is owed', () => {
    const amount = sweepableLamports({
      earned: 10_000_000,
      swept: 0,
      balance: 3_000_000,
      owed: 2_000_000,
      reserve: FEE_RESERVE_LAMPORTS,
    })

    // 3,000,000 − 2,000,000 owed − 500,000 float.
    expect(amount).toBe(500_000)
  })

  it('is nothing when the balance is what the Colony owes', () => {
    expect(
      sweepableLamports({
        earned: 10_000_000,
        swept: 0,
        balance: 2_000_000,
        owed: 2_000_000,
        reserve: FEE_RESERVE_LAMPORTS,
      }),
    ).toBe(0)
  })

  it('counts what has already been swept', () => {
    expect(
      sweepableLamports({
        earned: 1_000_000,
        swept: 1_000_000,
        balance: 50_000_000,
        owed: 0,
        reserve: FEE_RESERVE_LAMPORTS,
      }),
    ).toBe(0)
  })

  /** A float that is already below the reserve cannot be swept into. */
  it('never returns a negative amount', () => {
    expect(
      sweepableLamports({
        earned: 1_000_000,
        swept: 0,
        balance: 1,
        owed: 0,
        reserve: FEE_RESERVE_LAMPORTS,
      }),
    ).toBe(0)
  })
})

describe('a sweep pass', () => {
  it('sends nothing on a deployment with no Treasury address', async () => {
    const outcome = await runTreasurySweep(deps({ treasuryAddress: undefined }))

    expect(outcome.refusal).toBe('not-configured')
    expect(outcome.sweptLamports).toBe(0)
  })

  it('sends nothing where nothing has been earned', async () => {
    const outcome = await runTreasurySweep(deps())

    expect(outcome.refusal).toBe('nothing-earned')
  })

  /**
   * **The interval is what makes the cadence a setting** (`D-104`). The host
   * timer fires every quarter of an hour; this is what decides whether a call
   * sends anything.
   */
  it('waits out the interval before sending again', async () => {
    const outcome = await runTreasurySweep(
      deps({
        desk: desk({
          earned: async () => 5_000_000,
          lastSweepAt: async () => new Date(1_000_000).toISOString(),
        }),
        intervalMs: async () => 3_600_000,
        now: () => 1_000_000 + 60_000,
      }),
    )

    expect(outcome.refusal).toBe('too-soon')
    expect(outcome.outstandingFeeLamports).toBe(5_000_000)
  })

  it('sends once the interval has passed', async () => {
    const outcome = await runTreasurySweep(
      deps({
        desk: desk({
          earned: async () => 5_000_000,
          lastSweepAt: async () => new Date(1_000_000).toISOString(),
        }),
        intervalMs: async () => 3_600_000,
        now: () => 1_000_000 + 7_200_000,
      }),
    )

    expect(outcome.refusal).toBeUndefined()
    expect(outcome.sweptLamports).toBe(5_000_000)
    expect(outcome.signature).toBe('a-signature')
  })

  /**
   * **The refusal that protects citizens**, and it is not an error: the fee
   * stays earned and unswept, and the next pass tries again.
   */
  it('defers rather than taking money the Colony owes', async () => {
    const outcome = await runTreasurySweep(
      deps({
        chain: chain(2_100_000),
        desk: desk({ earned: async () => 5_000_000, owed: async () => 2_000_000 }),
      }),
    )

    expect(outcome.refusal).toBe('float-would-not-cover-it')
    expect(outcome.sweptLamports).toBe(0)
    expect(outcome.outstandingFeeLamports).toBe(5_000_000)
    expect(outcome.owedLamports).toBe(2_000_000)
  })

  /**
   * **The receipt is written after the signature comes back and never before.**
   * A row written ahead of the send would, on a failure, subtract money that
   * never moved and strand it in the hot wallet for ever.
   */
  it('records nothing when the send throws', async () => {
    const recorded: unknown[] = []
    const failing = {
      ...chain(50_000_000),
      send: async () => {
        throw new Error('the endpoint said no')
      },
    }

    await expect(
      runTreasurySweep(
        deps({
          chain: failing,
          desk: {
            ...desk({ earned: async () => 5_000_000 }),
            record: async (transfer) => {
              recorded.push(transfer)
              return true
            },
          },
        }),
      ),
    ).rejects.toThrow('the endpoint said no')

    expect(recorded).toHaveLength(0)
  })

  it('records the amount, the signature and where it went', async () => {
    const recorded: { lamports: number; signature: string; address: string }[] = []

    await runTreasurySweep(
      deps({
        desk: {
          ...desk({ earned: async () => 5_000_000 }),
          record: async (transfer) => {
            recorded.push(transfer)
            return true
          },
        },
      }),
    )

    expect(recorded).toEqual([{ lamports: 5_000_000, signature: 'a-signature', address: TREASURY }])
  })
})

/**
 * The process reads one secret for this path and it is the payout wallet's.
 * Asserted here rather than in `server.test.ts` because this is the file a
 * reader checks when they want to know whether the Colony can spend the
 * Treasury.
 */
it('reads no environment variable that could hold a Treasury key', () => {
  const server = readFileSync(fileURLToPath(new URL('./server.ts', import.meta.url)), 'utf8')
  /**
   * Matched against the *source*, so what appears is the constant's name rather
   * than its value — `TREASURY_ADDRESS_VAR` and not `TREASURY_ADDRESS`. That is
   * the right thing to assert: the rule is that the process reaches for the
   * address constant and for no other Treasury-shaped variable, and a check
   * written against the resolved string would pass on a hard-coded read.
   */
  const treasuryReads = server.match(/process\.env\[[A-Za-z_]*TREASURY[A-Za-z_]*\]/g) ?? []

  expect(treasuryReads).toEqual(['process.env[TREASURY_ADDRESS_VAR]'])
  expect(TREASURY_ADDRESS_VAR).toBe('TREASURY_ADDRESS')
  // Same reason: the source names the constant, not the string behind it.
  expect(server).toContain('process.env[PAYOUT_WALLET_SECRET_VAR]')
  expect(PAYOUT_WALLET_SECRET_VAR).toBe('PAYOUT_WALLET_SECRET')
})
