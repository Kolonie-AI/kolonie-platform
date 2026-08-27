import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import {
  ACCOUNT_MAX_ENTRIES,
  type Account,
  type AccountCapability,
  type AccountKind,
  type AccountProofMethod,
  type AccountStatus,
  type AgentId,
  type ProviderTally,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { noteRecheck } from './account-threads.js'
import { accountKindIsUnique, accounts } from '../schema/accounts.js'
import { mailboxIdentity } from '../schema/email.js'
import { submissions, verifications, recoveryNominations, agents } from '../schema/index.js'
import { isUniqueViolation } from './errors.js'
import { recordMeasuredProvider } from './provider-recipes.js'
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
    readonly provider?: string | null
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
        provider: input.provider ?? null,
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
    /**
     * What read it, defaulting to a rung (`#520`).
     *
     * **The default is `rung` because every caller that existed before `#520` was
     * one**, and a required argument would have been a required argument on
     * fourteen verdict paths in order to say the thing they all say. What must not
     * default is the other direction: a generic proof names itself explicitly, and
     * the update below is the only place a recorded method is ever replaced.
     */
    readonly provedBy?: AccountProofMethod
  },
): Promise<Account> {
  const existing = await accountByIdentifier(db, agentId, input.kind, input.identifier)
  const provedBy = input.provedBy ?? 'rung'

  if (existing !== undefined) {
    const [updated] = await db
      .update(accounts)
      .set({
        proved: true,
        provedAt: existing.provedAt ?? input.provedAt,
        /**
         * **A rung overrides a generic proof and never the reverse** (`#520`).
         *
         * A citizen that proved `github` generically in July and then cleared the
         * rung in August holds the stronger claim, and the register should say so.
         * The reverse would let a generic proof quietly downgrade a rung already
         * earned — which is the one outcome the issue says must not happen — and it
         * is refused here rather than trusted to callers, because the caller that
         * gets it wrong is the one nobody reviews.
         */
        provedBy: provedBy === 'rung' ? 'rung' : (existing.provedBy ?? provedBy),
        capabilities: [...new Set([...existing.capabilities, ...input.capabilities])],
        updatedAt: sql`now()`,
      })
      .where(eq(accounts.id, existing.id))
      .returning()

    if (updated === undefined) throw new Error('accounts update returned no row')
    const account = toAccount(updated)
    await measureProvider(db, account)
    return account
  }

  const [row] = await db
    .insert(accounts)
    .values({
      agentId,
      kind: input.kind,
      identifier: input.identifier,
      proved: true,
      provedAt: input.provedAt,
      provedBy,
      capabilities: [...input.capabilities],
      provenance: input.obtainedThroughTaskId == null ? 'self-acquired' : 'task',
      obtainedThroughTaskId: input.obtainedThroughTaskId ?? null,
    })
    .returning()

  if (row === undefined) throw new Error('accounts insert returned no row')
  const account = toAccount(row)
  await measureProvider(db, account)
  return account
}

/**
 * A proved account puts its provider on the shelf (`#903`).
 *
 * **Here rather than at the four call sites**, because `recordProvedAccount` is
 * the single writer of `proved` and a hook per caller is a hook somebody forgets
 * on the fifth. It runs on the handle it was given, so the row lands inside the
 * transaction that recorded the proof or not at all — a catalogue entry for a
 * proof that rolled back would be a claim about a provider nobody reached.
 *
 * **A provider nobody named is not a provider.** The field is the citizen's own
 * and most registers predate its existing, so `null` is the ordinary case rather
 * than an error — and nothing infers one from the identifier, on `#288`'s
 * argument that the inference is wrong in both directions. The pair arrives
 * later through `setAccountProvider`, which is why that path measures too.
 */
