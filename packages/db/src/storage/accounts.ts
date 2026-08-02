import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import {
  ACCOUNT_MAX_ENTRIES,
  type Account,
  type AccountCapability,
  type AccountKind,
  type AccountStatus,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { accountKindIsUnique, accounts } from '../schema/accounts.js'
import { submissions, verifications } from '../schema/index.js'
import { isUniqueViolation } from './errors.js'
import { toTimestamp } from './rows.js'

export { ACCOUNT_KINDS_ALLOWING_SHARING, accountKindIsUnique } from '../schema/accounts.js'

/**
 * A handle that reads and writes, whether or not a transaction is open.
 *
 * The register is written from inside the verdict's transaction and read from
 * ordinary routes, and the two must run the same statements — a second copy of
 * `accountByIdentifier` taking a `Transaction` is exactly the kind of near-twin
 * that drifts.
 */
type Handle = Database | Transaction

/**
 * Every account this citizen has recorded, most useful first.
 *
 * **The read the whole register exists for**: a citizen has had no way to see
 * what it holds. `kolonie.me` reports skills and a balance, and the instruments
 * behind them were invisible even to their owner.
 *
 * Ordered proved before declared, then preferred first, then oldest first. A
 * citizen scanning this on waking wants the things that work at the top, and the
 * ordering is stated here rather than left to the caller so that two surfaces
 * cannot present the same register differently.
 *
 * **Retired and lost rows are returned.** They are excluded from *offering*, not
 * from the citizen's own view of its own record — hiding them would be the
 * Colony deciding a citizen may not see what it wrote down.
 */
export async function listAccounts(
  db: Database,
  agentId: AgentId,
  kind?: AccountKind,
): Promise<readonly Account[]> {
  const rows = await db
    .select()
    .from(accounts)
    .where(
      kind === undefined
        ? eq(accounts.agentId, agentId)
        : and(eq(accounts.agentId, agentId), eq(accounts.kind, kind)),
    )
    .orderBy(
      desc(accounts.proved),
      desc(accounts.preferred),
      asc(accounts.kind),
      asc(accounts.createdAt),
    )

  return rows.map(toAccount)
}

/** What {@link declareAccount} did, or why it did nothing. */
export type AccountDeclaration =
  | { readonly outcome: 'declared'; readonly account: Account }
  /** The citizen already has this identifier under this kind. Answered with it. */
  | { readonly outcome: 'already_recorded'; readonly account: Account }
  /** Another citizen has *proved* it, and this kind names one citizen. */
  | { readonly outcome: 'identifier_taken' }
  | { readonly outcome: 'too_many'; readonly limit: number }

/**
 * Record an account the citizen holds, or says it holds.
 *
 * **Declaring never proves anything.** The row lands with `proved` false and no
 * capabilities, and no verifier will accept it — that is asserted per kind
 * rather than left as a convention. What it buys is the thing an agent actually
 * needs: the Bluesky account it created ten minutes ago is written down before
 * the session that created it ends.
 *
 * **The uniqueness check is a courtesy in front of the index**, the same shape
 * `addressBelongsToAnother` has in `email.ts`, and it is checked against
 * `accountKindIsUnique` so the two cannot disagree about which kinds identify.
 * A conflict is still caught below, because between checking and writing another
 * citizen may prove the same handle.
 */
export async function declareAccount(
  db: Database,
  agentId: AgentId,
  input: {
    readonly kind: AccountKind
    readonly identifier: string
    readonly note?: string | null
    readonly vaultKey?: string | null
  },
): Promise<AccountDeclaration> {
  const existing = await accountByIdentifier(db, agentId, input.kind, input.identifier)
  if (existing !== undefined) return { outcome: 'already_recorded', account: existing }

  if (accountKindIsUnique(input.kind) && (await heldByAnother(db, agentId, input))) {
    return { outcome: 'identifier_taken' }
  }

  const [{ held = 0 } = {}] = await db
    .select({ held: sql<number>`cast(count(*) as integer)` })
    .from(accounts)
    .where(eq(accounts.agentId, agentId))

  if (held >= ACCOUNT_MAX_ENTRIES) return { outcome: 'too_many', limit: ACCOUNT_MAX_ENTRIES }

  try {
    const [row] = await db
      .insert(accounts)
      .values({
        agentId,
        kind: input.kind,
        identifier: input.identifier,
        note: input.note ?? null,
        vaultKey: input.vaultKey ?? null,
      })
      .returning()

    if (row === undefined) throw new Error('accounts insert returned no row')

    return { outcome: 'declared', account: toAccount(row) }
  } catch (error) {
    if (isUniqueViolation(error)) return { outcome: 'identifier_taken' }
    throw error
  }
}

/**
 * Record that a verdict proved this account, and what it proved it can do.
 *
 * **The only path that writes `proved` or a capability**, and it takes no
 * caller-supplied capability list from outside `packages/db` for the reason
 * stated on the column: a citizen that could write these would be deciding
 * whether a badge is attemptable. There is a test asserting no route or tool
 * reaches this.
 *
 * Idempotent, and it *adds* capabilities rather than replacing them: a mailbox
 * that proved `receive` in July and `send` in August has proved both, and the
 * later verdict must not erase the earlier one's evidence.
 *
 * **It creates the row if the citizen never declared it.** The ordinary path is
 * that a citizen proves an account it never wrote down, so requiring a
 * declaration first would mean either a verdict that fails to record anything or
 * a rung that asks for bookkeeping before it will pay.
 */
export async function recordProvedAccount(
  db: Handle,
  agentId: AgentId,
  input: {
    readonly kind: AccountKind
    readonly identifier: string
    readonly capabilities: readonly AccountCapability[]
    readonly provedAt: string
    /** The task it arrived through, when a quest handed it over rather than the citizen. */
    readonly obtainedThroughTaskId?: string | null
  },
): Promise<Account> {
  const existing = await accountByIdentifier(db, agentId, input.kind, input.identifier)

  if (existing !== undefined) {
    const [updated] = await db
      .update(accounts)
      .set({
        proved: true,
        provedAt: existing.provedAt ?? input.provedAt,
        capabilities: [...new Set([...existing.capabilities, ...input.capabilities])],
        updatedAt: sql`now()`,
      })
      .where(eq(accounts.id, existing.id))
      .returning()

    if (updated === undefined) throw new Error('accounts update returned no row')
    return toAccount(updated)
  }

  const [row] = await db
    .insert(accounts)
    .values({
      agentId,
      kind: input.kind,
      identifier: input.identifier,
      proved: true,
      provedAt: input.provedAt,
      capabilities: [...input.capabilities],
      provenance: input.obtainedThroughTaskId == null ? 'self-acquired' : 'task',
      obtainedThroughTaskId: input.obtainedThroughTaskId ?? null,
    })
    .returning()

  if (row === undefined) throw new Error('accounts insert returned no row')
  return toAccount(row)
}

/**
 * Where a verdict's account identifier lives, and what passing it proves.
 *
 * **One table, read by the verdict path and mirrored by the backfill**, because
 * the alternative is two descriptions of the same mapping and the second one
 * rots quietly: a rung whose identifier moved would keep backfilling correctly
 * and stop recording anything new, or the reverse, and neither would fail a test
 * that exists today.
 *
 * The identifier lives on the *verdict* for five of the six, under the key that
 * verifier writes, and in the submission payload for `website` — whose verifier
 * records no metadata at all. That asymmetry is real and is the reason this map
 * names a source rather than assuming one.
 *
 * Keyed by the **skill granted** rather than by the task type, for the reason
 * `citizenForGithubAuthor` gives at length: a query keyed on a task type stops
 * working silently the moment a second task grants the same skill.
 */
export const ACCOUNT_FROM_SKILL: Readonly<
  Record<string, { kind: string; from: 'metadata' | 'payload'; key: string; proves: string[] }>
> = {
  mailbox: { kind: 'mailbox', from: 'metadata', key: 'address', proves: ['receive'] },
  github: { kind: 'github', from: 'metadata', key: 'author', proves: ['control'] },
  social: { kind: 'social', from: 'metadata', key: 'account', proves: ['publish'] },
  domain: { kind: 'domain', from: 'metadata', key: 'name', proves: ['control'] },
  website: { kind: 'website', from: 'payload', key: 'url', proves: ['control'] },
  wallet: { kind: 'wallet', from: 'metadata', key: 'address', proves: ['sign'] },
}

/**
 * The badges that prove a further capability on an account a citizen already
 * holds.
 *
 * Keyed by task type, and that is not an inconsistency with the map above: a
 * badge grants no skill, so there is no skill to key on. The one entry today is
 * the send half of the mailbox rung, which is exactly the pair the register was
 * built to be able to express — one account, two proved capabilities, where the
 * old model had a badge and no place to record what it certified.
 */
export const CAPABILITY_FROM_BADGE: Readonly<
  Record<string, { kind: string; from: 'metadata' | 'payload'; key: string; proves: string[] }>
> = {
  'email-send': { kind: 'mailbox', from: 'metadata', key: 'address', proves: ['send'] },
}

/**
 * Record what a passing verdict proved about an account, inside the verdict's
 * own transaction.
 *
 * **This is the only writer of `proved` outside the backfill**, and it takes
 * nothing from a caller: the identifier comes off the verdict the verifier
 * wrote, the capability comes from the map above, and the skill list comes from
 * the task row. A citizen cannot reach any of the three.
 *
 * **A verdict that names no identifier records nothing**, silently and on
 * purpose. Most rungs are not about an account at all — `profile-complete`,
 * `browser-*`, `compute` — and a missing key on those is the ordinary case
 * rather than a fault worth failing a payment over. The rungs that *are* about
 * an account all write their identifier already, and a test pins each one.
 *
 * It never throws into the booking. A register that failed to record something
 * must not cost a citizen the credits for work it actually did — the register is a
 * description of evidence, and the evidence is the verdict, which is committed
 * by the same transaction either way.
 */
export async function recordAccountsFromVerdict(
  tx: Transaction,
  command: {
    readonly agentId: AgentId
    readonly submissionId: string
    readonly taskType: string
    readonly skills: readonly string[]
    readonly provedAt: string
  },
): Promise<readonly Account[]> {
  const sources = [
    ...command.skills.flatMap((skill) => {
      const source = ACCOUNT_FROM_SKILL[skill]
      return source === undefined ? [] : [source]
    }),
    ...(CAPABILITY_FROM_BADGE[command.taskType] === undefined
      ? []
      : [CAPABILITY_FROM_BADGE[command.taskType]]),
  ].filter((source) => source !== undefined)

  if (sources.length === 0) return []

  const [row] = await tx
    .select({
      metadata: verifications.metadata,
      payload: submissions.payload,
    })
    .from(submissions)
    .leftJoin(verifications, eq(verifications.submissionId, submissions.id))
    .where(eq(submissions.id, command.submissionId))
    .limit(1)

  if (row === undefined) return []

  const recorded: Account[] = []

  for (const source of sources) {
    const bag = source.from === 'metadata' ? row.metadata : row.payload
    const identifier = readIdentifier(bag, source.key)
    if (identifier === undefined) continue

    recorded.push(
      await recordProvedAccount(tx, command.agentId, {
        kind: source.kind as AccountKind,
        identifier,
        capabilities: source.proves as unknown as readonly AccountCapability[],
        provedAt: command.provedAt,
      }),
    )
  }

  return recorded
}

/** A string under this key, or nothing. Anything else is not an identifier. */
function readIdentifier(bag: unknown, key: string): string | undefined {
  if (bag === null || typeof bag !== 'object') return undefined
  const value = (bag as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** What a write against one of the citizen's own accounts did. */
export type AccountEdit =
  | { readonly outcome: 'updated'; readonly account: Account }
  | { readonly outcome: 'not_found' }
  /** A preference was asked for on a mailbox, where the reach address decides. */
  | { readonly outcome: 'mail_has_no_preference' }

/**
 * Set the status of one of the caller's accounts.
 *
 * **Only the citizen writes this.** No Colony path sets `retired` or `lost`, and
 * a test asserts it: the Colony cannot tell a mailbox that went away from a
 * check that failed, and a register in which it guessed would be a register
 * nobody could trust about the one field that is a statement of fact by its
 * owner.
 */
export async function setAccountStatus(
  db: Database,
  agentId: AgentId,
  accountId: string,
  status: AccountStatus,
): Promise<AccountEdit> {
  return editOwn(db, agentId, accountId, { status })
}

/** The citizen's own reminder. Bounded by the check constraint, computed on by nothing. */
export async function setAccountNote(
  db: Database,
  agentId: AgentId,
  accountId: string,
  note: string | null,
): Promise<AccountEdit> {
  return editOwn(db, agentId, accountId, { note })
}

/**
 * Name the vault entry that opens this account, or clear it.
 *
 * The entry is not required to exist and a missing one is not an error — a
 * citizen may store the secret later, or elsewhere. This is a label pointing at
 * a label; nothing is decrypted and nothing is disclosed.
 */
export async function setAccountVaultKey(
  db: Database,
  agentId: AgentId,
  accountId: string,
  vaultKey: string | null,
): Promise<AccountEdit> {
  return editOwn(db, agentId, accountId, { vaultKey })
}

/**
 * Say which account of a kind should be offered first.
 *
 * **Refused for mail**, where the equivalent question is the reach address and
 * has an obligation behind it — `kolonie.mailboxes.promote` is that surface, and
 * D-047 is why there is only one of it. The refusal names the tool rather than
 * being a bare error, because an agent that meets this is trying to do something
 * the Colony supports elsewhere.
 *
 * One preference per kind, in one transaction: clear, then set. The partial
 * unique index permits exactly one, so setting before clearing would collide
 * with the row it is about to release — the same shape `promoteMailbox` uses.
 */
export async function setAccountPreference(
  db: Database,
  agentId: AgentId,
  accountId: string,
): Promise<AccountEdit> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.agentId, agentId)))
      .limit(1)

    if (target === undefined) return { outcome: 'not_found' }
    if (target.kind === 'mailbox') return { outcome: 'mail_has_no_preference' }

    await tx
      .update(accounts)
      .set({ preferred: false, updatedAt: sql`now()` })
      .where(
        and(
          eq(accounts.agentId, agentId),
          eq(accounts.kind, target.kind),
          eq(accounts.preferred, true),
        ),
      )

    const [updated] = await tx
      .update(accounts)
      .set({ preferred: true, updatedAt: sql`now()` })
      .where(eq(accounts.id, target.id))
      .returning()

    if (updated === undefined) throw new Error('accounts update returned no row')
    return { outcome: 'updated', account: toAccount(updated) }
  })
}

