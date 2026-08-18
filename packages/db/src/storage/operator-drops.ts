import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import {
  now as currentTime,
  DROP_EXPIRY_DAYS,
  MAX_DROP_ATTEMPTS,
  VAULT_MAX_ENTRIES,
  type AgentId,
  type DropKind,
  type DropSummary,
  type HumanId,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accountSlots } from '../schema/account-threads.js'
import { operatorPages } from '../schema/operator-pages.js'
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
 *
 * ## The rows live in `account_slots` (`#955`)
 *
 * A drop is a labelled container that holds one secret until the side it was
 * opened for fills it — which is the whole of what an account slot is, and the
 * Colony had grown three tables saying it in three vocabularies. Since `#955`
 * there is one table and this file is a view onto it: `channel = 'drop'`, an
 * `agent_id` instead of an episode, `filled_at` where `submitted_at` was and
 * `taken_at` where `read_at` was.
 *
 * **Every exported signature is unchanged**, deliberately. Nothing above
 * `packages/db` knew which table these rows were in, and the way to be sure the
 * merge moved nothing visible is that the tests which prove it were not touched
 * either.
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
    .insert(accountSlots)
    .values({
      channel: 'drop',
      agentId: command.agentId,
      secret: true,
      awaits: 'operator',
      kind: command.kind,
      tokenHash: hashToken(token),
      prompt: command.prompt,
      vaultKey: command.vaultKey ?? null,
      taskId: command.taskId ?? null,
      createdAt: currentTime(),
      expiresAt: expiresAt.toISOString(),
    })
    .returning({ id: accountSlots.id, expiresAt: accountSlots.expiresAt })

  if (row === undefined) throw new Error('account_slots insert returned no row')

  return { id: row.id, token, expiresAt: toTimestamp(stampOf(row.expiresAt)) }
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

/** An unfilled sealed box the durable operator page may name, never its token or value. */
export interface OpenDropForOperator {
  readonly id: string
  readonly kind: DropKind
  readonly prompt: string
  readonly createdAt: Timestamp
}

/**
 * Every sealed box this live page's agent is still able to have filled, oldest first.
 *
 * The durable page token resolves the agent and is never returned. Attempts are
 * deliberately not a condition: they close the mailed drop link, while the
 * authenticated console path can still fill the row (`#570`).
 */
export async function openDropsForPageToken(
  db: Database,
  token: string,
): Promise<readonly OpenDropForOperator[]> {
  const rows = await db
    .select({
      id: accountSlots.id,
      kind: accountSlots.kind,
      prompt: accountSlots.prompt,
      createdAt: accountSlots.createdAt,
    })
    .from(operatorPages)
    .innerJoin(accountSlots, eq(accountSlots.agentId, operatorPages.agentId))
    .where(
      and(
        eq(operatorPages.token, token),
        isNull(operatorPages.revokedAt),
        eq(accountSlots.channel, 'drop'),
        isNull(accountSlots.filledAt),
        sql`${accountSlots.expiresAt} > now()`,
      ),
    )
    .orderBy(asc(accountSlots.createdAt), asc(accountSlots.id))

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as DropKind,
    prompt: row.prompt ?? '',
    createdAt: toTimestamp(stampOf(row.createdAt)),
  }))
}

