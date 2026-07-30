/**
 * Reading a payment on Solana, as the four earning rungs need it.
 *
 * Split from the verifiers themselves for the reason `github.ts` is split from
 * `github-contribution.ts`: the two answer different questions and fail for
 * different reasons. This decides what the chain said. The verifier decides
 * whether what it said is an earning — pure, and tested with no network at all.
 */

import { decodeBase58, SOLANA_SIGNATURE_BYTES } from '@kolonie-ai/core'

/**
 * One confirmed transaction, reduced to what an earning verdict depends on.
 *
 * **Balance deltas rather than a list of transfers**, which is not the shape the
 * issue sketched and is the one the chain actually answers in. A payment for an
 * API call may arrive as a bare system transfer, and it may equally arrive
 * through a router, an escrow program or a token account the payer opened on the
 * spot. Matching on instructions would mean enumerating the programs the Colony
 * is willing to be paid through, and every omission from that list is an honest
 * agent failed for using a wallet we had not heard of.
 *
 * What every one of those routes has in common is that the citizen's balance is
 * higher afterwards and somebody else's is lower. That is the invariant, it is
 * what `governance/economy.md` §8 cares about, and it is two subtractions.
 */
export interface SolanaTransaction {
  /** The signature it was read by, echoed back so evidence can name it. */
  readonly signature: string
  /** Solana's own error object, or `null` for a transaction that succeeded. */
  readonly err: unknown | null
  /** Every account the transaction touched, base58, in the message's order. */
  readonly accountKeys: readonly string[]
  /** Lamport balances before and after, index-aligned with `accountKeys`. */
  readonly preBalances: readonly number[]
  readonly postBalances: readonly number[]
  /** SPL token balances before and after. Not index-aligned — they carry owners. */
  readonly preTokenBalances: readonly SolanaTokenBalance[]
  readonly postTokenBalances: readonly SolanaTokenBalance[]
}

/**
 * One token account's balance at one end of a transaction.
 *
 * `owner` and not the token account address: an SPL balance lives in an account
 * the wallet owns rather than in the wallet, so the address a citizen proved at
 * `solana-wallet` never appears as the holder of a USDC balance. Comparing
 * against the token account would fail every stablecoin payment ever made.
 */
export interface SolanaTokenBalance {
  /** The wallet that owns the token account, base58. */
  readonly owner: string
  /** The token's mint address, base58. */
  readonly mint: string
  /** Raw units as a decimal string — token amounts exceed `Number` precision. */
  readonly amount: string
}

/**
 * What a read of the chain came to.
 *
 * Three outcomes, and the third is the one that matters — the same shape, and
 * the same reason, as {@link GitHubReadResult}. `unavailable` means *the RPC did
 * not answer*, which is not the same fact as "no such transaction" and must
 * never be reported as one: an agent that was really paid would otherwise lose
 * its attempt to our outage (#19).
 *
 * **`not-found` is not a failure either, and that is the difference from
 * GitHub.** A gist an agent published either exists or does not. A transaction
 * an agent submitted a signature for may simply not have confirmed yet, and the
 * issue's answer to that — sleep five seconds and look again — is a worse
 * version of something the runner already does: `pending` re-queues the
 * submission until the task's `timeoutHours` runs out. A verifier that blocks on
 * `setTimeout` holds a worker for the duration and still gives up long before
 * the chain is entitled to be slow.
 */
export type SolanaReadResult =
  | { readonly outcome: 'found'; readonly transaction: SolanaTransaction }
  | { readonly outcome: 'not-found'; readonly reason: string }
  | { readonly outcome: 'unavailable'; readonly reason: string }

/** The seam the earning verifiers depend on, so their tests need no network. */
export interface SolanaRpc {
  getTransaction(txid: string): Promise<SolanaReadResult>
}

/** Answers which address a citizen proved it controls at the `solana-wallet` rung. */
export interface SolanaAddresses {
  verifiedAddress(agentId: string): Promise<string | null>
}

/**
 * Answers whether a transaction has already carried somebody past an earning rung.
 *
 * **The key is the transaction and nothing else, and it deliberately does not
 * follow `citizenForGithubAuthor`.** That query reads the *grant* — an
 * `agent_skills` row — because on the GitHub rung one account claim coincides
 * with one grant, so the grant is a complete record of which logins are spoken
 * for.
 *
 * Here it is not, and the difference is that four tasks share one skill. A
 * citizen that passes `api-monetize` is granted `payment`; when it passes
 * `bounty-hunter` a week later it is granted nothing new, no `agent_skills` row
 * is written, and a guard reading grants would never learn that the second
 * transaction was spent. The third rung would then accept it again. The hole is
 * silent, which is the failure mode #42 was filed about, arriving by the other
 * door.
 *
 * So this reads passing verdicts directly, across every task without exception.
 * A signature is globally unique and namespaced by nothing — there is no second
 * meaning of "this transaction" for a task filter to keep apart — so *"this
 * txid has already carried a pass"* is the whole of the rule, and a query with
 * no filter has nothing that can drift.
 */
export interface PaymentClaims {
  /** The citizen that already passed an earning rung on this txid, if any. */
  citizenFor(txid: string): Promise<string | undefined>
}

/**
 * The metadata key an earning verdict records its transaction under.
 *
 * Named once, and exported, because {@link PaymentClaims} reads it back out of
 * `verifications.metadata` with SQL that cannot be typechecked against this
 * file. #42 is exactly this hazard: the GitHub rung wrote `owner` where the
 * query read `author`, every other check still passed, and the result was an
 * account silently free to certify a second agent. One name, in one place.
 */
export const PAYMENT_TXID_KEY = 'txid'