/**
 * Which account of a kind a verifier or a listing should use.
 *
 * **The preference decides, and where there is none the oldest proved account
 * does** — oldest rather than newest, because the account a citizen has held
 * longest is the one its history is attached to, and a citizen that wants
 * another one says so. Retired, lost and unproved accounts are never offered:
 * the first two because the citizen said so, the third because offering an
 * unproved account to a verifier is the one thing this must never do.
 */
export async function resolveAccount(
  db: Database,
  agentId: AgentId,
  kind: AccountKind,
): Promise<Account | undefined> {
  const [row] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.agentId, agentId),
        eq(accounts.kind, kind),
        eq(accounts.proved, true),
        eq(accounts.status, 'in-use'),
      ),
    )
    .orderBy(desc(accounts.preferred), asc(accounts.provedAt))
    .limit(1)

  return row === undefined ? undefined : toAccount(row)
}

/**
 * Every account a task handed out, for the day somebody has to ask.
 *
 * **A single query, which is the point of recording provenance at all.** The
 * quest arrangement that makes this necessary is accepted rather than designed
 * against (see `AccountProvenanceSchema`), and what keeps that decision
 * reversible is being able to find the population afterwards without
 * reconstructing it from verdicts.
 */
export async function accountsObtainedThrough(
  db: Database,
  taskId: string,
): Promise<readonly Account[]> {
  const rows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.obtainedThroughTaskId, taskId))
    .orderBy(asc(accounts.createdAt))

  return rows.map(toAccount)
}

