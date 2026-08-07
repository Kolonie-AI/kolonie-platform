import { describe, expect, it } from 'vitest'
import { solanaAddressFromSeed } from '../common/solana.js'
import {
  LAMPORTS_PER_SOL,
  PAYOUT_WALLET_ADDRESS_VAR,
  PAYOUT_WALLET_SECRET_VAR,
  paymentQuarantine,
  payoutWalletMismatch,
  solFromLamports,
  type ObservedPayment,
} from './payments.js'

const COLONY = 'CoLoNyWaLLeTaDdReSs'

const aPayment = (overrides: Partial<ObservedPayment> = {}): ObservedPayment => ({
  signature: 'a-signature',
  sender: 'a-verified-wallet',
  recipient: COLONY,
  lamports: LAMPORTS_PER_SOL / 100,
  commitment: 'finalized',
  ...overrides,
})

/**
 * D-106 (`#503`).
 *
 * The tests that matter are the ones about **what must not be attributed**: an
 * arrival from an address nobody proved they control, the Colony's own outgoing
 * money read back as income, and anything at a commitment that can still
 * disappear.
 */
describe('recognising a payment at the Colony wallet', () => {
  it('attributes an arrival from a verified sender', () => {
    expect(paymentQuarantine(aPayment(), { verified: true }, COLONY)).toBeUndefined()
  })

  /**
   * The commonest real case, and the one D-106 tells a sponsor about before it
   * pays: an exchange withdrawal arrives from the exchange's hot wallet.
   */
  it('quarantines an arrival whose sender proved nothing', () => {
    expect(paymentQuarantine(aPayment(), { verified: false }, COLONY)).toBe('unverified-sender')
  })

  /**
   * `#505` pays citizens from this wallet and `#507` moves the fee out of it.
   * Neither may ever come back through the door as somebody's payment.
   */
  it('never attributes the Colony paying itself, even from a verified address', () => {
    expect(paymentQuarantine(aPayment({ sender: COLONY }), { verified: true }, COLONY)).toBe(
      'colony-sender',
    )
  })

  /** A quest that went live on money that then evaporated is the failure here. */
  it('decides nothing at a commitment that can still disappear', () => {
    expect(
      paymentQuarantine(aPayment({ commitment: 'confirmed' }), { verified: true }, COLONY),
    ).toBe('not-final')
    expect(
      paymentQuarantine(aPayment({ commitment: 'confirmed' }), { verified: false }, COLONY),
    ).toBe('not-final')
  })
})

/**
 * The check that has to happen at startup, because the failure it prevents is
 * silent: a seed handed to `fromSecretKey` derives a different keypair rather
 * than throwing.
 */
describe('the wallet the host holds', () => {
  /** A seed the test derives rather than one it hard-codes — the round trip is the point. */
  const seed = 'F'.repeat(43)

  it('accepts a secret that derives the declared address', () => {
    const derived = solanaAddressFromSeed(seed)
    expect(derived).not.toBeNull()
    expect(payoutWalletMismatch(derived as string, derived)).toBeUndefined()
  })

  it('refuses a secret that derives some other address, and names both variables', () => {
    const reason = payoutWalletMismatch('SomeOtherAddress', solanaAddressFromSeed(seed))
    expect(reason).toContain(PAYOUT_WALLET_SECRET_VAR)
    expect(reason).toContain(PAYOUT_WALLET_ADDRESS_VAR)
  })

  /** The 64-byte secret key every wallet exports is the shape that lands here wrongly. */
  it('refuses a secret that is not a 32-byte seed, and says what shape it wants', () => {
    const reason = payoutWalletMismatch('SomeAddress', null)
    expect(reason).toContain('32')
  })

  /** A message carrying a secret is a secret that has to be rotated. */
  it('puts neither half of the pair in the message', () => {
    const derived = solanaAddressFromSeed(seed) as string
    const reason = payoutWalletMismatch('SomeOtherAddress', derived) as string

    expect(reason).not.toContain(seed)
    expect(reason).not.toContain(derived)
  })
})

describe('lamports as a sentence', () => {
  it('says what a person would say', () => {
    expect(solFromLamports(LAMPORTS_PER_SOL)).toBe('1.0')
    expect(solFromLamports(LAMPORTS_PER_SOL / 2)).toBe('0.5')
    expect(solFromLamports(890_880)).toBe('0.00089088')
    expect(solFromLamports(0)).toBe('0.0')
  })
})
