import { describe, expect, it } from 'vitest'
import { HELIUS_DELIVERY_MAX, HeliusDeliverySchema, nativeClaimsInDelivery } from './helius.js'

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
    nativeTransfers: [
      {
        fromUserAccount: 'a-payer',
        toUserAccount: 'the-colony-wallet',
        amount: 2_000_000,
      },
    ],
  },
]

describe('reading a Helius delivery', () => {
  it('takes the signature and the receiving wallet, and nothing else', () => {
    const delivery = HeliusDeliverySchema.parse(aDelivery())

    expect(nativeClaimsInDelivery(delivery)).toEqual([
      { signature: 'a-signature', address: 'the-colony-wallet' },
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
        nativeTransfers: [{ toUserAccount: 'the-colony-wallet', aNewField: 1 }],
      },
    ]

    expect(nativeClaimsInDelivery(HeliusDeliverySchema.parse(delivery))).toEqual([
      { signature: 'a-signature', address: 'the-colony-wallet' },
    ])
  })

  it('refuses a body that is not an array, which is what the old shape was', () => {
    expect(HeliusDeliverySchema.safeParse({ signature: 'a-signature' }).success).toBe(false)
  })

  it('refuses a delivery longer than a sender could plausibly batch', () => {
    const enormous = Array.from({ length: HELIUS_DELIVERY_MAX + 1 }, (_, index) => ({
      signature: `signature-${index}`,
      nativeTransfers: [],
    }))

    expect(HeliusDeliverySchema.safeParse(enormous).success).toBe(false)
  })

  /** One transaction, several hops into the same wallet, one signature to read. */
  it('deduplicates a signature that reaches the same address more than once', () => {
    const delivery = HeliusDeliverySchema.parse([
      {
        signature: 'a-signature',
        nativeTransfers: [
          { toUserAccount: 'the-colony-wallet' },
          { toUserAccount: 'the-colony-wallet' },
          { toUserAccount: 'another-address' },
        ],
      },
    ])

    expect(nativeClaimsInDelivery(delivery)).toEqual([
      { signature: 'a-signature', address: 'the-colony-wallet' },
      { signature: 'a-signature', address: 'another-address' },
    ])
  })

  it('reads every transaction in a batched delivery', () => {
    const delivery = HeliusDeliverySchema.parse([
      { signature: 'first', nativeTransfers: [{ toUserAccount: 'an-address' }] },
      { signature: 'second', nativeTransfers: [{ toUserAccount: 'an-address' }] },
    ])

    expect(nativeClaimsInDelivery(delivery)).toHaveLength(2)
  })

  /** A webhook may be configured more broadly than its reader cares about. */
  it('contributes nothing for a transaction that moved no token', () => {
    const delivery = HeliusDeliverySchema.parse([
      { signature: 'a-signature', type: 'UNKNOWN' },
      { signature: 'another-signature', nativeTransfers: [] },
    ])

    expect(nativeClaimsInDelivery(delivery)).toEqual([])
  })

  it('skips an entry with no receiving wallet rather than inventing one', () => {
    const delivery = HeliusDeliverySchema.parse([
      { signature: 'a-signature', nativeTransfers: [{ amount: 2_000_000 }] },
    ])

    expect(nativeClaimsInDelivery(delivery)).toEqual([])
  })
})
