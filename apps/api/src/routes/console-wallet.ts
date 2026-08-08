import { ERROR_STATUS } from '@kolonie-ai/core'
import type { AgentId, HumanId } from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  WALLET_PAGE_HEADERS,
  WALLET_SCRIPT,
  WALLET_SCRIPT_PATH,
  walletPage,
} from '../console/wallet-page.js'
import { openSolanaChallenge, submitWalletSignature } from '../solana.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The console half of the wallet rung (`#539`).
 *
 * **A page and two calls, and no new endpoint under `/v1/`.** `#539` settles
 * that: `POST /v1/academy/solana/*` already mints the nonce and takes the
 * answer, and what was missing is a caller. These three routes are that caller,
 * on the console host, where the rest of what a person does on behalf of an
 * agent already lives.
 *
 * ## Why the console cannot simply call the `/v1/` routes
 *
 * Those are authenticated as the **agent**, by API key. A person in a browser
 * holds a console session and not the agent's key — and should not: handing an
 * agent's key to a page so the page can call an endpoint is the shape this whole
 * feature exists to avoid. So the console proves the person **operates** the
 * agent, exactly as `/agents/:agentId` does, and calls the same two functions
 * the `/v1/` routes call, with the agent's id.
 *
 * `openSolanaChallenge` and `submitWalletSignature` take an `agentId` and their
 * dependencies. There is no second implementation here and no second rule: the
 * nonce, the hour's expiry, the one-wallet-one-citizen index and the verifier
 * are the same ones an agent meets, which is `#539`'s first settled decision.
 *
 * ## What these routes never carry
 *
 * No private key and no seed phrase, in either direction — `WalletAnswerSchema`
 * is `.strict()`, so a body carrying one is refused rather than ignored, and
 * that is the schema these use. Nothing here builds, offers or signs a
 * transaction.
 */
export interface ConsoleWalletHelpers {
  /**
   * The console host check plus the standard headers, exactly as every other
   * console route gets them. Answers `false` having already replied.
   */
  readonly guard: (request: FastifyRequest, reply: FastifyReply) => Promise<boolean>
  /**
   * The person, and the agent they are acting for — or `null` having already
   * replied with the 404 that says nothing.
   *
   * **Passed in rather than reimplemented.** A second copy of *does this person
   * operate this agent* is a second answer waiting to disagree with the first,
   * and this is the check that decides who may prove a wallet.
   */
  readonly operatedAgent: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<{ readonly humanId: HumanId; readonly agentId: AgentId } | null>
  /** The console's own not-found, which says nothing about what exists. */
  readonly notFound: (reply: FastifyReply, request: FastifyRequest) => FastifyReply
  /** Whether this request reached the console host at all. */
  readonly onConsoleHost: (request: FastifyRequest) => boolean
}

export function registerConsoleWalletRoutes(
  app: FastifyInstance,
  deps: RouteDependencies,
  helpers: ConsoleWalletHelpers,
): void {
  const { solana } = deps
  const { guard, operatedAgent, notFound, onConsoleHost } = helpers

  /**
   * The script, served from the console's own origin.
   *
   * **A file rather than an inline block**, which is what lets the page's CSP
   * say `script-src 'self'` and nothing looser. Cached for an hour: it is one
   * small static file and it changes on a deploy, where every other console
   * response is `no-store` because every other one is about somebody.
   */
  app.get(WALLET_SCRIPT_PATH, async (request, reply) => {
    if (!onConsoleHost(request)) {
      reply.callNotFound()
      return reply
    }

    return reply
      .headers({
        'content-type': 'application/javascript; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'cache-control': 'public, max-age=3600',
      })
      .send(WALLET_SCRIPT)
  })

  /** The page itself. */
  app.get('/agents/:agentId/wallet', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const facts = await deps.autonomy.pages.factsOf(operated.agentId)
    if (facts === null) return notFound(reply, request)

    // The proved address, read from the cleared challenge rather than from the
    // profile's free-text `wallet` — two questions that answer with the same
    // shaped string and mean different things.
    const verified = await deps.store.verifiedWalletOf(operated.agentId)

    return reply
      .headers(WALLET_PAGE_HEADERS)
      .type('text/html')
      .send(
        walletPage({
          agentId: String(operated.agentId),
          agentName: facts.name,
          verifiedAddress: verified,
        }),
      )
  })

  /**
   * Mint the nonce for this agent.
   *
   * JSON in both directions: it is called by the page's own script rather than
   * submitted by a form, and a redirect would lose the nonce.
   */
  app.post('/agents/:agentId/wallet/challenge', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const result = await openSolanaChallenge(operated.agentId, solana)

    return reply.status(201).send(result.response)
  })

  /**
   * Take the address and the signature.
   *
   * **The refusals are passed through unchanged.** `submitWalletSignature`
   * already names what to do next for every one of them — an encoding, an hour
   * that ran out, a wallet another citizen cleared with — and rewording them
   * here would be a second vocabulary for one rung.
   */
  app.post('/agents/:agentId/wallet/signature', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const result = await submitWalletSignature(operated.agentId, request.body, solana)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send({ verified: true, ...result.response })
  })
}
