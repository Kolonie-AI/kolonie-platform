import { createPrivateKey, sign as signWith } from 'node:crypto'
import { decodeBase58, encodeBase58, SOLANA_ADDRESS_BYTES } from '../common/solana.js'

/**
 * A SOL transfer, built and signed here rather than by a chain SDK — D-106
 * (`#505`).
 *
 * **Why this exists rather than a dependency.** The Colony pays citizens from a
 * key on its own host, which is the single most sensitive thing this codebase
 * does. A legacy transaction carrying one system transfer is about a hundred
 * lines of serialisation against a format that has not changed since 2020, and
 * every byte of it is reviewable by reading this file. The alternative is a
 * dependency tree that signs money, which is a supply-chain surface the Colony
 * would have to keep patched for a capability it uses in exactly one place —
 * the same argument `verifySolanaSignature` already made against a signature
 * library, one leg further down the same path.
 *
 * **It builds and signs; it does not send.** Nothing here touches the network,
 * so the whole of it is testable without a chain and without a key that matters.
 * Sending is the caller's, and the caller is the one place an RPC endpoint is
 * named.
 */

/** The System Program's address: thirty-two zero bytes. */
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111'

/**
 * The System Program's `Transfer` instruction index.
 *
 * `2`, as a little-endian `u32`, followed by the lamports as a little-endian
 * `u64`. That is the whole instruction — twelve bytes.
 */
const SYSTEM_TRANSFER_INSTRUCTION = 2

/**
 * The rent-exempt minimum for an account holding no data, on 2026-08-07.
 *
 * **A fallback and never the value.** `#505` is explicit that this is read from
 * the chain with `getMinimumBalanceForRentExemption(0)`, because it is a
 * function of rent parameters this repository does not own. It is written down
 * only so a caller that could not reach the chain has a number to refuse
 * against rather than a zero — refusing to pay is safe, and paying into
 * nothing is not.
 */
export const RENT_EXEMPT_MINIMUM_FALLBACK = 890_880

/**
 * What one Solana transfer costs the account sending it.
 *
 * **Written down here because two rules are about to be measured against it and
 * neither owns it** (`#751`). `FEE_RESERVE_LAMPORTS` in `apps/api/src/payouts.ts`
 * is a hundred of these and said so only in prose; `questFundingRejection`
 * refuses a sponsor whose wallet holds the invoice exactly, because a balance
 * equal to the invoice cannot pay the fee to send it. Two numbers derived from
 * one fee, in two workspaces, is the drift this file refuses everywhere else.
 *
 * The base fee is 5,000 lamports per signature and a transfer carries one.
 * Priority fees are a separate thing a sender chooses to add, and nothing here
 * adds one — a refusal that assumed a tip nobody is paying would turn away a
 * sponsor that can afford the transfer.
 */
export const SOL_TRANSFER_FEE_LAMPORTS = 5_000

/** What a signed transfer is, on its way to an endpoint. */
export interface SignedTransfer {
  /** The whole transaction, base64 — the encoding `sendTransaction` takes. */
  readonly transaction: string
  /** Its signature, base58, which is also its id on chain. */
  readonly signature: string
}

/**
 * Build and sign one SOL transfer.
 *
 * **The secret is the raw 32-byte Ed25519 seed, base58** — the shape the
 * Colony's wallet is stored in. It is used and discarded inside this function:
 * nothing here logs it, returns it, or puts it in an error.
 *
 * Returns `null` when an input is not what it claims to be — a malformed
 * address, a seed that is not one, an amount that is not a positive integer.
 * **Never throws with the secret in scope**, because a stack trace is a place a
 * key can end up.
 */
