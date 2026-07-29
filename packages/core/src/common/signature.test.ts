import { generateKeyPairSync, sign as signWith } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  checkPublicKey,
  PublicKeyPemSchema,
  SIGNATURE_ALGORITHMS,
  verifySignature,
  type SignatureAlgorithm,
} from './signature.js'

const NONCE = 'b7e2c0a1f3d4e5b6a7c8d9e0f1a2b3c4'

function keypair(algorithm: SignatureAlgorithm) {
  const { publicKey, privateKey } =
    algorithm === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', { namedCurve: 'secp256k1' })

  return {
    algorithm,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: (message: string) =>
      signWith(
        algorithm === 'ed25519' ? null : 'sha256',
        Buffer.from(message, 'utf8'),
        privateKey,
      ).toString('base64'),
  }
}

describe('the accepted algorithms', () => {
  it('is a closed set of two', () => {
    expect(SIGNATURE_ALGORITHMS).toEqual(['ed25519', 'secp256k1'])
  })
})

describe('checkPublicKey', () => {
  it.each(SIGNATURE_ALGORITHMS)('recognises a %s key as itself', (algorithm) => {
    expect(checkPublicKey(keypair(algorithm).publicKey, algorithm)).toEqual({ outcome: 'ok' })
  })

  /**
   * Named rather than folded into a plain failure: an agent that sent the right
   * key under the wrong label needs to fix its label, and one whose signature is
   * wrong needs to fix its signing. Telling them apart is the difference between
   * a one-line fix and re-reading everything.
   */
  it('names what the key actually is when it is not what the caller said', () => {
    expect(checkPublicKey(keypair('ed25519').publicKey, 'secp256k1')).toEqual({
      outcome: 'mismatch',
      actual: 'ed25519',
    })
  })

  it('reports something that is not a key as unparseable rather than throwing', () => {
    expect(checkPublicKey('not a key at all', 'ed25519')).toEqual({ outcome: 'unparseable' })
  })

  /**
   * An RSA key parses perfectly well and is not on the list. The closed set is
   * what stops the accepted algorithms growing every time the runtime's crypto
   * library gains one, without anybody deciding.
   */
  it('refuses a key of an algorithm outside the set', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

    expect(checkPublicKey(pem, 'ed25519')).toEqual({ outcome: 'mismatch', actual: 'rsa' })
  })
})

describe('verifySignature', () => {
  it.each(SIGNATURE_ALGORITHMS)('accepts a real %s signature over the nonce', (algorithm) => {
    const key = keypair(algorithm)

    expect(
      verifySignature({
        nonce: NONCE,
        publicKey: key.publicKey,
        algorithm,
        signature: key.sign(NONCE),
      }),
    ).toBe(true)
  })

  it('refuses a signature over a different message', () => {
    const key = keypair('ed25519')

    expect(
      verifySignature({
        nonce: NONCE,
        publicKey: key.publicKey,
        algorithm: 'ed25519',
        signature: key.sign('something else'),
      }),
    ).toBe(false)
  })

  it('refuses a signature by a different key', () => {
    const mine = keypair('ed25519')
    const theirs = keypair('ed25519')

    expect(
      verifySignature({
        nonce: NONCE,
        publicKey: mine.publicKey,
        algorithm: 'ed25519',
        signature: theirs.sign(NONCE),
      }),
    ).toBe(false)
  })

  it('refuses a key that is not the named algorithm', () => {
    const key = keypair('ed25519')

    expect(
      verifySignature({
        nonce: NONCE,
        publicKey: key.publicKey,
        algorithm: 'secp256k1',
        signature: key.sign(NONCE),
      }),
    ).toBe(false)
  })

  /**
   * **Never throws.** Every one of these is an ordinary thing for an agent to
   * get wrong on a first attempt, and every one of them reaching a caller as a
   * 500 would be the Colony reporting its own bug for the agent's typo.
   */
  it.each([
    ['not base64 at all', '!!!not base64!!!'],
    ['an empty signature', ''],
    ['truncated DER', 'MEQCIA=='],
  ])('answers false rather than throwing on %s', (_label, signature) => {
    const key = keypair('ed25519')

    expect(() =>
      verifySignature({ nonce: NONCE, publicKey: key.publicKey, algorithm: 'ed25519', signature }),
    ).not.toThrow()
    expect(
      verifySignature({ nonce: NONCE, publicKey: key.publicKey, algorithm: 'ed25519', signature }),
    ).toBe(false)
  })

  it('answers false rather than throwing on a public key that is not one', () => {
    expect(
      verifySignature({
        nonce: NONCE,
        publicKey: 'garbage',
        algorithm: 'ed25519',
        signature: 'AAAA',
      }),
    ).toBe(false)
  })
})

describe('PublicKeyPemSchema', () => {
  it('accepts what standard tooling exports', () => {
    expect(PublicKeyPemSchema.safeParse(keypair('ed25519').publicKey).success).toBe(true)
  })

  /**
   * Raw bytes are refused, and that is a decision rather than fussiness: PEM
   * says which algorithm and which curve the key is for, so a caller cannot
   * choose how its own key material gets interpreted.
   */
  it('refuses a raw key with no PEM header', () => {
    expect(PublicKeyPemSchema.safeParse('AAAAC3NzaC1lZDI1NTE5AAAAIExample').success).toBe(false)
  })
})
