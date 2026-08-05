import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import {
  now as currentTime,
  DROP_EXPIRY_DAYS,
  MAX_DROP_ATTEMPTS,
  VAULT_MAX_ENTRIES,
  type AgentId,
  type DropKind,
  type DropSummary,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { operatorDrops } from '../schema/operator-drops.js'
import { agentVault } from '../schema/vault.js'
import { openVaultValue, sealVaultValue } from '../vault-crypto.js'
import { toTimestamp } from './rows.js'

/**
 * The operator-to-agent secret channel (`#410`).
 *
 * The reasoning for the channel is in `packages/core/src/operator/drop.ts`, and
 * what the sealing here is and is not is in
 * `packages/db/src/schema/operator-drops.ts`. What lives here is the four acts:
 * an agent opens a drop, an operator fills it in, the agent takes it, and — for a
 * credential — the taking is also the moment it stops being sealed under the
 * Colony's key and starts being sealed under the citizen's own.
 *
 * **Nothing in this file writes a submitted value anywhere but into a sealed
 * column.** There is no log line, no error message and no return value that
 * carries one, except the single deliberate one: {@link takeDrop} answering a
 * code to the agent that asked for it.
 */

/** Bytes of randomness in a drop's link secret. 32 bytes is 256 bits. */
const DROP_TOKEN_BYTES = 32

/**
 * The label the value is bound to inside the envelope.
 *
 * `sealVaultValue` mixes the agent id and this string into GCM's associated
 * data, so a ciphertext moved onto another citizen's row, or onto a vault entry,
 * fails to open rather than opening as something else.
 */
const DROP_SCOPE = 'operator-drop'

export interface OpenDropCommand {
  readonly agentId: AgentId
  readonly kind: DropKind
  readonly prompt: string
  /** Required for `credential`, absent for `code`. */
  readonly vaultKey?: string | undefined
  /** Required for `code`, absent for `credential`. */
  readonly taskId?: TaskId | undefined
}

export interface OpenedDrop {
  readonly id: string
  /** Handed back exactly once. The Colony stores only its hash. */
  readonly token: string
  readonly expiresAt: Timestamp
}

/** Mint one drop. Only ever called on an agent's own authenticated request. */
export async function openDrop(db: Database, command: OpenDropCommand): Promise<OpenedDrop> {
  const token = randomBytes(DROP_TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.parse(currentTime()) + DROP_EXPIRY_DAYS * 86_400_000)

  const [row] = await db
    .insert(operatorDrops)
    .values({
      agentId: command.agentId,
      kind: command.kind,
      tokenHash: hashToken(token),
      prompt: command.prompt,
      vaultKey: command.vaultKey ?? null,
      taskId: command.taskId ?? null,
      expiresAt: expiresAt.toISOString(),
    })
    .returning({ id: operatorDrops.id, expiresAt: operatorDrops.expiresAt })

  if (row === undefined) throw new Error('operator_drops insert returned no row')

  return { id: row.id, token, expiresAt: toTimestamp(row.expiresAt) }
}

/**
 * What the operator's page shows: the citizen's name and what it asked for.
 *
 * **`null` for every closed state**, and that is the contract rather than an
 * omission. Expired, already answered, already read, revoked by erasure, never
 * existed — the page cannot tell them apart, so a stranger holding a guessed link
 * learns nothing about whether it ever named anything.
 */
export interface OpenDropView {
  readonly agentName: string
  readonly kind: DropKind
  readonly prompt: string
}

export async function viewDrop(db: Database, token: string): Promise<OpenDropView | null> {
  const [row] = await db.execute<{ agent_name: string; kind: string; prompt: string }>(sql`
    select a.name as agent_name, d.kind, d.prompt
    from operator_drops d
    join agents a on a.id = d.agent_id
    where d.token_hash = ${hashToken(token)}
      and d.submitted_at is null
      and d.expires_at > now()
      and d.attempts < ${MAX_DROP_ATTEMPTS}
    limit 1
  `)

  if (row === undefined) return null

  return { agentName: row.agent_name, kind: row.kind as DropKind, prompt: row.prompt }
}

export type SubmitDropOutcome =
  /** It landed. The operator is told this and nothing about the citizen. */
  | { readonly outcome: 'accepted' }
  /**
   * Expired, already answered, out of attempts, or never a drop.
   *
   * One outcome for all of them, which is the same refusal `viewDrop` makes and
   * for the same reason.
   */
  | { readonly outcome: 'closed' }
  /**
   * The vault key this credential was to land under is occupied.
   *
   * **Checked here, before the operator hands anything over**, rather than at the
   * far end where the person would already have typed a password into a field
   * that then refused it. An operator cannot destroy a credential the agent is
   * relying on, and it should not be able to waste one either.
   */
  | { readonly outcome: 'key-taken'; readonly vaultKey: string }
  /** The citizen's vault is full. Same reasoning as above: better said now. */
  | { readonly outcome: 'vault-full'; readonly maxEntries: number }

/**
 * Take what the operator wrote and seal it.
 *
 * **The attempt is counted before anything else happens**, including before the
 * row is found to be openable, so a link cannot be used to probe at whatever rate
 * a browser allows. A drop that has run out of attempts is `closed` like every
 * other ending.
 */
export async function submitDrop(
  db: Database,
  token: string,
  value: string,
  sealingKey: string,
): Promise<SubmitDropOutcome> {
  const tokenHash = hashToken(token)

  const [counted] = await db
    .update(operatorDrops)
    .set({ attempts: sql`${operatorDrops.attempts} + 1` })
    .where(
      and(
        eq(operatorDrops.tokenHash, tokenHash),
        isNull(operatorDrops.submittedAt),
        sql`${operatorDrops.expiresAt} > now()`,
        sql`${operatorDrops.attempts} < ${MAX_DROP_ATTEMPTS}`,
      ),
    )
    .returning({
      id: operatorDrops.id,
      agentId: operatorDrops.agentId,
      kind: operatorDrops.kind,
      vaultKey: operatorDrops.vaultKey,
    })

  if (counted === undefined) return { outcome: 'closed' }

  if (counted.kind === 'credential' && counted.vaultKey !== null) {
    const occupied = await db
      .select({ key: agentVault.key })
      .from(agentVault)
      .where(and(eq(agentVault.agentId, counted.agentId), eq(agentVault.key, counted.vaultKey)))
      .limit(1)

    if (occupied.length > 0) return { outcome: 'key-taken', vaultKey: counted.vaultKey }

    const [entries] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentVault)
      .where(eq(agentVault.agentId, counted.agentId))

    if ((entries?.count ?? 0) >= VAULT_MAX_ENTRIES) {
      return { outcome: 'vault-full', maxEntries: VAULT_MAX_ENTRIES }
    }
  }

  /**
   * Sealed before it reaches the database and never held in a column that could
   * be selected in plaintext. The row id is the label, so a ciphertext lifted
   * onto another drop opens as nothing.
   */
  const sealed = sealVaultValue(sealingKey, String(counted.agentId), scopeFor(counted.id), value)

  /**
   * `submitted_at is null` again, so two operators posting the same link at the
   * same moment produce one winner. The loser is `closed`, which is honest: by
   * the time it was written the drop was answered.
   */
  const [stored] = await db
    .update(operatorDrops)
    .set({ sealedValue: sealed, submittedAt: currentTime() })
    .where(and(eq(operatorDrops.id, counted.id), isNull(operatorDrops.submittedAt)))
    .returning({ id: operatorDrops.id })

  return stored === undefined ? { outcome: 'closed' } : { outcome: 'accepted' }
}

