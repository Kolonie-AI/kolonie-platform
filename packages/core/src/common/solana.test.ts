import { createPublicKey, generateKeyPairSync, sign as signWith } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  decodeBase58,
  encodeBase58,
  SolanaAddressSchema,
  SolanaSignatureSchema,
  solanaAddressToPem,
  verifySolanaSignature,
  SOLANA_ADDRESS_BYTES,
} from './solana.js'

const NONCE = 'b7e2c0a1f3d4e5b6a7c8d9e0f1a2b3c4'

/**
 * A wallet, the way a Solana SDK would present one: a base58 address and a
 * base58 signature over raw message bytes.
 *
 * The address is the *raw* key rather than the PEM `crypto` exports — the last
 * 32 bytes of the SPKI structure, which is exactly what a wallet shows.
 */
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })

  return {
    address: encodeBase58(Uint8Array.from(spki.subarray(spki.length - SOLANA_ADDRESS_BYTES))),
    sign: (message: string) =>
      encodeBase58(Uint8Array.from(signWith(null, Buffer.from(message, 'utf8'), privateKey))),
  }
}

describe('base58', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 3, 250, 251, 252, 253, 254, 255])

    expect(decodeBase58(encodeBase58(bytes))).toEqual(bytes)
  })

  /**
   * The case the naive implementation gets wrong: zero times 58 is still zero,
   * so leading zero bytes vanish unless they are counted back on separately.
   * Solana addresses with them are uncommon and entirely real.
   */
  it('keeps leading zero bytes, which base58 writes as ones', () => {
    const bytes = new Uint8Array(SOLANA_ADDRESS_BYTES)
    bytes[SOLANA_ADDRESS_BYTES - 1] = 7

    const encoded = encodeBase58(bytes)

    expect(encoded.startsWith('1')).toBe(true)
    expect(decodeBase58(encoded)).toEqual(bytes)
  })

  it.each(['0', 'O', 'I', 'l'])('refuses %s, which the alphabet omits', (character) => {
    expect(decodeBase58(`abc${character}def`)).toBeNull()
  })

  it('refuses an empty string rather than returning no bytes', () => {
    expect(decodeBase58('')).toBeNull()
  })
})

describe('SolanaAddressSchema', () => {
  it('accepts an address a wallet would produce', () => {
    expect(SolanaAddressSchema.safeParse(wallet().address).success).toBe(true)
  })

  /**
   * Well-formed base58 that is the wrong length. The length bounds alone let
   * this through, which is why the schema decodes.
   */
  it('refuses base58 that is not 32 bytes', () => {
    expect(SolanaAddressSchema.safeParse(encodeBase58(new Uint8Array(31))).success).toBe(false)
  })

  it('refuses a PEM public key, which is the other thing agents have to hand', () => {
    expect(SolanaAddressSchema.safeParse('-----BEGIN PUBLIC KEY-----').success).toBe(false)
  })
})

describe('SolanaSignatureSchema', () => {
  it('accepts a signature a wallet would produce', () => {
    const signer = wallet()

    expect(SolanaSignatureSchema.safeParse(signer.sign(NONCE)).success).toBe(true)
  })

  it('refuses base58 that is not 64 bytes', () => {
    expect(SolanaSignatureSchema.safeParse(encodeBase58(new Uint8Array(63))).success).toBe(false)
  })
})

describe('solanaAddressToPem', () => {
  it('produces a key node can parse as ed25519', () => {
    const pem = solanaAddressToPem(wallet().address)

    expect(pem).not.toBeNull()
    expect(createPublicKey(pem as string).asymmetricKeyType).toBe('ed25519')
  })

  it('is null for something that is not an address', () => {
    expect(solanaAddressToPem('not base58 at all!')).toBeNull()
  })
})

describe('verifySolanaSignature', () => {
  it('accepts a signature over the nonce by the address that made it', () => {
    const signer = wallet()

    expect(
      verifySolanaSignature({
        nonce: NONCE,
        address: signer.address,
        signature: signer.sign(NONCE),
      }),
    ).toBe(true)
  })

  it('refuses a signature over a different nonce', () => {
    const signer = wallet()

    expect(
      verifySolanaSignature({
        nonce: NONCE,
        address: signer.address,
        signature: signer.sign('a different nonce'),
      }),
    ).toBe(false)
  })

  /**
   * The farming case: one operator's signature offered under another citizen's
   * address. It has to fail on the cryptography, not only on the unique index.
   */
  it('refuses a valid signature made by a different wallet', () => {
    const signer = wallet()
    const other = wallet()

    expect(
      verifySolanaSignature({
        nonce: NONCE,
        address: other.address,
        signature: signer.sign(NONCE),
      }),
    ).toBe(false)
  })

  it.each([
    ['an address that is not base58', 'not base58 at all!', true],
    ['an address of the wrong length', encodeBase58(new Uint8Array(31)), true],
  ])('returns false rather than throwing for %s', (_case, address) => {
    const signer = wallet()

    expect(() =>
      verifySolanaSignature({ nonce: NONCE, address, signature: signer.sign(NONCE) }),
    ).not.toThrow()
    expect(verifySolanaSignature({ nonce: NONCE, address, signature: signer.sign(NONCE) })).toBe(
      false,
    )
  })

  it('returns false rather than throwing for a malformed signature', () => {
    const signer = wallet()

    expect(
      verifySolanaSignature({ nonce: NONCE, address: signer.address, signature: 'not base58!' }),
    ).toBe(false)
    expect(
      verifySolanaSignature({
        nonce: NONCE,
        address: signer.address,
        signature: encodeBase58(new Uint8Array(63)),
      }),
    ).toBe(false)
  })
})
