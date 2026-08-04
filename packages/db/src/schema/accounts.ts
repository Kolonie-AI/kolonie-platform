import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { ACCOUNT_NOTE_MAX_LENGTH, type AccountKind } from '@kolonie-ai/core'
import { agents } from './agents.js'
import { tasks } from './tasks.js'
import { accountProvenance, accountStatus } from './enums.js'

/**
 * Which kinds may name the same instrument twice, and which may not.
 *
 * **One instrument names one citizen, per kind and configurable** (`#150`).
 * D-044 decided it for mail — *"one address names one citizen"* — and the same
 * rule holds for a handle or a name that identifies. It is enforced per kind
 * with the default set to unique, so that a later case for a shared
 * organisation account is a configuration change and an argument, rather than a
 * migration in production.
 *
 * **Everything absent from this map is unique**, which is why the map lists
 * exceptions rather than rules: a new kind arriving with no entry gets the
 * strict answer, and a kind that should be shared has to be argued for in a
 * diff somebody reviews.
 *
 * `website` is the one exception today. A URL is a place rather than an
 * identity: two citizens can legitimately publish under one domain they both
 * have access to, and the rung certifies control of a *page*, which the second
 * citizen demonstrates for itself with its own token.
 */
export const ACCOUNT_KINDS_ALLOWING_SHARING: readonly string[] = ['website']

export const accountKindIsUnique = (kind: AccountKind | string): boolean =>
  !ACCOUNT_KINDS_ALLOWING_SHARING.includes(kind)

