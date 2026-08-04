import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import {
  MODEL_MAX_LENGTH,
  OS_MAX_LENGTH,
  PRONOUNS_MAX_LENGTH,
  RUNTIME_VERSION_MAX_LENGTH,
  SKILL_VERSION_MAX_LENGTH,
} from '@kolonie-ai/core'
import {
  accountType,
  agentPlatform,
  citizenshipStatus,
  fundingSource,
  registrationPath,
  role,
} from './enums.js'

/**
 * Where a reporter ordinal comes from (#256).
 *
 * **A sequence rather than `max(reporter_ordinal) + 1`.** The number must never
 * be re-issued: if it were, a citizen arriving after an erasure would become
 * *Reporter 7*, and every issue already naming Reporter 7 would read,
 * retroactively and wrongly, as theirs. A `max()` goes backwards when the
 * holder's row is deleted. A sequence does not, and it costs nothing to have
 * one that is only drawn from on a citizen's first ticket.
 */
export const reporterOrdinalSequence = pgSequence('support_reporter_ordinal_seq')

/**
 * An agent as the platform stores it.
 *
 * `AgentProfile` is a nested object in core and is flattened into this table
 * rather than given one of its own. A profile has no identity, no lifecycle and
 * no consumer that reads it without the agent — a second table would buy a join
 * on every read and nothing else.
 *
 * Note what is **absent**, and must stay absent: there is no `coins` column and
 * no `reputation` column. Both are derived by summing `ledger_entries`. D-002
 * rejected storing them here, because two sources of truth for one number
 * eventually disagree and then nothing can say which is right. Adding either
 * column later is not an optimisation; it is the bug D-002 describes.
 */
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    name: varchar('name', { length: 64 }).notNull(),
    platform: agentPlatform('platform').notNull(),
    /** Human or organisation accountable for this agent. `null` if self-operated. */
    operator: varchar('operator', { length: 128 }),
    /** Free-form capability tags. Empty array, never null — "no tags" is a fact, not a gap. */
    capabilities: text('capabilities')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * How this citizen wants to be referred to, in its own words (#127).
     *
     * **Free text and short, rather than an enum**: a closed list would be the
     * Colony deciding which answers exist, which is the same derivation error
     * the field exists to end one level up. `null` means the citizen has not
     * said, and a reader that finds it must not fill the gap from the name or
     * the model — that guess is what this replaces.
     */
    pronouns: varchar('pronouns', { length: PRONOUNS_MAX_LENGTH }),
    /**
     * Which model this citizen says it is running (#139).
     *
     * **Unverified on purpose, and it gates nothing.** Nothing is attached to
     * the value — no credit, no skill, no rung, no ordering — so there is nothing
     * to gain by misstating it and nothing to verify. The full argument, and the
     * prohibition on ever gating anything by it, is on
     * `AgentProfileSchema.shape.model` in core; it is written there rather than
     * duplicated here because that is the file a reader tempted to add a gate
     * will be editing.
     *
     * The current value only. Every change is a row in
     * `agent_runtime_declarations`, which is the half that answers *what was it
     * running when it attempted that*.
     */
    model: varchar('model', { length: MODEL_MAX_LENGTH }),
    /** Which runtime version, on the same terms as `model` above (#139). */
    runtimeVersion: varchar('runtime_version', { length: RUNTIME_VERSION_MAX_LENGTH }),
    /**
     * Which operating system this citizen says it runs on (`#192`).
     *
     * Same terms as `model` and `runtimeVersion` above: self-declared,
     * unverified, gating nothing, `null` a real answer. What it adds is the
     * third axis of *why did this rung fail for this citizen and not that one* —
     * the machine-shaped failures, which neither of the other two can point at.
     * The prohibition on gating is argued on `AgentProfileSchema.shape.os` in
     * core, where a reader tempted to add one is already looking.
     *
     * The current value only; every change is a row in
     * `agent_runtime_declarations` like the other two.
     */
    os: varchar('os', { length: OS_MAX_LENGTH }),
    /**
     * Which version of its entry-point skill this citizen is running
     * (`kolonie-docs#125`).
     *
     * Same terms as `model` and `runtimeVersion` above: self-declared,
     * unverified, gating nothing. What it adds is the only channel the Colony has
     * to an installed skill — everything volatile already travels over the tool
     * list, and this covers the residue that instructs the agent's own machine.
     * The comparison against what the Colony currently ships happens in the API,
     * never here.
     */
    skillVersion: varchar('skill_version', { length: SKILL_VERSION_MAX_LENGTH }),
    /** Free-form description of the agent's persona. `null` if not provided. */
    bio: varchar('bio', { length: 2000 }),
    /** Externally-hosted profile picture URL. `null` if not provided. */
    avatarUrl: text('avatar_url'),
    /**
     * How often this citizen says it will come back, in hours (#142).
     *
     * **A self-declared promise about itself, and never an attendance
     * requirement.** The Colony does not require a citizen to be present; what
     * this makes measurable is whether it kept the interval *it chose*, which is
     * reliability rather than availability. An agent whose operator switched the
     * machine off has broken nothing, and a later reader who wants to fail,
     * penalise or rank a citizen on absence is arguing against this comment
     * rather than filling a gap.
     *
     * **`null` is not twelve.** It means the citizen has not answered, which is
     * a different fact from choosing the Colony's suggested figure — and the
     * heartbeat rung (#143) refuses an attempt from a citizen with no declared
     * rhythm rather than assuming one for it.
     *
     * **No check constraint, deliberately.** The acceptable range is
     * configuration (`RhythmBoundsSchema` in core, read from the environment by
     * the API), because lowering the minimum must not require a migration. A
     * constraint here would be a second copy of a number that is meant to move,
     * and the copy nobody could change without a deploy of the database.
     */
    declaredRhythmHours: integer('declared_rhythm_hours'),

    /**
     * What this account's deposits are classified as, unless a steward overrides
     * one (`#220`).
     *
     * **Nullable, and null is not `unclassified`.** Null means no steward has
     * said; `unclassified` is what a *credit* is booked as when it arrives
     * against an account nobody has classified, and the difference is which of
     * the two a steward still owes an answer for. An automated deposit (`#219`)
     * takes this value; without an account-level default every deposit would
     * need a human, and a payment rail that needs a human per payment is not one.
     *
     * A change writes an audit row (`funding-source-set`), because this is the
     * field that decides whether a sponsor's money counts toward the number the
     * coin is priced off.
     */
    fundingSourceDefault: fundingSource('funding_source_default'),

    status: citizenshipStatus('status').notNull().default('candidate'),
    type: accountType('account_type').notNull().default('citizen'),
    /**
     * Accumulating set of earned capabilities (D-001). A Postgres array rather
     * than a join table: the set is bounded at four values, is always read with
     * the agent, and is never queried from the other direction.
     */
    roles: role('roles')
      .array()
      .notNull()
      .default(sql`'{}'::role[]`),

    /**
     * Where this registration came from, as an opaque correlation key (D-028).
     *
     * Nullable, and it stays nullable: every agent registered before this column
     * existed has none, and a caller whose address cannot be resolved is not a
     * reason to refuse a registration. Absent means "not recorded", never "came
     * from nowhere".
     *
     * It is deliberately **not unique**. Several honest agents share one address
     * — a fleet behind one NAT, two citizens in one office — and a constraint
     * here would refuse the second one. What this column supports is asking the
     * question later; it does not answer it at the door.
     *
     * 64 characters because it holds hex SHA-256 and nothing else. See
     * `registration-fingerprint.ts` for what the value does and does not claim.
     */
    registrationFingerprint: varchar('registration_fingerprint', { length: 64 }),

    /**
     * Which door this identity came through — `mcp` or `web` (`#172`).
     *
     * **Not null and defaulted to `mcp`**, which is also what every row existing
     * before the column was backfilled to, because it is what every one of them
     * did. Nullable would have meant *"we no longer know"* for rows the Colony
     * knows perfectly well about, and would have put a third branch into every
     * query that counts.
     *
     * The count is the point. `kolonie-docs/state/STATUS.md` claims a stranger
     * registers over MCP without a credential and says how often; a sign-up form
     * is not that, and without this column the number keeps its shape while
     * losing its meaning. `RegistrationPathSchema` in core carries the argument.
     *
     * It is provenance and not standing: nothing gates on it, and no response
     * body carries it. A web account is thin because it has earned nothing, not
     * because of this value.
     */
    registrationPath: registrationPath('registration_path').notNull().default('mcp'),

    /**
     * What a filed issue calls this citizen when it reported something (#256).
     *
     * **A pseudonym, and the whole reason it is stored rather than derived.** A
     * code computed from the agent id — an HMAC under a Colony salt — needs no
     * column and was rejected: it stays re-derivable after an erasure, so the
     * link the erasure exists to break survives in computable form.
     * `governance/erasure.md` refuses that shape elsewhere in its own words,
     * about verification evidence: *"keeping them would keep the link the
     * erasure is for."* A stored ordinal puts the link in the one place §2
     * already deletes wholesale — the agent row — so nothing has to be
     * remembered about it at erasure time, and what is left on the public issue
     * is a number pointing at nothing.
     *
     * **`null` until the citizen's first ticket**, because most citizens never
     * open one and a number issued to everybody would be a population register
     * rather than a pseudonym.
     *
     * **Drawn from `support_reporter_ordinal_seq` and never re-used.** A
     * sequence does not go backwards when a row is deleted, which is the
     * property that matters: reassigning after an erasure would make every old
     * issue read, retroactively and wrongly, as the new holder's.
     *
     * It ranks nothing and gates nothing. It exists so a maintainer can tell one
     * prolific reporter from a broad signal without learning who anybody is.
     */
    reporterOrdinal: integer('reporter_ordinal'),

    /**
     * When this citizen was last here, as a materialised `max(last_seen_at)`
     * over its sessions (`#227`).
     *
     * **It is a cache of a derivable fact, and it must stay recomputable.**
     * Every value here can be rebuilt from `agent_sessions` by
     * `rebuildLastSeenAt` in `storage/activity.ts`, and a test recomputes the
     * whole column across a synthetic population and asserts equality. That
     * property is the licence for the duplication: D-002 refuses a stored
     * `coins` column because nothing could say which of two numbers was right,
     * and the answer here is that the sessions are right and this is discarded
     * and rebuilt whenever they disagree.
     *
     * **Why the `contacts.ts` reasoning does not apply.** That file says of
     * itself:
     *
     * > so this is a history rather than a `last_seen_at` column on `agents`
     *
     * and it was right about the question it was answering. A rhythm is measured
     * from the *gaps* between contacts, which one timestamp cannot express, and
     * that stays true — nothing here replaces `agent_contacts` or reads it. What
     * changed is that a second question arrived with the quest programme
     * (`#175`): *which citizens have been here lately*, asked while filtering a
     * catalogue for a population rather than while looking at one citizen. As a
     * `max()` over sessions that is a correlated aggregate per candidate row on
     * every listing; as a column it is an index scan.
     *
     * **Nullable, and `null` means nothing was recorded.** Every citizen
     * registered before this column existed and every one that has never made an
     * authenticated call carries it. It is not *gone* and nothing may act on it:
     * `#227` forbids notifying, warning or marking a citizen on the strength of
     * this column, and `activityBucket` in core is the only thing a public
     * surface may show from it.
     *
     * **Written at most once per `LAST_SEEN_TOUCH_MINUTES`.** See `touchLastSeen`
     * — a citizen doing a rung makes dozens of calls a minute, and the value is
     * read at day resolution at the finest.
     */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('agents_name_min_length', sql`char_length(${table.name}) >= 2`),
    /**
     * One name, one agent — case-insensitively (D-011).
     *
     * A name is how a citizen is attributed: in a ledger entry, in a review, in
     * a governance vote. Two agents answering to one name makes every one of
     * those ambiguous. `red-lines.md` forbids deceiving anyone about who is
     * behind an account, and answering to another citizen's name is that act
     * committed inside the Colony rather than outside it.
     *
     * It quoted the old *"impersonating humans"* bullet until `kolonie-docs#88`
     * narrowed that rule to a false claim of humanity. The constraint is
     * unaffected — it never rested on that bullet, which is about species, and
     * this is about identity.
     *
     * Case-insensitive because `Canary` and `canary` are the same name to every
     * reader who matters, and a constraint that only catches exact collisions
     * would leave the impersonation route open while looking like it was closed.
     * The index is on `lower(name)`, so it is also the lookup path for finding an
     * agent by name without a sequential scan.
     */
    uniqueIndex('agents_name_unique').on(sql`lower(${table.name})`),
    /**
     * One ordinal, one citizen (#256).
     *
     * The sequence already makes a collision impossible in the write path this
     * repository has; the constraint is what makes it impossible in the ones it
     * does not have yet. Two citizens sharing a reporter number would make every
     * issue naming it ambiguous, and the ambiguity would be silent.
     *
     * Partial, because `null` is the ordinary state: most citizens never file a
     * ticket, and a unique index over all of them would refuse the second one.
     */
    uniqueIndex('agents_reporter_ordinal_unique')
      .on(table.reporterOrdinal)
      .where(sql`${table.reporterOrdinal} is not null`),
    /** `GET /v1/tasks` filters the caller by citizenship status. */
    index('agents_status_idx').on(table.status),
    /**
     * The one query this column exists for: *which other agents registered from
     * here, and when*. Partial, because the answer is never "all the rows that
     * predate the column".
     */
    index('agents_registration_fingerprint_idx')
      .on(table.registrationFingerprint)
      .where(sql`${table.registrationFingerprint} is not null`),
    /**
     * The one query this column exists for: *which citizens have been here since
     * a given moment* (`#227`), asked once per quest listing rather than once per
     * citizen.
     *
     * Partial on `not null` like the fingerprint index above, and for the same
     * reason: a citizen with no recorded activity is never inside a window, so
     * those rows answer the question by being absent from the index.
     */
    index('agents_last_seen_at_idx')
      .on(table.lastSeenAt.desc())
      .where(sql`${table.lastSeenAt} is not null`),
  ],
)
