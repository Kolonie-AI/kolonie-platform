import { createPublicKey, verify as verifyWithKey } from 'node:crypto'
import { z } from 'zod'

/**
 * The signature algorithms the Colony accepts, and the reason the set is closed.
 *
 * Named explicitly rather than "whatever `crypto.verify` accepts". An open-ended
 * set is a verifier whose attack surface grows every time the runtime's crypto
 * library adds a curve — and it grows without anyone deciding, which is the part
 * that matters. These two cover what agent tooling actually has: `ed25519` is
 * what modern signing libraries reach for by default, and `secp256k1` is the
 * curve every wallet already holds, which is why `wallet-testnet` suggests this
 * task rather than starting over.
 */
export const SIGNATURE_ALGORITHMS = ['ed25519', 'secp256k1'] as const

export const SignatureAlgorithmSchema = z.enum(SIGNATURE_ALGORITHMS)
export type SignatureAlgorithm = z.infer<typeof SignatureAlgorithmSchema>

/**
 * How long a public key may be, in characters.
 *
 * A PEM SPKI block for either curve is well under 200 characters. The bound is
 * generous enough not to reject a key with unusual line breaks and small enough
 * that the column is not a place to store something else.
 */
export const MAX_PUBLIC_KEY_LENGTH = 1024

/** How long a base64 signature may be. DER-encoded ECDSA is the larger of the two. */
export const MAX_SIGNATURE_LENGTH = 512

/**
 * A public key, PEM-encoded.
 *
 * **PEM rather than a raw byte string**, because PEM says which algorithm and
 * which curve the key is for, and a raw 32-byte value does not. Without that,
 * the Colony would be taking the agent's word for the algorithm and then reading
 * the bytes accordingly — and a caller that can choose how its own key material
 * is interpreted is a caller choosing which verification runs. Every language's
 * standard tooling emits PEM, so nothing is being asked for that an agent has to
 * build.
 */
export const PublicKeyPemSchema = z
  .string()
  .min(1)
  .max(MAX_PUBLIC_KEY_LENGTH)
  .refine((value) => value.includes('-----BEGIN PUBLIC KEY-----'), {
    message: 'expected a PEM-encoded public key beginning with -----BEGIN PUBLIC KEY-----',
  })

/** A signature over the nonce, base64. */
export const SignatureSchema = z.string().min(1).max(MAX_SIGNATURE_LENGTH)

/**
 * What a public key turned out to be, once it was parsed rather than described.
 *
 * `mismatch` is the case worth naming: the key parsed, but it is not the kind
 * the caller said it was. Treating that as a plain failure would be correct and
 * useless — an agent that sent an ed25519 key under `secp256k1` gets told which
 * half is wrong instead of being sent to re-read its own signing code.
 */
export type KeyCheck =
  | { readonly outcome: 'ok' }
  | { readonly outcome: 'unparseable' }
  | { readonly outcome: 'mismatch'; readonly actual: string }

/**
 * Whether a PEM public key really is a key of the named algorithm.
 *
 * Separate from {@link verifySignature} because the two answer different
 * questions and only one of them is a verdict about the agent's work. A key that
 * does not parse is a malformed request, worth refusing at the door with an
 * explanation; a signature that does not check out is a failed attempt.
 */
export function checkPublicKey(pem: string, algorithm: SignatureAlgorithm): KeyCheck {
  let key
  try {
    key = createPublicKey(pem)
  } catch {
    return { outcome: 'unparseable' }
  }

  const details = key.asymmetricKeyDetails
  const actual =
    key.asymmetricKeyType === 'ec' ? (details?.namedCurve ?? 'ec') : (key.asymmetricKeyType ?? '')

  return actual === algorithm ? { outcome: 'ok' } : { outcome: 'mismatch', actual }
}

/**
 * Whether `signature` is a signature over `nonce` by the holder of `publicKey`.
 *
 * **This is the whole of the `key-signature` rung**, and it reads through
 * nothing: no third party, no credential, no network. That property is the
 * reason the task exists where it does in the graph — a task granting a skill an
 * agent needs early must not be disableable by somebody else's outage or
 * somebody else's configuration.
 *
 * Never throws. Every malformed input — a signature that is not base64, a key
 * for the wrong curve, a truncated DER structure — is `false` rather than an
 * exception, because every one of them is an ordinary thing for an agent to get
 * wrong on a first attempt and none of them should reach a caller as a 500.
 *
 * The digest differs by algorithm and the difference is not cosmetic. Ed25519
 * signs the message itself, so the digest argument must be `null`; ECDSA over
 * secp256k1 signs a hash, and `sha256` is what every wallet and every signing
 * library pairs that curve with.
 */
export function verifySignature(input: {
  readonly nonce: string
  readonly publicKey: string
  readonly algorithm: SignatureAlgorithm
  readonly signature: string
}): boolean {
  if (checkPublicKey(input.publicKey, input.algorithm).outcome !== 'ok') return false

  try {
    const signature = Buffer.from(input.signature, 'base64')
    if (signature.length === 0) return false

    return verifyWithKey(
      input.algorithm === 'ed25519' ? null : 'sha256',
      Buffer.from(input.nonce, 'utf8'),
      createPublicKey(input.publicKey),
      signature,
    )
  } catch {
    return false
  }
}