/** Everything waiting for this citizen, oldest first, never with a value. */
export async function listDrops(db: Database, agentId: AgentId): Promise<readonly DropSummary[]> {
  const rows = await db
    .select({
      id: operatorDrops.id,
      kind: operatorDrops.kind,
      prompt: operatorDrops.prompt,
      vaultKey: operatorDrops.vaultKey,
      createdAt: operatorDrops.createdAt,
      expiresAt: operatorDrops.expiresAt,
      submittedAt: operatorDrops.submittedAt,
    })
    .from(operatorDrops)
    .where(and(eq(operatorDrops.agentId, agentId), isNull(operatorDrops.readAt)))
    .orderBy(asc(operatorDrops.createdAt))

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as DropKind,
    prompt: row.prompt,
    vaultKey: row.vaultKey,
    createdAt: toTimestamp(row.createdAt),
    expiresAt: toTimestamp(row.expiresAt),
    submittedAt: row.submittedAt === null ? null : toTimestamp(row.submittedAt),
  }))
}

export type TakeDropOutcome =
  | {
      readonly outcome: 'taken'
      readonly kind: DropKind
      /** The value, for a `code`. Null for a `credential` — it went to the vault. */
      readonly code: string | null
      readonly vaultKey: string | null
      readonly submittedAt: Timestamp
    }
  /** No such drop, not this citizen's, not answered yet, or already taken. */
  | { readonly outcome: 'nothing' }
  /**
   * The row is there and the envelope will not open.
   *
   * Distinguished from `nothing` because the two need opposite responses: this
   * one means the deployment's sealing key is not the one the value was written
   * under, which is an operator's problem and not the citizen's, and it must not
   * read as *your operator never answered*.
   */
  | { readonly outcome: 'unreadable' }