export async function viewDrop(db: Database, token: string): Promise<OpenDropView | null> {
  const [row] = await db.execute<{ agent_name: string; kind: string; prompt: string }>(sql`
    select a.name as agent_name, d.kind, d.prompt
    from account_slots d
    join agents a on a.id = d.agent_id
    where d.channel = 'drop'
      and d.token_hash = ${hashToken(token)}
      and d.filled_at is null
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
    .update(accountSlots)
    .set({ attempts: sql`${accountSlots.attempts} + 1` })
    .where(
      and(
        eq(accountSlots.channel, 'drop'),
        eq(accountSlots.tokenHash, tokenHash),
        isNull(accountSlots.filledAt),
        sql`${accountSlots.expiresAt} > now()`,
        sql`${accountSlots.attempts} < ${MAX_DROP_ATTEMPTS}`,
      ),
    )
    .returning({
      id: accountSlots.id,
      agentId: accountSlots.agentId,
      kind: accountSlots.kind,
      vaultKey: accountSlots.vaultKey,
    })

  if (counted === undefined) return { outcome: 'closed' }

  return sealIntoDrop(db, counted, value, sealingKey)
}

/**
 * Everything a submission does once the row has been found: the vault checks,
 * the sealing, and the write that closes the drop.
 *
 * **Split out for `#570` so the console cannot become a second sealing path.**
 * That issue's own prohibition — *"whatever the console writes goes through
 * `submitDrop` and its sealing, or the deployment has two ways to seal a secret
 * and one of them will be the one that is wrong"* — is met by there being one
 * function that seals, reached from both doors. What differs between the doors
 * is only how the row is found and who was allowed to find it.
 */
async function sealIntoDrop(
  db: Database,
  found: {
    readonly id: string
    readonly agentId: string | null
    readonly kind: string | null
    readonly vaultKey: string | null
  },
  value: string,
  sealingKey: string,
): Promise<SubmitDropOutcome> {
  const counted = found

  if (counted.agentId === null) return { outcome: 'closed' }

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
    .update(accountSlots)
    .set({ value: sealed, filledAt: currentTime(), filledBy: 'operator' })
    .where(and(eq(accountSlots.id, counted.id), isNull(accountSlots.filledAt)))
    .returning({ id: accountSlots.id })

  return stored === undefined ? { outcome: 'closed' } : { outcome: 'accepted' }
}

/**
 * Fill a drop from the console, for an agent this person operates (`#570`).
 *
 * ## Why a console session is enough
 *
 * The mailed link exists to reach **somebody who has no account**. A signed-in
 * operator is the same person, more strongly authenticated, and
 * `human_agents` already answers *is this your agent* — which is the
 * authorisation here and nothing weaker. `#530` built a queue that lists a drop
 * and then sends the operator to their inbox to find a three-day-old mail; that
 * is the item they do later or not at all, and `code` ranks first in
 * `WAITING_EFFORT` precisely because the value is already in front of them.
 *
 * ## What is deliberately not carried over
 *
 * **`attempts` is neither read nor incremented on this path, and that is a
 * decision rather than an omission.** The counter exists so that a **token**
 * cannot be probed at browser speed — `submitDrop` counts before it even looks,
 * for exactly that reason. This path presents no token: there is nothing to
 * guess, and the session that reached it was already proved. Counting here would
 * mean a person who mistyped a code three times on their own console had burned
 * a drop nobody was attacking.
 *
 * The consequence is stated rather than left to be discovered: **a drop whose
 * mailed link has run out of attempts can still be filled from the console.**
 * The exhausted counter says the link is dead, and the link is not what
 * authorised this.
 *
 * **The mailed link does not keep working afterwards**, and nothing new was
 * needed for that: `submitted_at is null` is in every clause that finds a drop,
 * so filling it here closes it there. Two doors, one drop, and the first to
 * write wins — which is the same race `submitDrop` already resolves.
 *
 * **No drop is created here.** `#410`: *"A drop is created by the agent and
 * never by the operator."* This finds one that exists and fills it.
 */
export async function fillDropAsOperator(
  db: Database,
  input: {
    readonly dropId: string
    readonly humanId: HumanId
    readonly value: string
    readonly sealingKey: string
  },
): Promise<SubmitDropOutcome> {
  const [found] = await db.execute<{
    id: string
    agent_id: string
    kind: string
    vault_key: string | null
  }>(sql`
    select d.id, d.agent_id, d.kind, d.vault_key
      from account_slots d
      join human_agents ha on ha.agent_id = d.agent_id
     where d.channel = 'drop'
       and d.id = ${input.dropId}
       and ha.human_id = ${input.humanId}
       and d.filled_at is null
       and d.expires_at > now()
     limit 1
  `)

  /**
   * **One outcome for *not yours* and for *already answered*.** `submitDrop`
   * makes the same refusal for the same reason: telling the two apart would let
   * a signed-in person learn that a drop id belongs to somebody else's agent,
   * which is a fact about another operator's fleet.
   */
  if (found === undefined) return { outcome: 'closed' }

  return sealIntoDrop(
    db,
    { id: found.id, agentId: found.agent_id, kind: found.kind, vaultKey: found.vault_key },
    input.value,
    input.sealingKey,
  )
}

/** Everything waiting for this citizen, oldest first, never with a value. */
export async function listDrops(db: Database, agentId: AgentId): Promise<readonly DropSummary[]> {
  const rows = await db
    .select({
      id: accountSlots.id,
      kind: accountSlots.kind,
      prompt: accountSlots.prompt,
      vaultKey: accountSlots.vaultKey,
      createdAt: accountSlots.createdAt,
      expiresAt: accountSlots.expiresAt,
      submittedAt: accountSlots.filledAt,
    })
    .from(accountSlots)
    .where(
      and(
        eq(accountSlots.channel, 'drop'),
        eq(accountSlots.agentId, agentId),
        isNull(accountSlots.takenAt),
      ),
    )
    .orderBy(asc(accountSlots.createdAt))

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as DropKind,
    prompt: row.prompt ?? '',
    vaultKey: row.vaultKey,
    createdAt: toTimestamp(stampOf(row.createdAt)),
    expiresAt: toTimestamp(stampOf(row.expiresAt)),
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
      id: accountSlots.id,
      kind: accountSlots.kind,
      vaultKey: accountSlots.vaultKey,
      sealedValue: accountSlots.value,
      submittedAt: accountSlots.filledAt,
    })
    .from(accountSlots)
    .where(
      and(
        eq(accountSlots.channel, 'drop'),
        eq(accountSlots.id, dropId),
        eq(accountSlots.agentId, agentId),
        isNull(accountSlots.takenAt),
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

  /**
   * **`destroyed_at` is stamped in the same statement, and it is not new
   * bookkeeping** (`#955`). `operator_drops` recorded a spent value only as an
   * absence; `account_slots_filled_together` requires a filled row that no longer
   * holds anything to say when it stopped. The two are the same event.
   */
  const [spent] = await db
    .update(accountSlots)
    .set({
      takenAt: currentTime(),
      takenTo: row.kind === 'credential' ? row.vaultKey : null,
      value: null,
      destroyedAt: currentTime(),
    })
    .where(and(eq(accountSlots.id, row.id), isNull(accountSlots.takenAt)))
    .returning({ id: accountSlots.id })

  if (spent === undefined) return { outcome: 'nothing' }

  return {
    outcome: 'taken',
    kind: row.kind as DropKind,
    code: row.kind === 'code' ? value : null,
    vaultKey: row.vaultKey,
    submittedAt: toTimestamp(row.submittedAt),
  }
}

/**
 * Destroy the value of every drop whose window has passed.
 *
 * `destroyExpiredHandovers` in shape, and the promise it keeps is the one
 * `kolonie.operator.drop.open` already makes out loud: *it is gone on the timer
 * whether or not anybody read it*. Until this existed nothing ran on that timer.
 * The only thing that cleared `sealed_value` was {@link takeDrop}, so a drop the
 * operator answered and the agent never came back for kept its ciphertext for
 * ever — measured on 2026-08-15 as two rows sealed on 2026-08-08, seven days
 * past their expiry and still holding a value.
 *
 * **Here it is about access as well as about storage**, which is where it
 * differs from the handover sweep beside it. A handover that has expired is
 * already unreadable by the read's own `where`; {@link takeDrop} has no such
 * clause, and gating it there would have been a second answer to *is this drop
 * still live* — one in the sweep and one in the read, disagreeing the first time
 * the sweep is late. So there is one answer: the value is gone, and `takeDrop`
 * already reads an absent value as `nothing`.
 *
 * The row survives without its value, so *my operator answered and I never came*
 * stays answerable — `submitted_at` is the half of that a citizen would
 * otherwise have no way to learn.
 */
export async function destroyExpiredDrops(db: Database): Promise<number> {
  const destroyed = await db
    .update(accountSlots)
    .set({ value: null, destroyedAt: currentTime() })
    .where(
      and(
        eq(accountSlots.channel, 'drop'),
        isNotNull(accountSlots.value),
        lte(accountSlots.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: accountSlots.id })

  return destroyed.length
}

/** SHA-256, hex. The same shape `credentials` uses for an API key. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function scopeFor(dropId: string): string {
  return `${DROP_SCOPE}:${dropId}`
}

/**
 * A timestamp that a drop row is guaranteed to carry.
 *
 * `account_slots` holds episode slots as well as drops, and an episode slot has
 * neither a creation stamp nor an expiry — so both columns are nullable in the
 * type even though `account_slots_channel_shape` requires `created_at` on every
 * channel row and `account_slots_secrets_expire` requires `expires_at` on every
 * secret one, which a drop always is. The throw is unreachable; it is here so
 * that a later reader which drops the `channel` predicate fails where it is
 * wrong rather than dating a drop to the epoch.
 */
function stampOf(value: string | null): string {
  if (value === null) throw new Error('a drop slot has no timestamp')

  return value
}