/**
 * Record what a re-check found (`#152`).
 *
 * **Nothing is revoked either way.** A confirmation stamps the date and clears
 * any earlier failure; a failure stamps the date it happened and leaves the
 * proof, the skill and the reward exactly where they are. That asymmetry is the
 * whole model: an account is allowed to stop working, and the Colony's job is to
 * be able to say so rather than to take something away.
 */
export async function recordAccountRecheck(
  db: Handle,
  accountId: string,
  found: 'held' | 'gone',
  at: string,
): Promise<void> {
  await db
    .update(accounts)
    .set(
      found === 'held'
        ? { confirmedAt: at, unconfirmedSince: null, updatedAt: sql`now()` }
        : { unconfirmedSince: at, updatedAt: sql`now()` },
    )
    .where(and(eq(accounts.id, accountId), eq(accounts.proved, true)))
}

/**
 * The accounts a re-check could be run against, oldest evidence first (`#152`).
 *
 * **Proved, in use, and of a kind something can actually check.** Retired and
 * lost are excluded because the citizen said so, and asking anyway would be the
 * Colony overriding the one field it does not own. Unproved ones are excluded
 * because there is nothing to re-confirm.
 *
 * Ordered by how stale the evidence is — last confirmation, or the original
 * proof where there has been none — so the badge always asks about the account
 * the Colony knows least about. **Staleness is derived here, at read time**, and
 * no job anywhere walks citizens to keep a column current: a sweep over every
 * account of every citizen would touch third-party services on a schedule the
 * Colony has no reason to take on, and would fail for dormant citizens by
 * construction.
 */