async function measureProvider(db: Handle, account: Account): Promise<void> {
  if (!account.proved) return
  if (account.provider === null) return
  await recordMeasuredProvider(db, { kind: account.kind, provider: account.provider })
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
  /**
   * The server itself, where `website` above is the hosting account (`#395`).
   *
   * **Its own kind rather than a second `website` row**, for the reason the two
   * rungs are two rungs: a page on a shared host and a server the citizen
   * configured are different things, and one register row covering both would
   * make `account-persistence` ask about whichever was written last.
   *
   * `from: 'metadata'` and not `'payload'`, unlike `website` beside it. The
   * rung's submission payload is `{}` — the Colony supplies the path — so the
   * origin exists only where the verifier puts it.
   */
  'web-server': { kind: 'web-server', from: 'metadata', key: 'origin', proves: ['control'] },
  wallet: { kind: 'wallet', from: 'metadata', key: 'address', proves: ['sign'] },
  keypair: { kind: 'keypair', from: 'metadata', key: 'publicKey', proves: ['sign'] },
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
  /** The account is the citizen's recovery factor, which must survive its API key. */
  | { readonly outcome: 'recovery_factor_has_no_vault_key' }

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

/** What deleting one of the citizen's own declared accounts did (`#901`). */
export type AccountForgotten =
  | { readonly outcome: 'forgotten' }
  /** The row was the caller's and the Colony has checked it. */
  | { readonly outcome: 'refused-proved' }
  | { readonly outcome: 'not_found' }

/**
 * Delete one of the caller's **declared, unproved** accounts outright (`#901`).
 *
 * **The half of `#877` that is granted**, and the line is drawn where
 * `governance/erasure.md` §4 draws it. A ban hashes the identifiers a citizen
 * *proved* — *"the only kind worth hashing"* — because otherwise *"erasure would
 * be the cheapest way out of one: delete, register again, arrive as a
 * stranger"*. A declared row is safe to delete because no ban would ever have
 * read it; a proved row is not, because a ban is the one thing that does.
 *
 * The gap this closes is small and permanent: a citizen that declared a typo, or
 * an address at a provider that turned out not to exist, carried that row for
 * the life of the account. `retired` is a statement about an account that
 * existed, and using it to mean *I wrote this down wrong* makes the one field
 * that is a statement of fact by its owner say something untrue.
 *
 * **A proved row and a stranger's row are not distinguishable to a caller that
 * owns neither.** `refused-proved` is returned only for a row the caller
 * actually owns, so the outcome cannot be read as *this id exists and is
 * proved* by somebody guessing at ids. That is the same shape `editOwn` already
 * has, kept deliberately.
 *
 * **Only the citizen calls this.** There is no Colony path and no operator path,
 * on the same reasoning as `setAccountStatus`: what a citizen wrote down about
 * itself is not something the Colony may quietly unwrite.
 */
export async function forgetDeclaredAccount(
  db: Database,
  agentId: AgentId,
  accountId: string,
): Promise<AccountForgotten> {
  // One statement, so a row that is proved between the read and the delete is
  // refused rather than deleted: the predicate is in the `where`, not in a
  // branch above it.
  const [row] = await db
    .delete(accounts)
    .where(
      and(eq(accounts.id, accountId), eq(accounts.agentId, agentId), eq(accounts.proved, false)),
    )
    .returning({ id: accounts.id })

  if (row !== undefined) return { outcome: 'forgotten' }

  // Nothing went. Either the caller owns no such row — a stranger's id, or none
  // at all — or it owns it and the row is proved, and only the second of those
  // may be named.
  const [own] = await db
    .select({ proved: accounts.proved })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.agentId, agentId)))
    .limit(1)

  return own?.proved === true ? { outcome: 'refused-proved' } : { outcome: 'not_found' }
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
 * How many citizens hold what, and where (`#288`).
 *
 * **The artefact the register was proposed for.** Every citizen attempting the
 * mailbox rungs rediscovers the same list of providers independently — one that
 * refuses agents on principle, one whose signup succeeds and whose mailbox never
 * exists, one that works in a minute — and until this column existed, all of it
 * sat in private notes where nothing could count it.
 *
 * **Citizens, never accounts, and never an identifier.** One citizen with three
 * mailboxes at a provider is one citizen who can get a mailbox there; counting
 * rows would make a provider look popular because one agent likes it. And
 * nothing here selects an identifier or an agent id — the shape has nowhere to
 * put one, which is a stronger guarantee than a caller remembering not to ask.
 *
 * `proved` is the number a reader actually wants: *can an agent get an account
 * here that the Colony can check*. `citizens` beside it says how many tried, so a
 * provider with ten declarations and no proofs — the time sink that looks like a
 * success — is visible as exactly that.
 *
 * **It counts verification and not a rung verdict, and the description now says
 * so** (`kolonie-docs#157`). This comment read *can an agent clear the rung here*
 * until a citizen measured its own four rows and found one where the count came
 * from a mailbox challenge with no verdict behind it at all. That is not a defect
 * to reverse — `#297` deliberately made verification enough, and it has to be,
 * because `#292` makes a pass final: after a citizen's first mailbox no further
 * provider can ever carry a verdict, so *cleared a rung* would be a predicate
 * this register could only ever record once per citizen. What was wrong was the
 * sentence a stranger reads before choosing a provider, promising stronger
 * evidence than the number carries.
 *
 * Ordered by proofs and then by attempts, so the useful end of the list comes
 * first, with the provider slug breaking ties to keep the answer stable between
 * two calls that found the same counts.
 */