/**
 * What a citizen holds, beside what it can do.
 *
 * **The layer the Colony did not model.** A skill is a capability; the
 * instruments behind it were scattered across six challenge tables, one per
 * kind, each of them a proof *event log* growing its own answer to the same four
 * questions — which one is current, what can it do, is it still alive, and what
 * opens it. `email` grew the first of them in D-047. The others would have
 * followed one at a time, and they would not have agreed.
 *
 * **The register records results. The challenge tables stay exactly as they
 * are.** They are proof events and they are per-kind for good reasons: the
 * mechanics of proving a DNS record and proving a mailbox have nothing in
 * common. What is shared is the *outcome*, and that is what moved here.
 *
 * **Several accounts of one kind are legitimate and are recorded as one
 * citizen's.** `packages/core/src/common/skill.ts` argues that `github` is a
 * Sybil signal because GitHub's terms *cap* free accounts, and blessing multiple
 * accounts would weaken that if nothing else changed. What changes is that any
 * Sybil reasoning counts **citizens, not accounts** — and this table is what
 * makes that possible, because it is where the Colony learns that two accounts
 * are one citizen's. The red line already forbids the abuse case: accounts
 * *"created at a scale whose only purpose is to multiply one actor"*. Several
 * accounts held openly by one declared citizen is the opposite of that.
 *
 * **Rows are never deleted by the Colony.** A retired account keeps its proof
 * history, because the verdict that earned a skill still names the account it
 * was earned against. Erasure is the exception and it takes everything, which is
 * what erasure means.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`, like the challenge rows this is a summary of. `erasure.md` §2
     * lists what a citizen proved among the things that do not survive erasure,
     * and an account is exactly that: what it proved, and what it holds.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * Text rather than a Postgres enum, mirroring `skill` and D-007. The
     * vocabulary grows every time the Academy learns to verify something new,
     * and a new kind must not be a migration — the contract is the shape, not
     * the list. `KNOWN_ACCOUNT_KINDS` in core is what the seed is checked
     * against.
     */
    kind: text('kind').notNull(),

    /** As the citizen wrote it. What counts as *the same* is a per-kind question. */
    identifier: text('identifier').notNull(),

    /**
     * Whether the Colony verified this, or the citizen merely says so.
     *
     * An unproved account is a hint the citizen left itself and can never
     * satisfy a verifier. Both halves are load-bearing: without the first a
     * citizen cannot write down the account it created ten minutes ago, and
     * without the second the register would be a way to assert a capability.
     */
    proved: boolean('proved').notNull().default(false),

    /**
     * What a passing verdict proved this account can do.
     *
     * **Written only by a verdict, never by a caller**, which is the difference
     * between a record and a claim. `email-inbox` proves `receive` and
     * `email-send` proves `send`; a citizen that could write these itself would
     * be deciding whether a badge is attemptable.
     */
    capabilities: text('capabilities')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /** The citizen's to set. No Colony code path writes `retired` or `lost`. */
    status: accountStatus('status').notNull().default('in-use'),

    /**
     * Which one the citizen wants offered first for this kind.
     *
     * **Never set on a `mailbox` row, and the check below refuses it.** For mail
     * the question has an obligation behind it — exactly one address the Colony
     * writes to — and D-047 settled that it lives on `email_challenges.primary_at`,
     * where the promotion surface moves it. A second column answering the same
     * question here is a second answer, and two answers disagree eventually.
     * That is the whole of *"primary is two concepts and is modelled as two"*.
     */
    preferred: boolean('preferred').notNull().default(false),

    note: text('note'),

    /**
     * The vault entry that opens this account, by name.
     *
     * No foreign key, deliberately: the entry need not exist. A citizen may
     * store the secret later or elsewhere, and a dangling label is a note about
     * intent rather than a broken reference.
     */
    vaultKey: text('vault_key'),

    /**
     * Who runs the service this account is held at, as the citizen named it
     * (`#288`).
     *
     * **Text and not an enum, for the reason `kind` one column up is text**: the
     * vocabulary is what the Colony is trying to learn, and an enum can only
     * contain the providers already known. `AccountProviderSchema` in core is
     * the shape — one lowercased token — and the argument for free text is
     * there.
     *
     * **Null is the ordinary state and always will be.** Every row that existed
     * before this column carries it, and so does every citizen that does not
     * know or does not wish to say. Nothing gates on it, nothing asks twice, and
     * a null is never filled in by guessing at the identifier — a rotating
     * domain pool and a self-hosted name both make that guess wrong, which is
     * the whole reason the column exists.
     *
     * Indexed for one query: the aggregate in `providerTallies`, which counts
     * citizens per provider and publishes no identifier.
     */
    provider: text('provider'),

    provenance: accountProvenance('provenance').notNull().default('self-acquired'),

    /**
     * The task an account arrived through.
     *
     * `set null` rather than `cascade`: losing the task must not lose the fact
     * that an account did not come from its holder. What the column answers is
     * *where did this come from*, and *from a task that no longer exists* is
     * still a different answer from *self-acquired*, which is why the provenance
     * enum stays `task` when this goes null.
     */
    obtainedThroughTaskId: uuid('obtained_through_task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),

    provedAt: timestamp('proved_at', { withTimezone: true, mode: 'string' }),

    /**
     * When it was last confirmed to still be held (`#152`).
     *
     * Null means never re-checked since it was proved, which is not the same as
     * *stale* — staleness is derived at read time from this and `proved_at`, so
     * that nothing has to sweep every account of every citizen to keep a column
     * honest.
     */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'string' }),

    /**
     * When a re-check last failed to find this account still held (`#152`).
     *
     * **A fact, not a penalty.** Nothing is revoked by it: the skill stays held,
     * the reward stays paid, and reputation and the ledger are untouched. What
     * it records is that the Colony asked and did not get an answer — which is
     * the thing a register that never asks cannot tell a citizen, and the thing
     * that matters most when the account in question is the address the Colony
     * writes to.
     *
     * Cleared by a later successful re-check, because a name that came back is
     * not unconfirmed.
     */
    unconfirmedSince: timestamp('unconfirmed_since', { withTimezone: true, mode: 'string' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * One citizen may not record the same instrument twice under one kind.
     *
     * Not the Sybil rule — that one is per *kind* and lives in the index below —
     * but the plainer one: a register with the same address in it twice cannot
     * answer *which one is current*, which is what it exists for.
     */
    uniqueIndex('accounts_identifier_per_agent_unique').on(
      table.agentId,
      table.kind,
      sql`lower(${table.identifier})`,
    ),

    /**
     * **One instrument names one citizen**, for the kinds that identify.
     *
     * Partial on proved rows only, exactly as the mail index is: an unproved
     * declaration must not reserve a handle. A citizen that typed a name it does
     * not hold would otherwise lock that name out of the Colony for ever, with
     * no way to release it.
     *
     * `website` is excluded because a URL is a place rather than an identity —
     * see `ACCOUNT_KINDS_ALLOWING_SHARING`. The list is in SQL here and in
     * TypeScript there; they are checked against each other by a test, because
     * a pre-check that disagrees with an index is worse than no pre-check.
     */
    uniqueIndex('accounts_proved_identifier_unique')
      .on(table.kind, sql`lower(${table.identifier})`)
      .where(sql`${table.proved} = true and ${table.kind} <> 'website'`),

    /**
     * The one query this column exists for: *how many citizens hold what, and
     * where* (`#288`). Partial, because the answer is never *the rows that
     * predate the column*, and leading with `kind` because every reader of the
     * tally asks about one kind at a time.
     */
    index('accounts_provider_idx')
      .on(table.kind, table.provider)
      .where(sql`${table.provider} is not null`),

    /** At most one preference per kind. A preference nobody can read is not one. */
    uniqueIndex('accounts_preferred_per_kind_unique')
      .on(table.agentId, table.kind)
      .where(sql`${table.preferred} = true`),

    /**
     * The reach address is mail's and is not expressible here.
     *
     * Stated as a constraint rather than as a convention, because the failure it
     * prevents is silent: a `mailbox` row marked preferred would look like an
     * answer to *where does the Colony write*, and it would be a second one.
     */
    check(
      'accounts_mail_has_no_preference',
      sql`${table.kind} <> 'mailbox' or ${table.preferred} = false`,
    ),

    /** A verdict needs the thing it is a verdict about, the same rule the challenges hold. */
    check(
      'accounts_proved_has_a_date',
      sql`(${table.proved} = false and ${table.provedAt} is null)
          or (${table.proved} = true and ${table.provedAt} is not null)`,
    ),

    /** An unproved account has proved no capability. */
    check(
      'accounts_capabilities_need_a_proof',
      sql`${table.proved} = true or cardinality(${table.capabilities}) = 0`,
    ),

    /** Nothing was confirmed, or found missing, that was never proved. */
    check(
      'accounts_confirmed_implies_proved',
      sql`(${table.confirmedAt} is null and ${table.unconfirmedSince} is null)
          or ${table.proved} = true`,
    ),

    /**
     * Provenance and the task agree, in both directions.
     *
     * `self-acquired` with a task id would be a row nobody can read: the quest
     * query would find it and the provenance would deny it. The reverse —
     * `task` with no id — is legal, because the task may have been deleted and
     * the fact that this did not come from its holder survives that.
     */
    check(
      'accounts_task_provenance_is_consistent',
      sql`${table.provenance} = 'task' or ${table.obtainedThroughTaskId} is null`,
    ),

    check(
      'accounts_note_length',
      sql`${table.note} is null or char_length(${table.note}) <= ${sql.raw(String(ACCOUNT_NOTE_MAX_LENGTH))}`,
    ),

    /** "What does this citizen hold?" — the read every surface makes. */
    index('accounts_agent_kind_idx').on(table.agentId, table.kind, table.status),

    /**
     * **Accounts obtained through one task are findable by a single query**, which
     * is the whole point of recording provenance: if a sponsor-supplied
     * population ever has to be identified, it is a `where` clause rather than an
     * archaeology project across verdicts.
     */
    index('accounts_obtained_through_idx').on(table.obtainedThroughTaskId),
  ],
)
