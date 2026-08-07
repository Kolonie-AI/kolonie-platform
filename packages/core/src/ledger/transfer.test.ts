import { describe, expect, it } from 'vitest'
import { createPrivateKey, verify as verifyWith } from 'node:crypto'
import { decodeBase58, encodeBase58, solanaAddressFromSeed } from '../common/solana.js'
import { compactU16, signSolTransfer, SYSTEM_PROGRAM_ID } from './transfer.js'

const SEED = 'F'.repeat(43)
const FROM = solanaAddressFromSeed(SEED) as string
const TO = encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => i + 1))
const BLOCKHASH = encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => 255 - i))

/**
 * D-106 (`#505`). The whole point of building this by hand is that it can be
 * read, so the tests check the bytes rather than that a library was called.
 */
describe('signing a SOL transfer', () => {
  const signed = signSolTransfer({
    fromSeed: SEED,
    fromAddress: FROM,
    toAddress: TO,
    lamports: 1_234_567,
    recentBlockhash: BLOCKHASH,
  })

  it('produces a transaction whose signature verifies over its own message', () => {
    expect(signed).not.toBeNull()

    const bytes = Buffer.from((signed as { transaction: string }).transaction, 'base64')
    // One signature, so: a count byte, 64 bytes of signature, then the message.
    expect(bytes[0]).toBe(1)
    const signature = bytes.subarray(1, 65)
    const message = bytes.subarray(65)

    // Verified against the *public* key the address is, rather than against the
    // private one: an address is a raw Ed25519 key, so this checks that the
    // signature belongs to the wallet the transfer claims to come from.
    const der = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(decodeBase58(SEED) as Uint8Array),
    ])
    const publicKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({
      format: 'jwk',
    })

    expect(publicKey.x).toBeDefined()
    expect(
      verifyWith(
        null,
        message,
        {
          key: Buffer.concat([
            Buffer.from('302a300506032b6570032100', 'hex'),
            Buffer.from(publicKey.x as string, 'base64url'),
          ]),
          format: 'der',
          type: 'spki',
        },
        signature,
      ),
    ).toBe(true)
  })

  /** The header and the account order are the format, not a choice. */
  it('names the payer, the recipient and the System Program, in that order', () => {
    const message = Buffer.from((signed as { transaction: string }).transaction, 'base64').subarray(
      65,
    )

    expect([...message.subarray(0, 3)]).toEqual([1, 0, 1])
    expect(message[3]).toBe(3)
    expect(encodeBase58(new Uint8Array(message.subarray(4, 36)))).toBe(FROM)
    expect(encodeBase58(new Uint8Array(message.subarray(36, 68)))).toBe(TO)
    expect(encodeBase58(new Uint8Array(message.subarray(68, 100)))).toBe(SYSTEM_PROGRAM_ID)
    expect(encodeBase58(new Uint8Array(message.subarray(100, 132)))).toBe(BLOCKHASH)
  })

  /**
   * A u64 written as two u32s is how a transfer of more than 4.29 SOL quietly
   * becomes a different transfer.
   */
  it('writes the amount as a little-endian u64', () => {
    const big = signSolTransfer({
      fromSeed: SEED,
      fromAddress: FROM,
      toAddress: TO,
      lamports: 5_000_000_000,
      recentBlockhash: BLOCKHASH,
    })
    const message = Buffer.from((big as { transaction: string }).transaction, 'base64').subarray(65)
    const data = message.subarray(message.length - 12)

    expect(data.readUInt32LE(0)).toBe(2)
    expect(data.readBigUInt64LE(4)).toBe(5_000_000_000n)
  })

  it('reports the signature base58, which is the transaction id on chain', () => {
    const bytes = Buffer.from((signed as { transaction: string }).transaction, 'base64')
    expect((signed as { signature: string }).signature).toBe(
      encodeBase58(new Uint8Array(bytes.subarray(1, 65))),
    )
  })

  describe('refuses rather than throws', () => {
    const base = {
      fromSeed: SEED,
      fromAddress: FROM,
      toAddress: TO,
      lamports: 1,
      recentBlockhash: BLOCKHASH,
    }

    it('an amount that is not a positive whole number', () => {
      expect(signSolTransfer({ ...base, lamports: 0 })).toBeNull()
      expect(signSolTransfer({ ...base, lamports: -1 })).toBeNull()
      expect(signSolTransfer({ ...base, lamports: 1.5 })).toBeNull()
    })

    it('an address that is not one', () => {
      expect(signSolTransfer({ ...base, toAddress: 'not-an-address' })).toBeNull()
      expect(signSolTransfer({ ...base, recentBlockhash: '0' })).toBeNull()
    })

    it('a secret that is not a 32-byte seed', () => {
      expect(signSolTransfer({ ...base, fromSeed: 'nope' })).toBeNull()
    })

    /** Far more likely a bug in whoever computed the recipient than a thing anybody meant. */
    it('paying itself', () => {
      expect(signSolTransfer({ ...base, toAddress: FROM })).toBeNull()
    })
  })
})

describe('compact-u16', () => {
  it('is one byte below 128 and grows by seven bits at a time', () => {
    expect([...compactU16(0)]).toEqual([0])
    expect([...compactU16(3)]).toEqual([3])
    expect([...compactU16(127)]).toEqual([127])
    expect([...compactU16(128)]).toEqual([0x80, 1])
    expect([...compactU16(16_384)]).toEqual([0x80, 0x80, 1])
  })
})