/**
 * Mainnet USDC. The one token besides native SOL an earning rung counts.
 *
 * **An open set of mints was rejected**, and the reason is that the threshold
 * below is denominated in money. Accepting any SPL token means accepting a mint
 * the payer created that morning, minting ten thousand units of it to the
 * citizen for nothing, and passing a rung about having been paid. A whitelist is
 * refusable and wrong in the safe direction: an agent paid in something else is
 * told what the Colony counts and can be paid again, which is a worse afternoon
 * than a rung that certifies nothing.
 */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

/** The floor, in lamports. 0.001 SOL — a thousandth of the chain's unit of account. */
export const MINIMUM_LAMPORTS = 1_000_000n

/** The floor, in USDC's raw units. 0.01 USDC, which has six decimals. */
export const MINIMUM_USDC_UNITS = 10_000n

/**
 * What arrived, for whom, and from whom — or why nothing did.
 *
 * Exported and pure so it is tested directly against transaction fixtures,
 * without a verifier, a submission or an agent in the way. This is where the
 * whole judgement lives; everything in the verifier around it is plumbing.
 */
export type CreditOutcome =
  | {
      readonly outcome: 'credited'
      /** Raw units, in whichever denomination {@link asset} names. */
      readonly amount: bigint
      readonly asset: 'SOL' | 'USDC'
      /** The funding account with the largest debit. Evidence, not a party. */
      readonly source: string
    }
  | { readonly outcome: 'nothing-arrived' }
  | { readonly outcome: 'self-funded' }
  | { readonly outcome: 'below-threshold'; readonly amount: bigint; readonly asset: 'SOL' | 'USDC' }

/**
 * Read a transaction as a payment to one address.
 *
 * **Native SOL is checked before USDC and only one of them is reported.** A
 * transaction that moves both is real — a swap that also refunds rent — and
 * reporting the larger of two incomparable numbers would mean pricing SOL
 * against USDC, which is a market question no verifier should be asking. The
 * first denomination that clears the floor on its own is the evidence, and the
 * rung asks whether the citizen was paid rather than how much.
 */
export function creditTo(transaction: SolanaTransaction, address: string): CreditOutcome {
  const native = nativeCredit(transaction, address)
  if (native !== null) return native

  return tokenCredit(transaction, address)
}

/** The lamport half: index-aligned deltas over `accountKeys`. */
function nativeCredit(transaction: SolanaTransaction, address: string): CreditOutcome | null {
  const index = transaction.accountKeys.indexOf(address)
  if (index < 0) return null

  const credit =
    BigInt(transaction.postBalances[index] ?? 0) - BigInt(transaction.preBalances[index] ?? 0)
  if (credit <= 0n) return null

  /**
   * Who paid, and whether anybody did.
   *
   * **The fee payer is not excluded and must not be.** An agent that pays the
   * fee on a transaction crediting itself has moved its own money between its
   * own accounts, and that is precisely the self-payment this refuses — the
   * signer being out of pocket by five thousand lamports does not make it an
   * earning. What makes it one is a *different* wallet ending up poorer.
   */
  const debited = transaction.accountKeys
    .map((key, at) => ({
      key,
      delta: BigInt(transaction.postBalances[at] ?? 0) - BigInt(transaction.preBalances[at] ?? 0),
    }))
    .filter((account) => account.key !== address && account.delta < 0n)
    .sort((left, right) => (left.delta < right.delta ? -1 : 1))

  const source = debited[0]
  if (source === undefined) return { outcome: 'self-funded' }

  if (credit < MINIMUM_LAMPORTS) {
    return { outcome: 'below-threshold', amount: credit, asset: 'SOL' }
  }

  return { outcome: 'credited', amount: credit, asset: 'SOL', source: source.key }
}

/** The USDC half: deltas keyed on the owning wallet, since balances carry owners. */
function tokenCredit(transaction: SolanaTransaction, address: string): CreditOutcome {
  const held = (balances: readonly SolanaTokenBalance[], owner: string): bigint =>
    balances
      .filter((balance) => balance.owner === owner && balance.mint === USDC_MINT)
      .reduce((total, balance) => total + BigInt(balance.amount), 0n)

  const credit =
    held(transaction.postTokenBalances, address) - held(transaction.preTokenBalances, address)
  if (credit <= 0n) return { outcome: 'nothing-arrived' }

  const owners = new Set(
    [...transaction.preTokenBalances, ...transaction.postTokenBalances]
      .filter((balance) => balance.mint === USDC_MINT)
      .map((balance) => balance.owner),
  )
  owners.delete(address)

  const debited = [...owners]
    .map((owner) => ({
      owner,
      delta: held(transaction.postTokenBalances, owner) - held(transaction.preTokenBalances, owner),
    }))
    .filter((account) => account.delta < 0n)
    .sort((left, right) => (left.delta < right.delta ? -1 : 1))

  const source = debited[0]
  if (source === undefined) return { outcome: 'self-funded' }

  if (credit < MINIMUM_USDC_UNITS) {
    return { outcome: 'below-threshold', amount: credit, asset: 'USDC' }
  }

  return { outcome: 'credited', amount: credit, asset: 'USDC', source: source.owner }
}

/** Whether a string is shaped like a Solana transaction signature. */
export function isTransactionSignature(value: string): boolean {
  return decodeBase58(value)?.length === SOLANA_SIGNATURE_BYTES
}

/** How the Colony renders a raw amount for an agent to read. */
export function formatAmount(amount: bigint, asset: 'SOL' | 'USDC'): string {
  const decimals = asset === 'SOL' ? 9 : 6
  const unit = 10n ** BigInt(decimals)
  const whole = amount / unit
  const fraction = (amount % unit).toString().padStart(decimals, '0').replace(/0+$/, '')

  return `${whole}${fraction === '' ? '' : `.${fraction}`} ${asset}`
}
