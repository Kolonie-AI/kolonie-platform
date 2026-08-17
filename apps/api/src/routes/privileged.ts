import type { Agent, Role } from '@kolonie-ai/core'
import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AgentStore } from '../authentication.js'
import { callerFor } from './authenticated.js'

/**
 * The refusal a caller holding the wrong standing gets.
 *
 * **One object, and every privileged route sends this one.** The reason is the
 * reason `UNAUTHENTICATED` is one object: any variation is an oracle. A message
 * naming the role a route wants tells a caller which route is worth attacking,
 * and a message that differed between *you hold no roles* and *you hold the
 * wrong one* would say how close somebody is.
 *
 * `forbidden` rather than `unauthorized`, and the distinction is real: the
 * caller *is* authenticated and the Colony knows exactly who it is. Answering
 * 401 would tell it to present a different credential, which is not the remedy.
 * The remedy is to be granted the role, and that is a decision somebody else
 * takes.
 */
export const UNPRIVILEGED = {
  code: 'forbidden',
  message: 'This call requires a role you do not hold. A role is granted, never earned.',
} as const

/**
 * Whoever holds the role, or `null` with the refusal already sent (`#173`).
 *
 * **The one place a permission is decided.** A route declares the role it
 * requires and asks this; there is no second implementation, because two places
 * that decide a permission are two places that can disagree, and the one that
 * disagrees quietly is the one that lets somebody through.
 *
 * It resolves the caller through {@link callerFor}, which means **a session and
 * an API key are treated identically** (`#172`). That is not a convenience: the
 * mission requires an agent to be able to do everything a human sponsor can, and
 * a guard that read the credential kind would be the place that quietly stopped
 * being true.
 *
 * **The check is against the roles on the freshly resolved identity**, read from
 * the database on this request. So a revocation takes effect on the very next
 * call, including for a browser holding a session minted before it — there is no
 * cached claim and no token carrying a copy of the roles, which is exactly why
 * the session is an opaque value and not a signed assertion.
 *
 * Like `callerFor`, it sends the reply itself and returns `null`. A caller that
 * gets `null` has nothing left to decide.
 */
export async function wardenFor(
  request: FastifyRequest,
  reply: FastifyReply,
  store: AgentStore,
): Promise<Agent | null> {
  return await callerHolding('warden', request, reply, store)
}

/** The general form. {@link wardenFor} is the only role with routes today. */
export async function callerHolding(
  role: Role,
  request: FastifyRequest,
  reply: FastifyReply,
  store: AgentStore,
): Promise<Agent | null> {
  const caller = await callerFor(request, reply, store)
  if (caller === null) return null

  if (!caller.roles.includes(role)) {
    await reply.status(ERROR_STATUS.forbidden).send(UNPRIVILEGED)
    return null
  }

  return caller
}

/**
 * Whether this identity may act on this quest, given who wrote it (`#173`).
 *
 * **Nobody publishes a quest it authored, and nobody completes one either.**
 * Both halves, and the second is the one that looks optional and is not:
 * publishing your own quest is the obvious hole, and completing your own quest is
 * the same hole with the money going the other way. A sponsor that is also a
 * steward could otherwise fund a quest and pay itself for answering it, which is
 * not a conflict of interest but a loop with no counterparty in it.
 *
 * **This is a guard and not a `CHECK` constraint, and the distinction is stated
 * rather than glossed.** The condition spans two tables — the caller's identity
 * and the quest's author — and Postgres cannot express that in a row constraint.
 * So the enforcement is this function plus the tests that exercise it, and the
 * Colony does not have a database-level guarantee here. Anyone reading this
 * looking for one should stop looking; D-052 says the same thing.
 *
 * Exported as a predicate rather than folded into a route, so that the publish
 * path and the claim path cannot answer it differently.
 */
export function mayActOnQuest(
  caller: Agent,
  quest: { readonly createdBy: string | null },
): boolean {
  return quest.createdBy !== caller.id
}