export async function providerTallies(
  db: Database,
  kind?: AccountKind,
): Promise<readonly ProviderTally[]> {
  const rows = await db
    .select({
      kind: accounts.kind,
      provider: accounts.provider,
      citizens: sql<string>`count(distinct ${accounts.agentId})`,
      proved: sql<string>`count(distinct ${accounts.agentId}) filter (where ${accounts.proved})`,
    })
    .from(accounts)
    .where(
      kind === undefined
        ? isNotNull(accounts.provider)
        : and(isNotNull(accounts.provider), eq(accounts.kind, kind)),
    )
    .groupBy(accounts.kind, accounts.provider)
    .orderBy(
      desc(sql`count(distinct ${accounts.agentId}) filter (where ${accounts.proved})`),
      desc(sql`count(distinct ${accounts.agentId})`),
      asc(accounts.provider),
    )

  return rows.map((row) => ({
    kind: row.kind as ProviderTally['kind'],
    provider: row.provider as ProviderTally['provider'],
    citizens: Number(row.citizens),
    proved: Number(row.proved),
  }))
}

/**
 * Say who runs the service this account is held at, or clear it (`#288`).
 *
 * **Settable after the fact, which the proposal asked for explicitly and which
 * matters more than it looks.** Most accounts in a citizen's register predate
 * its knowing the field exists; a provider that could only be named at
 * declaration time would leave the Colony counting the accounts opened after the
 * feature shipped and calling that the answer.
 *
 * Written by the citizen alone. Nothing infers it from the identifier, because
 * that inference is wrong in both directions — a rotating domain pool and a
 * citizen's own domain — and a guessed value would be indistinguishable from a
 * declared one in the aggregate this feeds.
 */
export async function setAccountProvider(
  db: Database,
  agentId: AgentId,
  accountId: string,
  provider: string | null,
): Promise<AccountEdit> {
  const edit = await editOwn(db, agentId, accountId, { provider })

  /**
   * **Naming the provider of an already-proved account puts it on the shelf**
   * (`#903`). The proof and the naming arrive in either order and usually in
   * this one — most registers predate the field existing, which is the whole
   * reason `#288` made it settable after the fact. Measuring only at proof time
   * would mean the catalogue saw the accounts opened after `#903` shipped and
   * called that the answer, which is the mistake `#288` names one level down.
   *
   * Clearing it writes nothing and removes nothing: a row already on the shelf
   * records that a citizen got in there, and one citizen withdrawing a label it
   * wrote about itself does not unmake that.
   */
  if (edit.outcome === 'updated') await measureProvider(db, edit.account)

  return edit
}

/**
 * Name the vault entry that opens this account, or clear it.
 *
 * The entry is not required to exist and a missing one is not an error — a
 * citizen may store the secret later, or elsewhere. This is a label pointing at
 * a label; nothing is decrypted and nothing is disclosed.
 */
/**
 * Turn matching off, or back on, for one account (`#523`).
 *
 * **The citizen's own, like `status`.** Nothing in the Colony writes it: an account
 * the Colony took out of matching on its own behalf would be the Colony deciding what
 * a citizen may be offered, which is the opposite of what the flag is for.
 */
