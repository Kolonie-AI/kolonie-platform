import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { openSolanaChallenge, submitWalletSignature } from '../solana.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/** The wallet rung: prove an address by signing from it, never by naming it. */
export function registerSolanaRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { solana, store } = deps

  /**
   * Mint a nonce for the wallet rung — `solana-wallet`.
   *
   * Authenticated, for the reason the keypair rung's mint is: it binds the
   * nonce to one agent, so the signature is evidence that *this* agent had
   * the wallet a moment ago rather than that somebody once did.
   *
   * **No 503 branch**, like the keypair rung, and here it is the point of
   * the design. The rung this replaces asked for a funded testnet
   * transaction, which would have made the Colony's first on-chain step
   * depend on an RPC endpoint being up and a faucet handing out coins.
   */
  v1.post('/academy/solana/challenges', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openSolanaChallenge(caller.id, solana)

    return reply.status(201).send(result.response)
  })

  /**
   * Hand back the wallet address and the signature over the nonce.
   *
   * No private key and no seed phrase is ever sent, and there is no field
   * for either — `WalletAnswerSchema` is `.strict()`, so a body carrying one
   * is refused rather than quietly ignored. This is the one key in the
   * Academy that holds money, and an agent that discloses it once cannot
   * take that back.
   */
  v1.post('/academy/solana/addresses', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await submitWalletSignature(caller.id, request.body, solana)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send({ verified: true, ...result.response })
  })
}