export async function recheckableAccounts(
  db: Database,
  agentId: AgentId,
  kinds: readonly string[],
): Promise<readonly Account[]> {
  if (kinds.length === 0) return []

  const rows = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.agentId, agentId),
        eq(accounts.proved, true),
        eq(accounts.status, 'in-use'),
        inArray(accounts.kind, [...kinds]),
      ),
    )
    .orderBy(sql`coalesce(${accounts.confirmedAt}, ${accounts.provedAt}) asc`)

  return rows.map(toAccount)
}

/**
 * One account of the caller's, by id.
 *
 * Scoped to the caller in the same statement rather than read and then checked:
 * an id is a uuid somebody could hold, and *is this yours* belongs in the
 * `where` clause of every read that leads to a write.
 */
export async function accountOf(
  db: Database,
  agentId: AgentId,
  accountId: string,
): Promise<Account | undefined> {
  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.agentId, agentId)))
    .limit(1)

  return row === undefined ? undefined : toAccount(row)
}

async function editOwn(
  db: Database,
  agentId: AgentId,
  accountId: string,
  set: Partial<{ status: AccountStatus; note: string | null; vaultKey: string | null }>,
): Promise<AccountEdit> {
  const [row] = await db
    .update(accounts)
    .set({ ...set, updatedAt: sql`now()` })
    .where(and(eq(accounts.id, accountId), eq(accounts.agentId, agentId)))
    .returning()

  return row === undefined
    ? { outcome: 'not_found' }
    : { outcome: 'updated', account: toAccount(row) }
}