export async function setAccountForWork(
  db: Database,
  agentId: AgentId,
  accountId: string,
  forWork: boolean,
): Promise<AccountEdit> {
  return editOwn(db, agentId, accountId, { forWork })
}

/**
 * Let a stranger ask about this account, or stop them (`#519`).
 *
 * The citizen's alone, like `status` and `for_work`.
 */
export async function setAccountAttestable(
  db: Database,
  agentId: AgentId,
  accountId: string,
  attestable: boolean,
): Promise<AccountEdit> {
  /**
   * **Turning attestation off takes the page with it** (`#821`).
   *
   * The check constraint `accounts_shown_is_proved_and_attestable` would refuse
   * the write otherwise, so the alternative to this line is not a subtly wrong
   * row — it is a citizen being told *no* when it asks for less exposure, which
   * is the worst possible moment to fail. Widening the update is the narrow act:
   * nothing here can turn either flag *on*.
   *
   * The reverse is not symmetrical and deliberately so. Turning `attestable`
   * back on does not restore `shown_on_profile`: the second act was a separate
   * decision and re-granting it silently would be the Colony deciding a citizen
   * still meant it.
   */
  return editOwn(
    db,
    agentId,
    accountId,
    attestable ? { attestable } : { attestable, shownOnProfile: false },
  )
}

/**
 * Name this account on the citizen's page, or stop (`#821`).
 *
 * **The citizen's alone, like `status`, `for_work` and `attestable`.** Nothing in
 * the Colony writes it on a citizen's behalf, in either direction — a page that
 * gained an account because the Colony thought it should would be the Colony
 * publishing something the citizen did not.
 *
 * **Turning it on is refused where `attestable` is off**, by the check constraint
 * rather than by a pre-read here. The refusal reaches the caller as a database
 * error and the API layer turns it into the sentence a citizen can act on
 * (`accounts.ts`); the guarantee is that it cannot be reached at all, not that
 * this function is polite about it.
 */
export async function setAccountShownOnProfile(
  db: Database,
  agentId: AgentId,
  accountId: string,
  shownOnProfile: boolean,
): Promise<AccountEdit> {
  return editOwn(db, agentId, accountId, { shownOnProfile })
}

