import { describe, expect, it } from 'vitest'
import { USDC_MINT } from './deposits.js'
import { HELIUS_DELIVERY_MAX, HeliusDeliverySchema, claimsInDelivery } from './helius.js'

/**
 * A recorded enhanced delivery, trimmed to the fields Helius documents.
 *
 * Kept in the shape it arrives in — an array, with the transfer entries as
 * Helius names them — because the whole defect `#321` records was a shape
 * written from what the credit needed rather than from what the sender emits.
 */
const aDelivery = (): unknown => [
  {
    signature: 'a-signature',
    slot: 300_000_000,
    timestamp: 1_770_000_000,
    type: 'TRANSFER',
    fee: 5000,
    tokenTransfers: [
      {
        fromTokenAccount: 'a-payer-token-account',
        toTokenAccount: 'a-deposit-token-account',
        fromUserAccount: 'a-payer',
        toUserAccount: 'a-deposit-address',
        mint: USDC_MINT,
        tokenAmount: 12.5,
        tokenStandard: 'Fungible',
      },
    ],
    nativeTransfers: [],
  },
]

describe('reading a Helius delivery', () => {
  it('takes the signature and the receiving wallet, and nothing else', () => {
    const delivery = HeliusDeliverySchema.parse(aDelivery())

    expect(claimsInDelivery(delivery)).toEqual([
      { signature: 'a-signature', address: 'a-deposit-address' },
    ])
  })

  /**
   * The fields the old schema demanded are absent from every real delivery,
   * which is the whole of `#321`. Parsing must not start depending on them
   * again by accident.
   */
  it('parses a delivery that carries no token program and no commitment', () => {
    const parsed = HeliusDeliverySchema.safeParse(aDelivery())

    expect(parsed.success).toBe(true)
  })

  /** Helius adds fields; a strict schema would make that an outage. */
  it('keeps parsing when the sender adds fields nobody here reads', () => {
    const delivery = [
      {
        signature: 'a-signature',
        somethingNew: { nested: true },
        tokenTransfers: [{ toUserAccount: 'a-deposit-address', aNewField: 1 }],
      },
    ]

    expect(claimsInDelivery(HeliusDeliverySchema.parse(delivery))).toEqual([
      { signature: 'a-signature', address: 'a-deposit-address' },
    ])
  })

  it('refuses a body that is not an array, which is what the old shape was', () => {
    expect(HeliusDeliverySchema.safeParse({ signature: 'a-signature' }).success).toBe(false)
  })

  it('refuses a delivery longer than a sender could plausibly batch', () => {
    const enormous = Array.from({ length: HELIUS_DELIVERY_MAX + 1 }, (_, index) => ({
      signature: `signature-${index}`,
      tokenTransfers: [],
    }))

    expect(HeliusDeliverySchema.safeParse(enormous).success).toBe(false)
  })

  /** One transaction, several hops into the same wallet, one signature to read. */
  it('deduplicates a signature that reaches the same address more than once', () => {
    const delivery = HeliusDeliverySchema.parse([
      {
        signature: 'a-signature',
        tokenTransfers: [
          { toUserAccount: 'a-deposit-address' },
          { toUserAccount: 'a-deposit-address' },
          { toUserAccount: 'another-address' },
        ],
      },
    ])

    expect(claimsInDelivery(delivery)).toEqual([
      { signature: 'a-signature', address: 'a-deposit-address' },
      { signature: 'a-signature', address: 'another-address' },
    ])
  })

  it('reads every transaction in a batched delivery', () => {
    const delivery = HeliusDeliverySchema.parse([
      { signature: 'first', tokenTransfers: [{ toUserAccount: 'an-address' }] },
      { signature: 'second', tokenTransfers: [{ toUserAccount: 'an-address' }] },
    ])

    expect(claimsInDelivery(delivery)).toHaveLength(2)
  })

  /** A webhook may be configured more broadly than its reader cares about. */
  it('contributes nothing for a transaction that moved no token', () => {
    const delivery = HeliusDeliverySchema.parse([
      { signature: 'a-signature', type: 'UNKNOWN' },
      { signature: 'another-signature', tokenTransfers: [] },
    ])

    expect(claimsInDelivery(delivery)).toEqual([])
  })

  it('skips an entry with no receiving wallet rather than inventing one', () => {
    const delivery = HeliusDeliverySchema.parse([
      { signature: 'a-signature', tokenTransfers: [{ mint: USDC_MINT }] },
    ])

    expect(claimsInDelivery(delivery)).toEqual([])
  })
})
