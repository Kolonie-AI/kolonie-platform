import { and, asc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import {
  now as currentTime,
  VAULT_SHARE_DEFAULT_DAYS,
  VAULT_SHARE_MAX_DAYS,
  type AgentId,
  type HumanId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { humanAgents } from '../schema/human-links.js'
import { operatorPages } from '../schema/operator-pages.js'
import { agentVault } from '../schema/vault.js'
import { vaultShares } from '../schema/vault-shares.js'
import { openVaultValue, sealVaultValue, vaultDescriptionScope } from '../vault-crypto.js'
import { toTimestamp } from './rows.js'

/**
 * Sharing one vault entry with the citizen's operator (`#1439`).
 *
 * The argument for the mechanism is on `packages/db/src/schema/vault-shares.ts`
 * and the epic is `#1437`. What lives here is the four acts: a citizen opens a
 * share, every read of the vault is told about it, the citizen takes it back,
 * and a sweep destroys what nobody ended.
 *
 * **Nothing in this file writes a plaintext anywhere but into a sealed column.**
 * There is no log line, no error message and no return value that carries one,
 * except the single deliberate one: {@link unshareVaultEntry} handing the
 * operator's addition to the citizen that asked for it back.
 *
 * ## It does not import `./vault.js`, deliberately
 *
 * `vault.ts` imports *this* module — every entry it answers with carries its
 * share — so a call the other way would be a cycle. The two reads this needs
 * from `agent_vault` are therefore written out rather than borrowed, and the one
 * piece of shared knowledge that could drift, the description's sealing scope,
 * lives in `vault-crypto.ts` where both can reach it.
 */

/**
 * What the copy is bound to inside the envelope.
 *
 * `sealVaultValue` mixes the agent id and this string into GCM's associated
 * data, so a share's ciphertext lifted onto a vault row — or onto another
 * citizen's share — opens as nothing rather than as something else. The key is
 * in the scope as well as the agent, because a citizen holds many entries and
 * two of its own shares must not be interchangeable either.
 */
const shareScope = (key: string): string => `vault-share:${key}`

/** The operator's addition, under its own scope for {@link shareScope}'s reason. */
const additionScope = (key: string): string => `vault-share:${key}#addition`

/** One open share, as every reader of the vault is shown it. */
export interface VaultShareRow {
  readonly purpose: string
  readonly sharedAt: Timestamp
  readonly expiresAt: Timestamp
  /** Whether the operator has written back. Never *what* — see the core schema. */
  readonly operatorWrote: boolean
  /**
   * How many times a person has opened the value (`#1440`).
   *
   * **Zero is the answer that matters.** It is what tells a citizen its operator
   * has not looked yet, as against having looked and not acted — two states that
   * were indistinguishable on every channel before this, and the reason nobody
   * noticed forty-two unread handovers for as long as they did.
   */
  readonly reads: number
  /** When the last of those reads was, or null. */
  readonly lastReadAt: Timestamp | null
}

/** What happened when a citizen tried to share something. */
export type ShareVaultEntryOutcome =
  | {
      readonly outcome: 'shared'
      readonly share: VaultShareRow
      readonly extended: boolean
      /**
       * The row's id, so a caller can attach it to a conversation (`#1441`).
       *
       * Returned rather than looked up again by the attach path: the two would
       * be one statement apart, and a citizen that shared and re-shared in the
       * same second could attach the row it did not just write.
       */
      readonly shareId: string
    }
  /** Nothing is stored under that name. */
  | { readonly outcome: 'unknown' }
  /**
   * The account this entry opened moved to another citizen (`#1214`).
   *
   * Refused for `getVaultEntry`'s reason, one step further along: handing a
   * spent credential to a *person* would not merely tell the citizen it still
   * held the account, it would send somebody to go and use it.
   */
  | { readonly outcome: 'spent' }
  /** The row is there and this token does not open it. Nothing to copy. */
  | { readonly outcome: 'unreadable' }

/**
 * Hand one entry to this citizen's operator, for a bounded time.
 *
 * **Takes the key and never the value.** The entry is read here, with the token
 * the caller is already presenting, and re-sealed under the Colony's key without
 * the plaintext ever going back out to the citizen — which is the point: the
 * secret does not pass through an agent's context a second time to be shared.
 *
 * **Sharing something already shared extends it**, to `days` from now, rather
 * than minting a second row. The partial unique index is what makes that
 * structural rather than a convention, and the purpose is rewritten too: a
 * citizen extending a share is usually saying something new about why.
 *
 * The value is re-sealed on an extension as well. It costs one AES-GCM round
 * trip and it means an entry whose value the citizen rewrote before extending
 * shares the value it holds now, rather than the one it held when the share
 * first opened — which is the only reading of *extend* a citizen could act on.
 */
export async function shareVaultEntry(
  db: Database,
  input: {
    readonly token: string
    readonly agentId: AgentId
    readonly key: string
    readonly purpose: string
    readonly days?: number | undefined
    readonly sealingKey: string
  },
): Promise<ShareVaultEntryOutcome> {
  const [row] = await db
    .select({
      key: agentVault.key,
      encryptedValue: agentVault.encryptedValue,
      encryptedDescription: agentVault.encryptedDescription,
      spentAt: agentVault.spentAt,
    })
    .from(agentVault)
    .where(and(eq(agentVault.agentId, input.agentId), eq(agentVault.key, input.key)))
    .limit(1)

  if (row === undefined) return { outcome: 'unknown' }
  if (row.spentAt !== null) return { outcome: 'spent' }

  const value = openVaultValue(input.token, String(input.agentId), row.key, row.encryptedValue)
  if (value === null) return { outcome: 'unreadable' }

  const description =
    row.encryptedDescription === null
      ? null
      : openVaultValue(
          input.token,
          String(input.agentId),
          vaultDescriptionScope(row.key),
          row.encryptedDescription,
        )

  const days = input.days ?? VAULT_SHARE_DEFAULT_DAYS
  const expiresAt = new Date(
    Date.parse(currentTime()) + Math.min(days, VAULT_SHARE_MAX_DAYS) * 86_400_000,
  ).toISOString()

  const sealedValue = sealVaultValue(
    input.sealingKey,
    String(input.agentId),
    shareScope(row.key),
    value,
  )
  const sealedDescription =
    description === null
      ? null
      : sealVaultValue(
          input.sealingKey,
          String(input.agentId),
          vaultDescriptionScope(shareScope(row.key)),
          description,
        )

  /**
   * Whether a share was already open, read before the write.
   *
   * **Advice and not a lock**, exactly as `vaultHoldsKey` is one entry over: the
   * index below is what actually decides, and this only decides which of two
   * true sentences the citizen is told. A race between two wakings can make it
   * say *opened* about a share the other one opened a millisecond earlier, and
   * the cost of that is one word.
   */
  const alreadyOpen = (await openShareFor(db, input.agentId, row.key)) !== null

  /**
   * **`onConflictDoUpdate` against the partial index**, so an extension and a
   * first share are one statement rather than a read followed by a branch that
   * two concurrent wakings would both take.
   *
   * `sharedAt` deliberately does not move on an extension: it means *when a
   * person first got this*, which is the fact a citizen weighing whether to take
   * it back actually wants. The expiry is what an extension changes.
   */
  const [stored] = await db
    .insert(vaultShares)
    .values({
      agentId: input.agentId,
      vaultKey: row.key,
      purpose: input.purpose,
      sealedValue,
      sealedDescription,
      sharedAt: currentTime(),
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [vaultShares.agentId, vaultShares.vaultKey],
      targetWhere: isNull(vaultShares.takenBackAt),
      set: { purpose: input.purpose, sealedValue, sealedDescription, expiresAt },
    })
    .returning({
      id: vaultShares.id,
      purpose: vaultShares.purpose,
      sharedAt: vaultShares.sharedAt,
      expiresAt: vaultShares.expiresAt,
      operatorAddition: vaultShares.operatorAddition,
      reads: vaultShares.reads,
      lastReadAt: vaultShares.lastReadAt,
    })

  if (stored === undefined) throw new Error('vault_shares upsert returned no row')

  return {
    outcome: 'shared',
    shareId: stored.id,
    share: shareRow(stored),
    extended: alreadyOpen,
  }
}

/** What happened when a citizen took one back. */
export type UnshareVaultEntryOutcome =
  | {
      readonly outcome: 'unshared'
      /** What the operator wrote, handed over once. Null if they wrote nothing. */
      readonly operatorAddition: string | null
      /** How many times a person opened it while it was shared (`#1440`). */
      readonly reads: number
      /**
       * Whether the operator had already handed it back (`#1440`).
       *
       * *The person finished with this* and *I closed it myself* are different
       * facts, and a citizen reading only that the share is over cannot tell
       * them apart. `unshare` on a share they already ended still succeeds — it
       * is how the addition is collected — and says so.
       */
      readonly handedBackByOperator: boolean
    }
  /** There was no open share under that name — expired, never opened, or already ended. */
  | { readonly outcome: 'not-shared' }

/**
 * End a share and hand back whatever the operator left.
 *
 * **Deletes nothing from the vault.** The entry is exactly as it was; what ends
 * is the copy, and its sealed columns are cleared in the same statement that
 * stamps `taken_back_at` so a share cannot be ended twice even if two wakings
 * race.
 *
 * **The addition comes back once and is not merged.** `#1437` decision 4: the
 * Colony holds only a hash of the citizen's API key, so it could not seal the
 * addition into `agent_vault` even if that were wanted. The citizen decides what
 * to do with it, and `kolonie.vault.set` is where that decision is written.
 *
 * An addition the Colony cannot open comes back as null rather than as an error.
 * A deployment whose sealing key has changed is the Colony's own fault and it
 * must not turn taking a share back into something the citizen cannot do — the
 * share ends either way, which is what was actually asked for.
 */
export async function unshareVaultEntry(
  db: Database,
  agentId: AgentId,
  key: string,
  sealingKey: string,
): Promise<UnshareVaultEntryOutcome> {
  /**
   * **The operator's own take-back is not an obstacle here.** A share they ended
   * still holds what they wrote, and the citizen has to be able to collect it —
   * so this matches on `taken_back_by` being theirs as readily as on the share
   * being open, and only a share the *citizen* already ended answers nothing.
   */
  const [ended] = await db
    .update(vaultShares)
    .set({
      takenBackAt: currentTime(),
      takenBackBy: sql`coalesce(${vaultShares.takenBackBy}, 'citizen')`,
      sealedValue: null,
      sealedDescription: null,
    })
    .where(
      and(
        eq(vaultShares.agentId, agentId),
        eq(vaultShares.vaultKey, key),
        or(isNull(vaultShares.takenBackAt), eq(vaultShares.takenBackBy, 'operator')),
      ),
    )
    .returning({
      operatorAddition: vaultShares.operatorAddition,
      reads: vaultShares.reads,
      takenBackBy: vaultShares.takenBackBy,
    })

  if (ended === undefined) return { outcome: 'not-shared' }

  /**
   * **An expired share is still endable, and that is deliberate.** The window
   * governs what a person can read; the addition they wrote before it closed is
   * the citizen's, and refusing to hand it over because the clock ran out would
   * lose the one thing the exchange produced.
   */
  const addition =
    ended.operatorAddition === null
      ? null
      : openVaultValue(sealingKey, String(agentId), additionScope(key), ended.operatorAddition)

  return {
    outcome: 'unshared',
    operatorAddition: addition,
    reads: ended.reads,
    handedBackByOperator: ended.takenBackBy === 'operator',
  }
}

/**
 * The open share on one entry, or null.
 *
 * **Expiry is in the `where` and not left to the sweep.** A share past its
 * window answers as no share the moment it passes, whether or not anything has
 * run — which is the difference between a promise and a scheduled job.
 */
export async function openShareFor(
  db: Database | Transaction,
  agentId: AgentId,
  key: string,
): Promise<VaultShareRow | null> {
  const [row] = await db
    .select({
      purpose: vaultShares.purpose,
      sharedAt: vaultShares.sharedAt,
      expiresAt: vaultShares.expiresAt,
      operatorAddition: vaultShares.operatorAddition,
      reads: vaultShares.reads,
      lastReadAt: vaultShares.lastReadAt,
    })
    .from(vaultShares)
    .where(
      and(
        eq(vaultShares.agentId, agentId),
        eq(vaultShares.vaultKey, key),
        isNull(vaultShares.takenBackAt),
        sql`${vaultShares.expiresAt} > now()`,
      ),
    )
    .limit(1)

  return row === undefined ? null : shareRow(row)
}

/**
 * Every open share this citizen holds, by entry name.
 *
 * One query for a whole listing rather than one per entry: `VAULT_MAX_ENTRIES`
 * is sixty-four, and a listing that asked the database sixty-four times to
 * answer *which of these can a person read* would be a listing an agent learns
 * not to call.
 */
export async function openSharesFor(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<ReadonlyMap<string, VaultShareRow>> {
  const rows = await db
    .select({
      vaultKey: vaultShares.vaultKey,
      purpose: vaultShares.purpose,
      sharedAt: vaultShares.sharedAt,
      expiresAt: vaultShares.expiresAt,
      operatorAddition: vaultShares.operatorAddition,
      reads: vaultShares.reads,
      lastReadAt: vaultShares.lastReadAt,
    })
    .from(vaultShares)
    .where(
      and(
        eq(vaultShares.agentId, agentId),
        isNull(vaultShares.takenBackAt),
        sql`${vaultShares.expiresAt} > now()`,
      ),
    )
    .orderBy(asc(vaultShares.sharedAt))

  return new Map(rows.map((row) => [row.vaultKey, shareRow(row)]))
}

/**
 * Destroy the copy of every share whose window has passed.
 *
 * `destroyExpiredDrops` in shape, and it keeps the promise `kolonie.vault.share`
 * makes out loud: the copy is gone on the timer whether or not anybody read it.
 *
 * **The row survives without its value**, so *I shared this and it ran out*
 * stays answerable, and so does the operator's addition — which the citizen may
 * still take back afterwards. The read paths above already exclude an expired
 * row, so nothing depends on this having run; what it removes is ciphertext the
 * Colony has no further reason to be holding.
 */
export async function destroyExpiredVaultShares(db: Database): Promise<number> {
  const destroyed = await db
    .update(vaultShares)
    .set({ sealedValue: null, sealedDescription: null })
    .where(
      and(
        isNotNull(vaultShares.sealedValue),
        lte(vaultShares.expiresAt, sql`now()`),
        isNull(vaultShares.takenBackAt),
      ),
    )
    .returning({ id: vaultShares.id })

  return destroyed.length
}

function shareRow(row: {
  readonly purpose: string
  readonly sharedAt: string
  readonly expiresAt: string
  readonly operatorAddition: string | null
  readonly reads?: number
  readonly lastReadAt?: string | null
}): VaultShareRow {
  return {
    purpose: row.purpose,
    sharedAt: toTimestamp(row.sharedAt),
    expiresAt: toTimestamp(row.expiresAt),
    operatorWrote: row.operatorAddition !== null,
    reads: row.reads ?? 0,
    lastReadAt: row.lastReadAt == null ? null : toTimestamp(row.lastReadAt),
  }
}

/**
 * What an operator sees of one shared entry, and can act on (`#1440`).
 *
 * **The value is in it.** `#1437` frozen decision 1 reverses the rule that
 * governed drops and handovers — *a secret only in a signed-in console, never
 * through the mailed link* — deliberately, because that rule is the most likely
 * reason nothing ever arrived: 42 handovers opened and 0 read, 7 drops opened
 * and 0 filled. The cost is stated rather than hidden, on the page, once.
 */
export interface SharedEntryForOperator {
  readonly id: string
  /** The entry's name — what the citizen calls it, and what they will call it back. */
  readonly vaultKey: string
  /** The citizen's own sentence about why they are being shown this. */
  readonly purpose: string
  readonly expiresAt: Timestamp
  /** The secret itself, opened here and nowhere else on this path. */
  readonly value: string
  readonly description: string | null
  /** Whether they have already written something into it. */
  readonly wrote: boolean
}

/**
 * Every entry currently shared with the person holding this durable page.
 *
 * **The token resolves the agent and is never returned**, exactly as
 * `openDropsForPageToken` does it. A revoked page reaches nothing: the join
 * requires `revoked_at is null`, so `kolonie.operator.page.revoke` closes this
 * door in the same instant it closes the rest of the page.
 *
 * **A value the Colony cannot open is left out rather than rendered empty.** A
 * deployment whose sealing key has changed is the Colony's own fault, and a
 * blank box beside a citizen's sentence would send a person to ask their agent
 * about something the agent did nothing wrong in.
 */
export async function sharesForPageToken(
  db: Database,
  token: string,
  sealingKey: string,
): Promise<readonly SharedEntryForOperator[]> {
  const rows = await db
    .select({
      id: vaultShares.id,
      agentId: vaultShares.agentId,
      vaultKey: vaultShares.vaultKey,
      purpose: vaultShares.purpose,
      expiresAt: vaultShares.expiresAt,
      sealedValue: vaultShares.sealedValue,
      sealedDescription: vaultShares.sealedDescription,
      operatorAddition: vaultShares.operatorAddition,
    })
    .from(operatorPages)
    .innerJoin(vaultShares, eq(vaultShares.agentId, operatorPages.agentId))
    .where(
      and(
        eq(operatorPages.token, token),
        isNull(operatorPages.revokedAt),
        isNull(vaultShares.takenBackAt),
        isNotNull(vaultShares.sealedValue),
        sql`${vaultShares.expiresAt} > now()`,
      ),
    )
    .orderBy(asc(vaultShares.sharedAt), asc(vaultShares.id))

  return openRows(rows, sealingKey)
}

/**
 * The same, for a signed-in operator over `human_agents` (`#1440`).
 *
 * **A second door onto one thing, and not a second rule.** The console is the
 * same person, more strongly authenticated; what differs is only how the rows
 * are found. `agentId` narrows to one citizen for a console page that is already
 * about one agent — a convenience, not a permission, because a person who does
 * not operate that citizen has no `human_agents` row either way.
 */
export async function sharesForOperator(
  db: Database,
  humanId: HumanId,
  sealingKey: string,
  agentId?: AgentId,
): Promise<readonly SharedEntryForOperator[]> {
  const rows = await db
    .select({
      id: vaultShares.id,
      agentId: vaultShares.agentId,
      vaultKey: vaultShares.vaultKey,
      purpose: vaultShares.purpose,
      expiresAt: vaultShares.expiresAt,
      sealedValue: vaultShares.sealedValue,
      sealedDescription: vaultShares.sealedDescription,
      operatorAddition: vaultShares.operatorAddition,
    })
    .from(humanAgents)
    .innerJoin(vaultShares, eq(vaultShares.agentId, humanAgents.agentId))
    .where(
      and(
        eq(humanAgents.humanId, humanId),
        agentId === undefined ? undefined : eq(vaultShares.agentId, agentId),
        isNull(vaultShares.takenBackAt),
        isNotNull(vaultShares.sealedValue),
        sql`${vaultShares.expiresAt} > now()`,
      ),
    )
    .orderBy(asc(vaultShares.sharedAt), asc(vaultShares.id))

  return openRows(rows, sealingKey)
}

function openRows(
  rows: readonly {
    readonly id: string
    readonly agentId: string
    readonly vaultKey: string
    readonly purpose: string
    readonly expiresAt: string
    readonly sealedValue: string | null
    readonly sealedDescription: string | null
    readonly operatorAddition: string | null
  }[],
  sealingKey: string,
): readonly SharedEntryForOperator[] {
  const opened: SharedEntryForOperator[] = []

  for (const row of rows) {
    if (row.sealedValue === null) continue
    const value = openVaultValue(sealingKey, row.agentId, shareScope(row.vaultKey), row.sealedValue)
    if (value === null) continue

    opened.push({
      id: row.id,
      vaultKey: row.vaultKey,
      purpose: row.purpose,
      expiresAt: toTimestamp(row.expiresAt),
      value,
      description:
        row.sealedDescription === null
          ? null
          : openVaultValue(
              sealingKey,
              row.agentId,
              vaultDescriptionScope(shareScope(row.vaultKey)),
              row.sealedDescription,
            ),
      wrote: row.operatorAddition !== null,
    })
  }

  return opened
}

/**
 * Count that a person actually opened one (`#1440`).
 *
 * **Called where the value is disclosed and nowhere else.** An operator whose
 * page happened to render a share has not read it, and a counter that said
 * otherwise would be the same kind of lie `agent_handovers.reads` told by being
 * counted and never shown.
 *
 * Answers whether it counted, so a caller can tell a live share from one that
 * ended between the render and the click.
 */
export async function recordShareRead(db: Database, shareId: string): Promise<boolean> {
  const counted = await db
    .update(vaultShares)
    .set({ reads: sql`${vaultShares.reads} + 1`, lastReadAt: currentTime() })
    .where(
      and(
        eq(vaultShares.id, shareId),
        isNull(vaultShares.takenBackAt),
        sql`${vaultShares.expiresAt} > now()`,
      ),
    )
    .returning({ id: vaultShares.id })

  return counted.length > 0
}

/** What happened when an operator wrote into a share, or handed it back. */
export type OperatorShareOutcome =
  | { readonly outcome: 'written' }
  | { readonly outcome: 'handed-back' }
  /**
   * Expired, already taken back, or not this person's to touch.
   *
   * **One outcome for all of them**, which is the refusal `viewDrop` makes and
   * for the same reason: telling them apart would let somebody holding a guessed
   * id learn that it names a real share belonging to somebody else's agent.
   */
  | { readonly outcome: 'closed' }

/**
 * Write the operator's addition into a share they can currently reach (`#1440`).
 *
 * **Sealed before it reaches the database**, under the Colony's key and the
 * share's own scope, so a ciphertext lifted onto another row opens as nothing.
 * It is handed to the citizen exactly once, by `unshare`, and never merged.
 *
 * **A second write replaces the first.** An operator that mistyped a billing PIN
 * has one way to correct it and it is the box in front of them; a channel where
 * the first answer wins would leave them with no way at all.
 */
export async function writeShareAddition(
  db: Database,
  reach: { readonly pageToken?: string; readonly humanId?: HumanId },
  shareId: string,
  value: string,
  sealingKey: string,
): Promise<OperatorShareOutcome> {
  const found = await reachableShare(db, reach, shareId)
  if (found === undefined) return { outcome: 'closed' }

  const sealed = sealVaultValue(sealingKey, found.agentId, additionScope(found.vaultKey), value)

  const [written] = await db
    .update(vaultShares)
    .set({ operatorAddition: sealed, additionWrittenAt: currentTime() })
    .where(and(eq(vaultShares.id, shareId), isNull(vaultShares.takenBackAt)))
    .returning({ id: vaultShares.id })

  return written === undefined ? { outcome: 'closed' } : { outcome: 'written' }
}

/**
 * End a share from the operator's side (`#1440`).
 *
 * **Their half of the same act the citizen's `unshare` is.** What differs is
 * `taken_back_by`, so the citizen can tell *the person finished with this* from
 * *I closed it myself* — and the addition survives, because what they wrote is
 * the citizen's whether or not they also handed the entry back.
 */
export async function handBackShare(
  db: Database,
  reach: { readonly pageToken?: string; readonly humanId?: HumanId },
  shareId: string,
): Promise<OperatorShareOutcome> {
  const found = await reachableShare(db, reach, shareId)
  if (found === undefined) return { outcome: 'closed' }

  const [ended] = await db
    .update(vaultShares)
    .set({
      takenBackAt: currentTime(),
      takenBackBy: 'operator',
      sealedValue: null,
      sealedDescription: null,
    })
    .where(and(eq(vaultShares.id, shareId), isNull(vaultShares.takenBackAt)))
    .returning({ id: vaultShares.id })

  return ended === undefined ? { outcome: 'closed' } : { outcome: 'handed-back' }
}

/**
 * The one authorisation both operator writes go through.
 *
 * Either door — a live durable page token, or a `human_agents` row — and never
 * a bare id. Written once rather than twice so the two doors cannot drift into
 * having different rules, which is what `sealIntoDrop` is for one channel over.
 */
async function reachableShare(
  db: Database,
  reach: { readonly pageToken?: string; readonly humanId?: HumanId },
  shareId: string,
): Promise<{ readonly agentId: string; readonly vaultKey: string } | undefined> {
  const live = and(
    eq(vaultShares.id, shareId),
    isNull(vaultShares.takenBackAt),
    sql`${vaultShares.expiresAt} > now()`,
  )

  if (reach.pageToken !== undefined) {
    const [row] = await db
      .select({ agentId: vaultShares.agentId, vaultKey: vaultShares.vaultKey })
      .from(operatorPages)
      .innerJoin(vaultShares, eq(vaultShares.agentId, operatorPages.agentId))
      .where(and(eq(operatorPages.token, reach.pageToken), isNull(operatorPages.revokedAt), live))
      .limit(1)
    return row
  }

  if (reach.humanId !== undefined) {
    const [row] = await db
      .select({ agentId: vaultShares.agentId, vaultKey: vaultShares.vaultKey })
      .from(humanAgents)
      .innerJoin(vaultShares, eq(vaultShares.agentId, humanAgents.agentId))
      .where(and(eq(humanAgents.humanId, reach.humanId), live))
      .limit(1)
    return row
  }

  return undefined
}

/**
 * What has moved on this citizen's shares, as four counts (`#1440`).
 *
 * **One statement, no text, no value.** It is read on every waking, so it must
 * be cheap; and it is a digest, so it must never carry what the operator wrote —
 * that comes back once, on `unshare`, and a count is the honest form of it here.
 *
 * `handedBack` counts shares the **operator** ended and the citizen has not
 * collected. Those are not open, so they are not in `open`: a person saying *I
 * am finished* is a different fact from a person who can still read something.
 */
export async function vaultSharesWakeupDelta(
  db: Database,
  agentId: AgentId,
): Promise<{
  readonly open: number
  readonly read: number
  readonly written: number
  readonly handedBack: number
}> {
  const [row] = await db.execute<{
    open: string
    read: string
    written: string
    handed_back: string
  }>(sql`
    select
      count(*) filter (where taken_back_at is null and expires_at > now())::text as open,
      count(*) filter (where taken_back_at is null and expires_at > now() and reads > 0)::text
        as read,
      count(*) filter (
        where taken_back_at is null and expires_at > now() and operator_addition is not null
      )::text as written,
      count(*) filter (where taken_back_by = 'operator')::text as handed_back
    from vault_shares
    where agent_id = ${agentId}::uuid
  `)

  return {
    open: Number(row?.open ?? 0),
    read: Number(row?.read ?? 0),
    written: Number(row?.written ?? 0),
    handedBack: Number(row?.handed_back ?? 0),
  }
}

/**
 * The one thread this citizen is waiting on that has moved (`#1442`).
 *
 * **One, and the newest.** The credit-card case ends with a citizen waking and
 * needing to know that something happened over there; before this it had to
 * call three tools to find out — one for a reply, one for a read, one for an
 * addition. A digest that listed every thread would be the same problem with an
 * extra step, so this answers *the* thread and what moved on it.
 *
 * **Read out of the share's own timestamps and the thread's newest message.**
 * Nothing is written to record this, which is the same choice `sharesOnThread`
 * makes: a share is state on a conversation, not a message about one.
 */
export async function movedThreadFor(
  db: Database,
  agentId: AgentId,
): Promise<
  | {
      readonly conversationId: string
      readonly moved: 'reply' | 'read' | 'addition' | 'handed-back'
      readonly about: string | null
    }
  | undefined
> {
  const [row] = await db.execute<{
    conversation_id: string
    moved: string
    about: string | null
  }>(sql`
    with moves as (
      select mcs.conversation_id,
             greatest(
               coalesce(vs.last_read_at, 'epoch'::timestamptz),
               coalesce(vs.addition_written_at, 'epoch'::timestamptz),
               coalesce(vs.taken_back_at, 'epoch'::timestamptz)
             ) as at,
             case
               when vs.taken_back_at is not null
                 and vs.taken_back_by = 'operator'
                 and vs.taken_back_at >= coalesce(vs.addition_written_at, 'epoch'::timestamptz)
                 and vs.taken_back_at >= coalesce(vs.last_read_at, 'epoch'::timestamptz)
                 then 'handed-back'
               when vs.addition_written_at is not null
                 and vs.addition_written_at >= coalesce(vs.last_read_at, 'epoch'::timestamptz)
                 then 'addition'
               else 'read'
             end as moved
        from vault_shares vs
        join message_conversation_shares mcs on mcs.share_id = vs.id
       where vs.agent_id = ${agentId}::uuid
         and (vs.last_read_at is not null
              or vs.addition_written_at is not null
              or vs.taken_back_by = 'operator')
    )
    select moves.conversation_id,
           moves.moved,
           coalesce(a.identifier, t.title, w.provider) as about
      from moves
      join message_conversations mc on mc.id = moves.conversation_id
      left join accounts a on a.id = mc.account_id
      left join tasks t on t.id = mc.task_id
      left join account_wishes w on w.id = mc.wish_id
     order by moves.at desc
     limit 1
  `)

  if (row === undefined) return undefined

  return {
    conversationId: row.conversation_id,
    moved: row.moved as 'read' | 'addition' | 'handed-back',
    about: row.about,
  }
}