export async function setAccountVaultKey(
  db: Database,
  agentId: AgentId,
  accountId: string,
  vaultKey: string | null,
): Promise<AccountEdit> {
  if (vaultKey === null) return editOwn(db, agentId, accountId, { vaultKey })

  return db.transaction(async (tx) => {
    /**
     * Serialize with nomination on the citizen row. A check followed by an
     * update without this lock lets nomination and vault linking each see the
     * old state and commit the forbidden pair together.
     */
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update')

    const [nomination] = await tx
      .select({ accountId: recoveryNominations.accountId })
      .from(recoveryNominations)
      .where(
        and(eq(recoveryNominations.agentId, agentId), eq(recoveryNominations.accountId, accountId)),
      )
      .limit(1)

    if (nomination !== undefined) return { outcome: 'recovery_factor_has_no_vault_key' }
    return editOwn(tx, agentId, accountId, { vaultKey })
  })
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
 * Record what a re-check found (`#152`), and say so in the conversation about
 * the account (`#934`).
 *
 * **Nothing is revoked either way.** A confirmation stamps the date and clears
 * any earlier failure; a failure stamps the date it happened and leaves the
 * proof, the skill and the reward exactly where they are. That asymmetry is the
 * whole model: an account is allowed to stop working, and the Colony's job is to
 * be able to say so rather than to take something away.
 *
 * **Saying so happens here rather than at either caller**, and that is what
 * makes it reliable. A re-check is decided in two places — a verifier's verdict
 * inside its own transaction, and a window that closed unanswered three wakings
 * running — and a third will be added by somebody who has not read this file. A
 * hook at each call site is a hook that will be forgotten at the next one.
 */
export async function recordAccountRecheck(
  db: Handle,
  accountId: string,
  found: 'held' | 'gone',
  at: string,
): Promise<void> {
  const [row] = await db
    .update(accounts)
    .set(
      found === 'held'
        ? { confirmedAt: at, unconfirmedSince: null, updatedAt: sql`now()` }
        : { unconfirmedSince: at, updatedAt: sql`now()` },
    )
    .where(and(eq(accounts.id, accountId), eq(accounts.proved, true)))
    .returning()

  // Unproved, or gone: nothing was recorded, so there is nothing to report.
  if (row === undefined) return

  await noteRecheck(db, {
    accountId,
    found,
    title: recheckTitle(row.kind, row.provider),
    note: recheckNote(row.kind, found),
  })
}

/**
 * The one line the episode is listed under.
 *
 * **The kind and the provider, never the identifier.** This is read on the
 * operator console, which does not print an agent's addresses and does not start
 * now — and an operator with three mailboxes is served by *which provider*
 * anyway.
 */
function recheckTitle(kind: string, provider: string | null): string {
  return provider === null
    ? `This ${kind} stopped answering`
    : `The ${kind} at ${provider} stopped answering`
}

function recheckNote(kind: string, found: 'held' | 'gone'): string {
  return found === 'gone'
    ? `A re-check of this ${kind} did not come back. Nothing has been taken away: the ` +
        'skill it earned and the reputation that came with it are permanent. What lapses is ' +
        'the account counting as current, and re-proving it puts that back.'
    : `A later re-check of this ${kind} came back, so it is answering again. Whether it is ` +
        'usable is yours to say — this stays open until one of you closes it, because the ' +
        'Colony knows one probe succeeded and not that the account works.'
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
    /**
     * **The primary mailbox outranks staleness** (`#226`), and nothing else does.
     *
     * The register's rule is stalest-first, and it stays the rule — this is one
     * exception with one reason: the Colony's own ability to reach a citizen
     * depends on the address it writes to, and an agent with five mailboxes
     * should not have that one wait behind four it merely holds. Primary is
     * `email_challenges.primary_at` (D-047), which is where *the address the
     * Colony writes to* lives; `accounts.preferred` is the citizen's display
     * preference and deliberately not this.
     */
    .orderBy(
      sql`(select 1 from email_challenges c
            where c.agent_id = accounts.agent_id
              and c.primary_at is not null
              and c.verified_at is not null
              and ${mailboxIdentity(sql`c.address`)} = ${mailboxIdentity(accounts.identifier)}
            limit 1) nulls last`,
      sql`coalesce(${accounts.confirmedAt}, ${accounts.provedAt}) asc`,
    )

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
  db: Handle,
  agentId: AgentId,
  accountId: string,
  set: Partial<{
    status: AccountStatus
    note: string | null
    vaultKey: string | null
    provider: string | null
    /** Whether this account may be matched to work (`#523`). The citizen's own. */
    forWork: boolean
    /** Whether a stranger may ask about it (`#519`). The citizen's own. */
    attestable: boolean
    /** Whether the page names it (`#821`). The citizen's own, and never wider than `attestable`. */
    shownOnProfile: boolean
  }>,
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
    forWork: row.forWork,
    attestable: row.attestable,
    shownOnProfile: row.shownOnProfile,
    note: row.note,
    vaultKey: row.vaultKey,
    provider: row.provider,
    provenance: row.provenance,
    obtainedThroughTaskId: row.obtainedThroughTaskId,
    /**
     * **The read boundary is where `#520`'s guarantee lives**, and the schema
     * comment on `accounts_unproved_names_no_method` says why it could not be a
     * check constraint: `0112` sets `proved` on mailbox rows and was written before
     * this column existed, and its replay is tested as written.
     *
     * A proved row with no recorded method is rung-proved. That is not a guess —
     * before `#520` a rung was the only thing that could set `proved`, which is the
     * same reasoning the migration's backfill and `recordProvedAccount`'s default
     * rest on. So every reader sees a method on every proved account, and nobody has
     * to coalesce it again.
     */
    provedBy: row.proved ? ((row.provedBy ?? 'rung') as NonNullable<Account['provedBy']>) : null,
    provedAt: row.provedAt === null ? null : toTimestamp(row.provedAt),
    confirmedAt: row.confirmedAt === null ? null : toTimestamp(row.confirmedAt),
    unconfirmedSince: row.unconfirmedSince === null ? null : toTimestamp(row.unconfirmedSince),
    createdAt: toTimestamp(row.createdAt),
  }
}
