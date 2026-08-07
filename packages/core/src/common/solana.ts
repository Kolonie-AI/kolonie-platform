import { createPrivateKey } from 'node:crypto'
import { z } from 'zod'
import { verifySignature } from './signature.js'

/**
 * Bitcoin's base58 alphabet, which is the one Solana uses.
 *
 * The four omissions are the whole point of the encoding: `0`, `O`, `I` and `l`
 * are absent, so an address that survives being read aloud or retyped cannot
 * quietly become a different address. The Colony copies addresses rather than
 * dictating them, but the alphabet is not ours to choose — it is what every
 * Solana wallet emits.
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** How many bytes a Solana address is: a raw Ed25519 public key. */
export const SOLANA_ADDRESS_BYTES = 32

/** How many bytes an Ed25519 signature is. */
export const SOLANA_SIGNATURE_BYTES = 64

/**
 * The character bounds of a base58 address. 32 bytes encode to 43 or 44
 * characters, and to fewer when the key begins with zero bytes — a real
 * occurrence, not a theoretical one, which is why the floor is well below the
 * common length. The decode is what actually decides; these bounds only keep a
 * megabyte of text out of the column.
 */
export const MAX_SOLANA_ADDRESS_LENGTH = 44
export const MAX_SOLANA_SIGNATURE_LENGTH = 88

/**
 * An address as the agent hands it over, checked for shape rather than for
 * meaning.
 *
 * The refinement decodes, because a length range over the base58 alphabet
 * accepts plenty of strings that are not 32 bytes. What it does **not** check is
 * whether the address is on the Ed25519 curve: a Solana address may legitimately
 * be a program-derived address that lies off it, and such an address cannot sign
 * — so rejecting it here would give an agent a validation error where it needs
 * the more useful *"that key did not sign this nonce"*.
 */
export const SolanaAddressSchema = z
  .string()
  .min(1)
  .max(MAX_SOLANA_ADDRESS_LENGTH)
  .refine((value) => decodeBase58(value)?.length === SOLANA_ADDRESS_BYTES, {
    message: `expected a base58 Solana address decoding to ${SOLANA_ADDRESS_BYTES} bytes`,
  })

/** A signature over the nonce, base58 — what every Solana SDK returns. */
export const SolanaSignatureSchema = z
  .string()
  .min(1)
  .max(MAX_SOLANA_SIGNATURE_LENGTH)
  .refine((value) => decodeBase58(value)?.length === SOLANA_SIGNATURE_BYTES, {
    message: `expected a base58 signature decoding to ${SOLANA_SIGNATURE_BYTES} bytes`,
  })

/**
 * Decode base58, or `null` if the string is not base58 at all.
 *
 * Never throws, for the same reason {@link verifySignature} never throws: every
 * way an agent can get this wrong on a first attempt — a pasted `0`, a truncated
 * copy, an address with a stray space — is an ordinary mistake and none of them
 * should reach a caller as a 500.
 *
 * The algorithm is the plain one: treat the string as a big number and carry it
 * into a byte array. An address is 44 characters, so nothing here is worth
 * optimising, and a dependency would buy speed the Colony has no use for at a
 * cost it does have a use for — `packages/verifiers` depends on this package and
 * on nothing else, which is what lets a verifier be reviewed by reading it.
 */
export function decodeBase58(value: string): Uint8Array | null {
  if (value.length === 0) return null

  const bytes: number[] = []

  for (const character of value) {
    let carry = BASE58_ALPHABET.indexOf(character)
    if (carry < 0) return null

    for (let index = 0; index < bytes.length; index += 1) {
      carry += (bytes[index] as number) * 58
      bytes[index] = carry & 0xff
      carry >>= 8
    }

    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }

  // A leading '1' is a leading zero byte, and the loop above cannot produce one
  // because zero times 58 is still zero. They have to be counted back on.
  for (const character of value) {
    if (character !== '1') break
    bytes.push(0)
  }

  return Uint8Array.from(bytes.reverse())
}

/**
 * Encode bytes as base58 — the inverse of {@link decodeBase58}.
 *
 * The Colony never needs this to talk to an agent: an address and a signature
 * arrive base58 and are stored as they arrived. What it is for is the other
 * three packages' tests, which have to *make* a valid Solana signature before
 * they can check that the Colony reads one correctly, and a decoder that is only
 * ever exercised against strings a test wrote by hand is a decoder nobody has
 * round-tripped.
 */
export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''

  const digits: number[] = []

  for (const byte of bytes) {
    let carry = byte

    for (let index = 0; index < digits.length; index += 1) {
      carry += (digits[index] as number) << 8
      digits[index] = carry % 58
      carry = (carry / 58) | 0
    }

    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }

  let leading = ''
  for (const byte of bytes) {
    if (byte !== 0) break
    leading += '1'
  }

  return (
    leading +
    digits
      .reverse()
      .map((digit) => BASE58_ALPHABET[digit])
      .join('')
  )
}