/**
 * Take one drop, once.
 *
 * **The read is what spends it**, and for a credential it is also the moment the
 * value moves from the Colony's sealing to the citizen's own: `vaultToken` is the
 * agent's plaintext API key, held for the length of this one request, which is
 * the only window in which the Colony can write a vault the Colony cannot read.
 *
 * The ciphertext is cleared in the same statement that stamps `read_at`, so a
 * drop cannot be taken twice even if two wakings race.
 */
export async function takeDrop(
  db: Database,
  agentId: AgentId,
  dropId: string,
  sealingKey: string,
  vaultToken: string,
): Promise<TakeDropOutcome> {
  const [row] = await db
    .select({
      id: operatorDrops.id,
      kind: operatorDrops.kind,
      vaultKey: operatorDrops.vaultKey,
      sealedValue: operatorDrops.sealedValue,
      submittedAt: operatorDrops.submittedAt,
    })
    .from(operatorDrops)
    .where(
      and(
        eq(operatorDrops.id, dropId),
        eq(operatorDrops.agentId, agentId),
        isNull(operatorDrops.readAt),
      ),
    )
    .limit(1)

  if (row === undefined || row.sealedValue === null || row.submittedAt === null) {
    return { outcome: 'nothing' }
  }

  const value = openVaultValue(sealingKey, String(agentId), scopeFor(row.id), row.sealedValue)

  if (value === null) return { outcome: 'unreadable' }

  if (row.kind === 'credential' && row.vaultKey !== null) {
    /**
     * **Refuses an occupied key rather than overwriting, and the index is what
     * refuses.** {@link submitDrop} checked this before the operator handed
     * anything over; here it is checked again because the agent may have written
     * that key itself in between, and an operator must not destroy something the
     * citizen is relying on — including by having been early.
     *
     * `onConflictDoNothing` and not a `select` first, because a `select` first is
     * exactly the race two concurrent wakings lose: both read an empty key, both
     * insert, and one dies on `agent_vault_agent_key_unique` with a 500 instead of
     * losing quietly. Found by the concurrency test rather than by reading this,
     * which is why the test is in the file.
     */
    const [written] = await db
      .insert(agentVault)
      .values({
        agentId,
        key: row.vaultKey,
        encryptedValue: sealVaultValue(vaultToken, String(agentId), row.vaultKey, value),
      })
      .onConflictDoNothing({ target: [agentVault.agentId, agentVault.key] })
      .returning({ key: agentVault.key })

    if (written === undefined) return { outcome: 'nothing' }
  }

  const [spent] = await db
    .update(operatorDrops)
    .set({ readAt: currentTime(), sealedValue: null })
    .where(and(eq(operatorDrops.id, row.id), isNull(operatorDrops.readAt)))
    .returning({ id: operatorDrops.id })

  if (spent === undefined) return { outcome: 'nothing' }

  return {
    outcome: 'taken',
    kind: row.kind as DropKind,
    code: row.kind === 'code' ? value : null,
    vaultKey: row.vaultKey,
    submittedAt: toTimestamp(row.submittedAt),
  }
}

/** SHA-256, hex. The same shape `credentials` uses for an API key. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function scopeFor(dropId: string): string {
  return `${DROP_SCOPE}:${dropId}`
}