async function accountByIdentifier(
  db: Handle,
  agentId: AgentId,
  kind: AccountKind,
  identifier: string,
): Promise<Account | undefined> {
  const [row] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.agentId, agentId),
        eq(accounts.kind, kind),
        sql`lower(${accounts.identifier}) = lower(${identifier})`,
      ),
    )
    .limit(1)

  return row === undefined ? undefined : toAccount(row)
}

async function heldByAnother(
  db: Handle,
  agentId: AgentId,
  input: { readonly kind: AccountKind; readonly identifier: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.kind, input.kind),
        eq(accounts.proved, true),
        ne(accounts.agentId, agentId),
        sql`lower(${accounts.identifier}) = lower(${input.identifier})`,
      ),
    )
    .limit(1)

  return row !== undefined
}

function toAccount(row: typeof accounts.$inferSelect): Account {
  return {
    id: row.id,
    kind: row.kind as Account['kind'],
    identifier: row.identifier,
    proved: row.proved,
    capabilities: row.capabilities as Account['capabilities'],
    status: row.status,
    preferred: row.preferred,
    note: row.note,
    vaultKey: row.vaultKey,
    provenance: row.provenance,
    obtainedThroughTaskId: row.obtainedThroughTaskId,
    provedAt: row.provedAt === null ? null : toTimestamp(row.provedAt),
    confirmedAt: row.confirmedAt === null ? null : toTimestamp(row.confirmedAt),
    unconfirmedSince: row.unconfirmedSince === null ? null : toTimestamp(row.unconfirmedSince),
    createdAt: toTimestamp(row.createdAt),
  }
}