export function signSolTransfer(input: {
  readonly fromSeed: string
  readonly fromAddress: string
  readonly toAddress: string
  readonly lamports: number
  /** From `getLatestBlockhash`. A transaction is only valid against a recent one. */
  readonly recentBlockhash: string
}): SignedTransfer | null {
  if (!Number.isSafeInteger(input.lamports) || input.lamports <= 0) return null

  const from = decodeBase58(input.fromAddress)
  const to = decodeBase58(input.toAddress)
  const program = decodeBase58(SYSTEM_PROGRAM_ID)
  const blockhash = decodeBase58(input.recentBlockhash)
  const seed = decodeBase58(input.fromSeed)

  for (const key of [from, to, program, blockhash, seed]) {
    if (key === null || key.length !== SOLANA_ADDRESS_BYTES) return null
  }

  // Paying yourself is a no-op that costs a fee, and it is far more likely to be
  // a bug in whoever computed the recipient than a thing anybody meant.
  if (input.fromAddress === input.toAddress) return null

  const message = transferMessage({
    from: from as Uint8Array,
    to: to as Uint8Array,
    program: program as Uint8Array,
    blockhash: blockhash as Uint8Array,
    lamports: input.lamports,
  })

  let signature: Buffer
  try {
    const der = Buffer.concat([ED25519_PKCS8_HEADER, Buffer.from(seed as Uint8Array)])
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
    signature = signWith(null, message, key)
  } catch {
    // A seed of the right length that is not a valid key. The caller learns it
    // could not sign and learns nothing else.
    return null
  }

  const transaction = Buffer.concat([
    // One signature, so the compact-u16 count is a single byte.
    Buffer.from([1]),
    signature,
    message,
  ])

  return {
    transaction: transaction.toString('base64'),
    signature: encodeBase58(new Uint8Array(signature)),
  }
}

/** The 16-byte PKCS8 header an Ed25519 private key carries, as DER. */
const ED25519_PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex')

/**
 * The message a transfer signs over: header, accounts, blockhash, instruction.
 *
 * **The account order is part of the format and not a choice.** Signers come
 * first and writable accounts before read-only ones, so the payer is index 0,
 * the recipient index 1, and the System Program index 2 — which is what the
 * header's three counts describe: one required signature, no read-only signers,
 * one read-only unsigned account.
 */
function transferMessage(input: {
  readonly from: Uint8Array
  readonly to: Uint8Array
  readonly program: Uint8Array
  readonly blockhash: Uint8Array
  readonly lamports: number
}): Buffer {
  const data = Buffer.alloc(12)
  data.writeUInt32LE(SYSTEM_TRANSFER_INSTRUCTION, 0)
  // `BigInt`, because lamports is a u64 and `writeUInt32LE` twice is how a
  // transfer of more than 4.29 SOL quietly becomes a different transfer.
  data.writeBigUInt64LE(BigInt(input.lamports), 4)

  return Buffer.concat([
    // numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
    Buffer.from([1, 0, 1]),
    compactU16(3),
    Buffer.from(input.from),
    Buffer.from(input.to),
    Buffer.from(input.program),
    Buffer.from(input.blockhash),
    // One instruction.
    compactU16(1),
    // Its program is account index 2.
    Buffer.from([2]),
    // Over accounts 0 and 1.
    compactU16(2),
    Buffer.from([0, 1]),
    compactU16(data.length),
    data,
  ])
}

/**
 * Solana's compact-u16: seven bits per byte, high bit means *more follows*.
 *
 * Every length in a transaction is encoded this way. Nothing the Colony builds
 * comes close to 128 of anything, so in practice this always emits one byte —
 * it is written in full anyway, because a length encoder that is correct only
 * for the sizes somebody happened to test is the kind of thing that breaks on
 * the first transaction that matters.
 */
export function compactU16(value: number): Buffer {
  const bytes: number[] = []
  let rest = value

  for (;;) {
    const chunk = rest & 0x7f
    rest >>= 7
    if (rest === 0) {
      bytes.push(chunk)
      break
    }
    bytes.push(chunk | 0x80)
  }

  return Buffer.from(bytes)
}
