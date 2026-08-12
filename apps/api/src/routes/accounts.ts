import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { openProof, submitPostProof } from '../account-proofs.js'
import { readRecipe, readRecipes } from '../provider-recipes.js'
import {
  declareOwnAccount,
  preferOwnAccount,
  readAccounts,
  readProviders,
  reportProvider,
  setOwnAccountNote,
  setOwnAccountProvider,
  setOwnAccountAttestable,
  setOwnAccountForWork,
  setOwnAccountStatus,
  setOwnAccountVaultKey,
} from '../accounts.js'
import { callerFor } from './authenticated.js'
import { readWalkStatus } from '../account-walks.js'
import type { RouteDependencies } from './dependencies.js'

/** The account register (#150): what a citizen holds, and what it says about each. */
export function registerAccountRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { accounts, recipes, store, walks } = deps

  /**
   * The account register: what a citizen holds, beside what it can do (#150).
   *
   * **`/accounts` and not `/agents/me/accounts`**, matching `/vault` one
   * block down: both are the caller's own and neither has a subject in its
   * path. There is nowhere in these five routes to put somebody else's agent
   * id, which is the property rather than a coincidence.
   *
   * Reading, declaring, and four small writes. None of them can set `proved`
   * or a capability — those are written only inside a verdict's transaction,
   * and a test asserts no route reaches that function.
   */
  v1.get('/accounts', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { kind } = request.query as { kind?: string }
    const result = await readAccounts(caller.id, kind, accounts, walks, recipes)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  v1.get('/accounts/walks/:walkId', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { walkId } = request.params as { walkId: string }
    const result = await readWalkStatus(caller.id, walkId, walks, recipes, accounts.register)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  v1.post('/accounts', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await declareOwnAccount(caller.id, request.body, accounts)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(201).send(result.response)
  })

  /**
   * The three fields a citizen may set on one of its own accounts, and the
   * preference.
   *
   * Separate routes rather than one `PATCH` taking a partial object, for the
   * reason the vault gives about `PUT /vault/:key`: each of these is a
   * different intention, and a shape that carries three optional fields
   * cannot tell *clear the note* from *do not touch the note* without a
   * convention every caller has to know.
   */
  v1.put('/accounts/:accountId/status', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { accountId } = request.params as { accountId: string }
    const result = await setOwnAccountStatus(caller.id, accountId, request.body, accounts)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  v1.put('/accounts/:accountId/note', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { accountId } = request.params as { accountId: string }
    const result = await setOwnAccountNote(caller.id, accountId, request.body, accounts)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  /**
   * The provider aggregate (`#288`).
   *
   * **Before the `:accountId` routes and above the writes**, because it is a
   * read about everybody rather than about the caller: it takes a credential and
   * answers the same thing to every citizen. Nothing it returns names one.
   */
  /**
   * A provider that produced no account (`#298`).
   *
   * **`PUT` and beside the aggregate it feeds**, rather than under
   * `/accounts/:accountId` — the whole point is that there is no account. One
   * standing verdict per citizen per provider, so writing again replaces it and
   * `null` withdraws it.
   */
  v1.put('/accounts/provider-reports', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await reportProvider(caller.id, request.body, accounts)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result)
  })

  /**
   * Open a generic proof, and hand one in (`#520`).
   *
   * **Above the `:accountId` routes**, on the reason the block below states: a
   * literal path segment has to be declared before a parameterised one, or
   * `/accounts/proofs` is read as an account whose id is `proofs`.
   *
   * **Only the post proof has a submit route.** A mail proof is closed by the
   * arrival of the forwarded message at the address it was given, so a second way
   * to close one would be a second place to get the sender check wrong.
   */
  v1.post('/accounts/proofs', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openProof(caller.id, request.body, accounts.proofs)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(201).send(result.response)
  })

  v1.post('/accounts/proofs/:proofId/submit', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { proofId } = request.params as { proofId: string }
    const result = await submitPostProof(caller.id, proofId, request.body, accounts.proofs)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  /**
   * The provider catalogue (`#521`).
   *
   * **Above the `:accountId` routes** for the reason the proofs are, and read-only:
   * writing an entry is curation and is `#549`'s.
   */
  v1.get('/accounts/recipes', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { kind } = request.query as { kind?: string }
    const result = await readRecipes(kind, recipes)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  v1.get('/accounts/recipes/:kind/:provider', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { kind, provider } = request.params as { kind: string; provider: string }
    const result = await readRecipe(kind, provider, recipes)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  /** Let a stranger ask about one account, or stop them (`#519`). */
  v1.put('/accounts/:accountId/attestable', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { accountId } = request.params as { accountId: string }
    const result = await setOwnAccountAttestable(caller.id, accountId, request.body, accounts)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  /** Take one account out of matching, or put it back (`#523`). */
  v1.put('/accounts/:accountId/for-work', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { accountId } = request.params as { accountId: string }
    const result = await setOwnAccountForWork(caller.id, accountId, request.body, accounts)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  v1.get('/accounts/providers', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { kind } = request.query as { kind?: string }
    const result = await readProviders(kind, accounts)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  v1.put('/accounts/:accountId/provider', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { accountId } = request.params as { accountId: string }
    const result = await setOwnAccountProvider(caller.id, accountId, request.body, accounts)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  v1.put('/accounts/:accountId/vault-key', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { accountId } = request.params as { accountId: string }
    const result = await setOwnAccountVaultKey(caller.id, accountId, request.body, accounts)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  v1.post('/accounts/:accountId/prefer', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { accountId } = request.params as { accountId: string }
    const result = await preferOwnAccount(caller.id, accountId, accounts)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })
}
