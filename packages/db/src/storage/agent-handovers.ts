import { and, asc, eq, gt, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import {
  HANDOVER_EXPIRY_HOURS,
  HANDOVER_MAX_READS,
  now as currentTime,
  type AgentId,
  type HandoverSummary,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accountSlots } from '../schema/account-threads.js'
import { agents } from '../schema/agents.js'
import { humanAgents } from '../schema/human-links.js'
import { openVaultValue, sealVaultValue } from '../vault-crypto.js'
import { toTimestamp } from './rows.js'

/**
 * The agent-to-operator secret channel (`#592`).
 *
 * The reasoning for the channel is in `packages/core/src/operator/handover.ts`
 * and the decision behind it is in `kolonie-docs`. What the table is and is not
 * is in `packages/db/src/schema/agent-handovers.ts`. What lives here is three
 * acts: an agent seals a value, its operator reads it through a signed-in
 * session, and the Colony destroys it.
 *
 * **There is no read path that takes a token**, and that is the guarantee rather
 * than a policy: `readAsOperator` is authorised by `human_agents`, which is a
 * join, and nothing in this file accepts a secret string as authorisation. A
 * leaked operator-page link cannot reach any function here.
 *
 * ## The rows live in `account_slots` (`#955`)
 *
 * A handover is a labelled container that holds one secret until the side it was
 * opened for reads it, which is the whole of what an account slot is. Since
 * `#955` there is one table for all three secret channels and this file is a view
 * onto it: `channel = 'handover'`, an `agent_id` instead of an episode, and
 * `value` where `sealed_value` was.
 *
 * **Every exported signature is unchanged**, deliberately, and so are the tests
 * that prove it — a proof written after the change would prove the change rather
 * than the property.
 */

/**
 * The label the value is bound to inside the envelope.
 *
 * `sealVaultValue` mixes the agent id and this string into GCM's associated
 * data, so a ciphertext lifted onto another citizen's row — or onto a vault
 * entry, or onto an operator drop — fails to open rather than opening as
 * something else. Its own scope for exactly that reason.
 */
const HANDOVER_SCOPE = 'agent-handover'

const scopeFor = (id: string): string => `${HANDOVER_SCOPE}:${id}`

/**
 * A timestamp a handover row is guaranteed to carry.
 *
 * `account_slots` holds episode slots as well as handovers, and an episode slot
 * has neither a creation stamp nor an expiry — so both columns are nullable in
 * the type even though `account_slots_channel_shape` requires `created_at` on
 * every channel row and `account_slots_secrets_expire` requires `expires_at` on
 * every secret one, which a handover always is. The throw is unreachable; it is
 * here so that a later reader which drops the `channel` predicate fails where it
 * is wrong rather than dating a handover to the epoch.
 */
const stampOf = (value: string | null): string => {
  if (value === null) throw new Error('a handover slot has no timestamp')

  return value
}

export type OpenHandoverOutcome =
  | { readonly outcome: 'opened'; readonly id: string; readonly expiresAt: string }
  /** The deployment has no sealing key, so nothing can be sealed. */
  | { readonly outcome: 'unsealable' }

/**
 * Seal a value for this citizen's operator.
 *
 * **Sealed before it is stored and never after**, so there is no moment at which
 * the plaintext exists in a row. The row id is the label, which means the
 * ciphertext has to be inserted first and updated with itself — the same two-step
 * `submitDrop` performs, and for the same reason: a label that is not unique per
 * row lets a ciphertext be moved between rows.
 */
export async function openHandover(
  db: Database,
  command: {
    readonly agentId: AgentId
    readonly provider: string
    readonly prompt: string
    readonly value: string
  },
  sealingKey: string | undefined,
): Promise<OpenHandoverOutcome> {
  if (sealingKey === undefined) return { outcome: 'unsealable' }

  const expiresAt = new Date(Date.now() + HANDOVER_EXPIRY_HOURS * 60 * 60 * 1000).toISOString()
  const createdAt = currentTime()

  const [row] = await db
    .insert(accountSlots)
    .values({
      channel: 'handover',
      agentId: command.agentId,
      secret: true,
      /**
       * A handover is filled by the agent at the instant it is opened, so it is
       * `awaits: 'agent'` and filled in the same breath — unlike a drop, which
       * waits for the side it names. There is no unfilled state to represent.
       */
      awaits: 'agent',
      filledBy: 'agent',
      filledAt: createdAt,
      provider: command.provider,
      prompt: command.prompt,
      // A placeholder the constraint accepts, replaced in the same transaction
      // by the real ciphertext once the row has an id to be labelled with.
      value: 'pending',
      createdAt,
      expiresAt,
    })
    .returning({ id: accountSlots.id })

  if (row === undefined) throw new Error('inserting a handover returned no row')

  const sealed = sealVaultValue(
    sealingKey,
    String(command.agentId),
    scopeFor(row.id),
    command.value,
  )

  await db.update(accountSlots).set({ value: sealed }).where(eq(accountSlots.id, row.id))

  return { outcome: 'opened', id: row.id, expiresAt }
}

/**
 * What is waiting for one person to read, across every agent they operate.
 *
 * Never carries a value and never carries a ciphertext — a listing is a listing.
 *
 * **`agentId` narrows it to one agent, and the human id still authorises it**
 * (`#1027`). One agent's accounts page renders what that agent sealed, and the
 * name would have been the other way to get there — names are unique, so it
 * would have worked, and it would have made a display string load-bearing for a
 * query about credentials. The filter is added to the `where` rather than
 * applied by the caller so there is no version of this list that arrives whole
 * at a page which then has to remember to trim it.
 */
export async function handoversFor(
  db: Database,
  humanId: string,
  agentId?: AgentId,
): Promise<readonly HandoverSummary[]> {
  const rows = await db
    .select({
      id: accountSlots.id,
      agentName: agents.name,
      provider: accountSlots.provider,
      prompt: accountSlots.prompt,
      createdAt: accountSlots.createdAt,
      expiresAt: accountSlots.expiresAt,
      reads: accountSlots.reads,
    })
    .from(accountSlots)
    .innerJoin(agents, eq(agents.id, accountSlots.agentId))
    .innerJoin(humanAgents, eq(humanAgents.agentId, accountSlots.agentId))
    .where(
      and(
        eq(accountSlots.channel, 'handover'),
        eq(humanAgents.humanId, humanId),
        isNull(accountSlots.destroyedAt),
        gt(accountSlots.expiresAt, sql`now()`),
        ...(agentId === undefined ? [] : [eq(accountSlots.agentId, agentId)]),
      ),
    )
    .orderBy(asc(accountSlots.expiresAt))

  return rows.map((row) => ({
    id: row.id,
    agentName: row.agentName,
    provider: row.provider ?? '',
    prompt: row.prompt ?? '',
    createdAt: toTimestamp(stampOf(row.createdAt)),
    expiresAt: toTimestamp(stampOf(row.expiresAt)),
    readsLeft: Math.max(HANDOVER_MAX_READS - row.reads, 0),
  }))
}

export type ReadHandoverOutcome =
  | {
      readonly outcome: 'read'
      readonly value: string
      readonly provider: string
      readonly prompt: string
      /** After this read. Zero means it has just been destroyed. */
      readonly readsLeft: number
    }
  /**
   * Expired, destroyed, out of reads, never existed, or not this person's agent.
   *
   * **One answer for all of them**, following the drop's own rule: a person who
   * guessed an id learns nothing about whether it ever existed, and neither does
   * one whose agent it is not.
   */
  | { readonly outcome: 'closed' }

/**
 * Read it, as the person who operates the agent (`#592`).
 *
 * **Authorised by `human_agents` and by nothing else.** There is no token
 * parameter to leave out — the join *is* the authorisation, which is what makes
 * *the mailed bearer link cannot read this* a property of the code rather than a
 * check somebody has to remember.
 *
 * **The count moves before the value is returned**, so a read that fails
 * afterwards has still been counted. The alternative loses the bound the moment
 * anything goes wrong, and a bound that fails open on the credential channel is
 * not a bound.
 *
 * **The last read destroys it in the same statement.** Not swept later, not
 * destroyed on the next visit: a value that outlives its own limit by however
 * long a sweep takes is readable for that long.
 */
export async function readHandoverAsOperator(
  db: Database,
  handoverId: string,
  humanId: string,
  sealingKey: string | undefined,
): Promise<ReadHandoverOutcome> {
  if (sealingKey === undefined) return { outcome: 'closed' }

  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: accountSlots.id,
        agentId: accountSlots.agentId,
        provider: accountSlots.provider,
        prompt: accountSlots.prompt,
        sealedValue: accountSlots.value,
        reads: accountSlots.reads,
      })
      .from(accountSlots)
      .innerJoin(humanAgents, eq(humanAgents.agentId, accountSlots.agentId))
      .where(
        and(
          eq(accountSlots.channel, 'handover'),
          eq(accountSlots.id, handoverId),
          eq(humanAgents.humanId, humanId),
          isNull(accountSlots.destroyedAt),
          isNotNull(accountSlots.value),
          gt(accountSlots.expiresAt, sql`now()`),
        ),
      )
      .for('update')
      .limit(1)

    if (row === undefined || row.sealedValue === null) return { outcome: 'closed' }
    if (row.reads >= HANDOVER_MAX_READS) return { outcome: 'closed' }

    const value = openVaultValue(sealingKey, String(row.agentId), scopeFor(row.id), row.sealedValue)
    /**
     * A ciphertext that will not open is `closed` like everything else. It means
     * the deployment's key has changed under a live handover, and the honest
     * answer to the operator is the same one every other dead state gives —
     * telling it *the key rotated* would be telling it about the deployment.
     */
    if (value === null || value === undefined) return { outcome: 'closed' }

    const reads = row.reads + 1
    const spent = reads >= HANDOVER_MAX_READS

    await tx
      .update(accountSlots)
      .set({
        reads,
        lastReadAt: currentTime(),
        ...(spent ? { value: null, destroyedAt: currentTime() } : {}),
      })
      .where(eq(accountSlots.id, row.id))

    return {
      outcome: 'read',
      value,
      provider: row.provider ?? '',
      prompt: row.prompt ?? '',
      readsLeft: HANDOVER_MAX_READS - reads,
    }
  })
}

/**
 * Destroy every handover whose window has passed.
 *
 * **The value goes and the row stays**, so *my operator never read it* remains
 * answerable — the same shape `operator_drops` keeps for a taken drop. Run by
 * the same sweep that closes abandoned attempts; a handover that has expired is
 * already unreadable by {@link readHandoverAsOperator}'s own `where`, so this is
 * about not keeping ciphertext rather than about access.
 */
export async function destroyExpiredHandovers(db: Database): Promise<number> {
  const destroyed = await db
    .update(accountSlots)
    .set({ value: null, destroyedAt: currentTime() })
    .where(
      and(
        eq(accountSlots.channel, 'handover'),
        isNull(accountSlots.destroyedAt),
        lte(accountSlots.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: accountSlots.id })

  return destroyed.length
}