/**
 * Whether `signature` is a signature over `nonce` by the holder of `address`.
 *
 * **A Solana address *is* an Ed25519 public key** — 32 raw bytes, base58
 * encoded — and the Colony already verifies Ed25519 in
 * {@link verifySignature}. So this converts rather than reimplements: it wraps
 * the raw key in the SPKI structure `crypto` expects and re-encodes the
 * signature, then hands both to the function the `key-signature` rung has been
 * using since it shipped.
 *
 * That indirection is deliberate. The alternative is a signature library — the
 * issue that specified this rung named one — and it would mean two Ed25519
 * implementations in a codebase where one of them decides who is paid. One
 * verified path, audited once, is worth more than the sixty lines it saves.
 *
 * **Nothing here touches the network.** No RPC, no API key, no third party, so
 * this rung has the property `key-signature` has and the earning rungs above it
 * cannot: nobody outside the Colony can disable it.
 */
export function verifySolanaSignature(input: {
  readonly nonce: string
  readonly address: string
  readonly signature: string
}): boolean {
  const publicKey = solanaAddressToPem(input.address)
  if (publicKey === null) return false

  const signature = decodeBase58(input.signature)
  if (signature === null || signature.length !== SOLANA_SIGNATURE_BYTES) return false

  return verifySignature({
    nonce: input.nonce,
    publicKey,
    algorithm: 'ed25519',
    signature: Buffer.from(signature).toString('base64'),
  })
}

/**
 * The 16-byte PKCS8 header an Ed25519 *private* key carries, as DER.
 *
 * `30 2e 02 01 00` a 46-byte sequence at version zero, `30 05 06 03 2b 65 70`
 * the same algorithm identifier the public header carries, `04 22 04 20` an
 * octet string wrapping a 32-byte octet string — the seed. Constant for the
 * algorithm, so a raw seed becomes a parseable private key by concatenation, in
 * the same way {@link solanaAddressToPem} makes a raw public key parseable.
 */
const ED25519_PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex')

/**
 * The address a 32-byte Ed25519 seed belongs to, or `null` if it is not one.
 *
 * **This is `Keypair.fromSeed`, not `Keypair.fromSecretKey`, and the difference
 * is the reason the function exists.** The Colony's own wallet secret is the raw
 * 32-byte seed in base58 — the shape the deposit module's generator produced —
 * while `solana-keygen`, Phantom and every SDK's `fromSecretKey` expect the
 * 64-byte `[seed || public key]` array. Handing one to the other does not throw:
 * it silently derives a different keypair, and therefore a different address,
 * and the first symptom is a transfer signed by an account that holds nothing.
 *
 * So the platform derives the address from the secret it holds and compares it
 * to the address it was told, at startup, and refuses to run if they disagree
 * (`payoutWalletMismatch`).
 *
 * **Node's own crypto rather than a chain SDK**, for the reason
 * `generateDepositKeypair` gave: an address is the raw public key in base58,
 * `encodeBase58` is already here, and a chain client pulled into this package to
 * derive one public key would be a dependency to keep patched for no capability.
 *
 * Nothing here logs, throws or returns the seed. A caller that gets `null` knows
 * only that what it holds is not a seed — which is all it needs, and all it
 * should ever put in a message.
 */
export function solanaAddressFromSeed(seed: string): string | null {
  const bytes = decodeBase58(seed)
  if (bytes === null || bytes.length !== SOLANA_ADDRESS_BYTES) return null

  try {
    const der = Buffer.concat([ED25519_PKCS8_HEADER, Buffer.from(bytes)])
    const jwk = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({
      format: 'jwk',
    })

    // `x` is the public half, base64url, which is what an Ed25519 JWK is
    // required to carry. Reading it rather than re-exporting an SPKI keeps this
    // to one conversion and one slice-free decode.
    const publicKey = typeof jwk.x === 'string' ? Buffer.from(jwk.x, 'base64url') : null
    if (publicKey === null || publicKey.length !== SOLANA_ADDRESS_BYTES) return null

    return encodeBase58(new Uint8Array(publicKey))
  } catch {
    // A 32-byte string that is not a valid seed is not a case the runtime
    // distinguishes for us, and the caller's remedy is the same either way.
    return null
  }
}

/**
 * The 12-byte SPKI header every Ed25519 public key carries, as DER.
 *
 * `30 2a` a 42-byte sequence, `30 05 06 03 2b 65 70` the algorithm identifier
 * for Ed25519, `03 21 00` a 33-byte bit string with no unused bits. It is
 * constant for the algorithm, so a raw key becomes a parseable one by
 * concatenation — this is what makes the conversion above a re-encoding rather
 * than a second implementation.
 */
const ED25519_SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * A base58 Solana address as a PEM public key, or `null` if it is not one.
 *
 * Exported because the storage layer records what it verified, and a PEM is what
 * the rest of the Colony's signature machinery reads.
 */
export function solanaAddressToPem(address: string): string | null {
  const key = decodeBase58(address)
  if (key === null || key.length !== SOLANA_ADDRESS_BYTES) return null

  const der = Buffer.concat([ED25519_SPKI_HEADER, Buffer.from(key)])
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n')

  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`
}
