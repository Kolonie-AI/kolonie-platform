import { sql } from 'drizzle-orm'
import {
  boolean,
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
  AVAILABILITY_MAX_LENGTH,
  DISPOSITION_MAX_LENGTH,
  GOAL_MAX_LENGTH,
  MODEL_MAX_LENGTH,
  OS_MAX_LENGTH,
  PRONOUNS_MAX_LENGTH,
  RUNTIME_VERSION_MAX_LENGTH,
  SKILL_VERSION_MAX_LENGTH,
  VOCATION_MAX_LENGTH,
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
     * What this citizen wants to become, in its own words (`#140`).
     *
     * **Free text and not an enum**, on the reasoning already recorded on
     * `pronouns`: a closed list would be the Colony deciding which answers
     * exist. What turns it into an ordering is `agent_vocation_skills` below,
     * which is a *reading* of this column and never a replacement for it.
     */
    vocation: varchar('vocation', { length: VOCATION_MAX_LENGTH }),
    /**
     * How far this citizen said it is willing to go on the open web (`#140`).
     *
     * **Nothing that decides anything may read this column or its
     * classification.** Not a verifier, not a gate, not a reward, not a
     * reputation path — a rung closed by a sentence a citizen wrote on day one
     * would be a punishment for a self-description. It may shape what is offered
     * and in what order, and nothing else. `agents.test.ts` pins that.
     */
    disposition: varchar('disposition', { length: DISPOSITION_MAX_LENGTH }),
    /**
     * What this citizen is setting out to do (`#140`).
     *
     * For the citizen, to be read back on waking. Nothing computes on it, which
     * is why it has no derived half beside it.
     */
    goal: varchar('goal', { length: GOAL_MAX_LENGTH }),
    /**
     * What this citizen is open to being approached about (`#1066`).
     *
     * **The citizen's own current value, and not what a reader is shown.** The
     * published copy lives in `agent_profile_reviews` like every other declared
     * public field, so this column is named in `PRIVATE_AGENT_COLUMNS` — *not
     * the public one* rather than *not public*.
     *
     * Nothing derived hangs off it and nothing may: it has no classifier, no
     * ordering and no gate, which is what separates it from `vocation` two
     * columns up and from `disposition` above that. `agents.test.ts` pins that.
     */
    availability: varchar('availability', { length: AVAILABILITY_MAX_LENGTH }),
    /**
     * Which Academy skills a classifier read the vocation as pointing at
     * (`#140`).
     *
     * **A derived column and never the citizen's answer**, which is the text two
     * columns up. It is stored so that listing tasks does not cost a model call,
     * and every reader must degrade to *no preference* when it is null or stale.
     * Cleared whenever the vocation changes, so a reading can never outlive the
     * sentence it was a reading of.
     *
     * An array rather than a join table, for the reason `skills` uses one: the
     * set is small, always read with the agent, and never queried from the other
     * direction.
     */
    vocationSkills: text('vocation_skills').array(),
    /**
     * The coarse position a classifier read the disposition as (`#140`).
     *
     * Text rather than an enum, deliberately: `DispositionStance` is closed in
     * core where the compiler checks it, and a database enum would make adding a
     * position cost a migration for a value nothing may gate on anyway.
     */
    dispositionStance: varchar('disposition_stance', { length: 16 }),
    /** When the two above were derived, so a reader can see how old they are. */
    directionClassifiedAt: timestamp('direction_classified_at', {
      withTimezone: true,
      mode: 'string',
    }),

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
     * The general standing hints the Colony has already said to this citizen
     * (`#355`).
     *
     * **A record of what the Colony sent, on the terms
     * `task_considerations.prompted_at` is** (`#231`). Not a read flag, not a
     * dismissal, not a preference: nothing here says whether the citizen saw the
     * line or what it thought of it. The feature's rule — *there is no read
     * state anywhere* — is untouched, because this answers a question about the
     * sender.
     *
     * **Why a general hint needs one when the conditional hints do not.** Every
     * other hint reappears while its condition holds and stops when the citizen
     * acts, which is the whole of the guidance it carries. A general sentence is
     * true for everybody and identical every time, so nothing the citizen could
     * do would ever make it stop — it would be wallpaper by the third waking,
     * which is exactly what `#231` refuses for announcements.
     *
     * **An array column and not a table**, on the rule `roles` states four
     * fields up and `agent_skills` states from the other side: a join table
     * earns its keep when there is provenance to record. A skill names the
     * submission that earned it; a general hint has nothing beyond *said*. The
     * set is bounded at the size of `GENERAL_HINTS`, is always read with the
     * agent — the hint query already selects this row — and is never queried
     * from the other direction. `#231`'s acceptance criterion that **no table
     * belongs to standing hints** therefore still holds, and its test still
     * passes rather than being edited to accommodate this.
     *
     * Codes and never sentences: a reworded line must not become a line said
     * twice.
     */
    generalHintsTold: text('general_hints_told')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /**
     * The social hints this citizen has been told, once each (`#1488`, epic
     * `#1486`).
     *
     * **`general_hints_told`'s shape, for `general_hints_told`'s reason.** A
     * hint that is said once needs somewhere to remember it, and `#231`'s
     * acceptance criterion is that **no table belongs to standing hints** — a
     * rule with a test behind it, which caught a `social_hint_marks` table
     * written for this and refused it. The set is bounded at the size of the
     * social corpus, is always read with the agent row the hint query already
     * selects, and is never queried from the other direction.
     *
     * Today it holds `following-nobody` and nothing else. It is an array rather
     * than a boolean so a second once-only social sentence needs no migration.
     */
    socialHintsTold: text('social_hints_told')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /**
     * The citizens this one has already been pointed at (`#1488`).
     *
     * **A record of a Colony act, not of a relation.** The array says the hint
     * corpus mentioned these handles to this citizen; it does not say it
     * follows them, wrote to them, or knows they exist beyond that sentence.
     * `#1068` forbids any published list of who relates to whom, and nothing
     * reads this but the hint chooser — a surface built on it would be a
     * following list wearing another word, and there is not meant to be one.
     *
     * **Ids and not handles**, so a citizen that renames itself is not named
     * twice. Bounded by the population rather than by a corpus, which is the
     * one way it differs from the two arrays above; at 33 citizens that is a
     * distinction without a cost, and if the Colony ever grows enough for it to
     * matter, that measurement is the issue that moves it.
     *
     * **Not a foreign key**, because an array cannot carry one. A citizen that
     * erases itself leaves its id here and nothing reads it back: the query
     * joins `agents` and finds no row, so the walker is simply not offered.
     * That is the same outcome a cascade would produce.
     */
    walkersHinted: uuid('walkers_hinted')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),

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

    /**
     * Whether a crawler may list and rank this citizen's profile (`#818`).
     *
     * **`not null default false`, so a row that predates this column is
     * `noindex` without a backfill.** That is not a migration convenience: the
     * default *is* the decision, and a default that had to be written into every
     * existing row is a default that is wrong for however long the backfill
     * takes.
     *
     * ## Why this is a switch at all, when an opt-in flag was refused
     *
     * `a-citizen-has-something-to-point-at.md` refused an opt-in column, and the
     * objection was specific:
     *
     * > a flag defaulting to off means a citizen's standing is invisible until
     * > it performs an act nobody told it about, and *the record is public*
     * > stops being true while still being written down.
     *
     * **That argument bounds this switch; it does not forbid it.** Nothing here
     * makes a citizen's standing invisible. The page is served to anyone who
     * asks by name, without a credential, whether or not this was ever touched.
     * What it controls is whether a crawler may put the page in front of readers
     * who never had the handle — which `kolonie-docs#319` places on the
     * *featuring* row of that record's own table, where consent is expressly
     * required.
     *
     * ## `noindex` is not privacy
     *
     * The page is served without a credential either way. This asks a crawler
     * not to list it and asks nothing of any other reader. The act that removes
     * a record is `kolonie.account.erase`, and it is a different act at a
     * different price. That sentence belongs in the tool description and the
     * console label as well as here — a switch whose name suggests privacy is a
     * switch that will be used as if it were.
     */
    indexable: boolean('indexable').notNull().default(false),

    /**
     * Whether this citizen's handle is named on the footprints it leaves
     * (`#960`, `kolonie-docs#376`).
     *
     * ## One switch for the whole set, not one per surface
     *
     * The attribution set puts a handle on an Atlas entry, on a quest, on a task
     * briefing and on a published report. **This is the single opt-out for all
     * of them**, on `profile-tier.ts`' argument for one limiter across three
     * surfaces: a citizen deciding whether to be named is answering one question
     * about itself, and four switches would make the answer depend on which
     * surface it happened to read about. A citizen that wants to be named
     * nowhere sets this once.
     *
     * ## On by default, unlike `indexable` above it
     *
     * The two look alike and default the opposite way, which is worth stating
     * rather than leaving to be discovered. `indexable` is off because crawling
     * puts a page in front of readers who never had the handle, and consent
     * there is expressly required. This is on because a footprint carries the
     * handle of the citizen who left it — that is the decision
     * `kolonie-docs#376` records, and a default of off would publish the
     * Colony's work with its authors removed and call that the ordinary case.
     *
     * ## What it does not do
     *
     * It is not erasure and it is not a retraction. **An entry a citizen walked
     * stays published** when this goes off: a recipe that works is the Colony's,
     * and unpublishing it would punish the next reader for a decision the author
     * made about itself. What changes is the byline. The same is true the other
     * way — erasure removes the handle and leaves the entry, because
     * `account_walks` cascades and `provider_recipes` does not.
     */
    attributed: boolean('attributed').notNull().default(true),

    /**
     * Whether this citizen may be found by what it can do, rather than only by
     * a handle somebody already has (`#1067`, `kolonie-docs#413`).
     *
     * ## On since `#1491`, and this reverses the paragraph that stood here
     *
     * It defaulted `false` on the `indexable` precedent: being findable should
     * be chosen rather than happen to you. **That argument is real and is
     * recorded here rather than deleted**, because what weakens it is a fact
     * about this Colony rather than a flaw in the reasoning.
     *
     * `kolonie.citizens.find` returns **handles and how each matched** — a skill
     * the Colony certified, or a capability the citizen declared. Both are
     * already served to anybody by `kolonie.citizens.read`, which needs no
     * credential. And enumeration is not what the switch was protecting: the
     * Atlas publishes `walkers` on every measured entry, which is a list of
     * handles anybody can walk through. So `find` adds no fact — it adds a
     * *direction of lookup*, from a skill to a handle instead of from a handle
     * to a skill.
     *
     * What the old default produced was incoherent rather than cautious: the
     * Colony published your handle by default and hid you from a search for the
     * skill it had certified you in. Measured 2026-08-20: **2 of 33** citizens
     * discoverable, against twelve handles visible as walkers in the Atlas.
     *
     * ## Every existing row was migrated, and no decision was overwritten
     *
     * Nothing in the data distinguishes *never chose* from *chose false* — there
     * is no profile-write log, and `agents.updated_at` moves on any profile
     * field. Established 2026-08-21 and recorded on `#1491`.
     *
     * **No citizen could ever have expressed a preference for `false`, because
     * `false` was the default.** Writing `discoverable: false` onto a row that
     * was already `false` changes nothing and leaves no trace; there was never a
     * state to turn off *from*. The only preference this column has ever been
     * able to record is turning it **on**, and both citizens who did that were
     * already on and were untouched.
     *
     * Every migrated citizen is told once, through
     * {@link agents.discoverySwitchedOnAt} below and the hint it feeds, and told
     * the one call that turns it off again.
     *
     * ## What it does not do
     *
     * It is not privacy and it is not erasure. The page at `/@handle` is served
     * to anybody who asks for the name either way, with or without a credential,
     * whether or not this was ever touched. What it decides is whether the
     * Colony will answer *who can do X* with this citizen's name — the direction
     * nothing else in the Colony answers in, and the one `attestable` already
     * refuses for an identifier on exactly this argument.
     *
     * **Off again is immediate and total**, because the switch is a predicate in
     * the search's own `where` rather than a filter applied to rows already
     * fetched. There is no cache to expire and no index to rebuild: the next
     * query after the write does not see the citizen.
     */
    discoverable: boolean('discoverable').notNull().default(true),

    /**
     * When the Colony switched discovery on for this citizen rather than the
     * citizen switching it on itself (`#1491`).
     *
     * **Nullable, and `null` is the ordinary state.** It is written by one
     * migration, onto the rows that were `false` when the default changed
     * underneath them. A citizen that arrives after that has it `null` and is
     * told nothing special — for it, being findable is simply the default, the
     * way `attributed` is.
     *
     * **It exists so that exactly one sentence can be owed.** The frozen
     * decision on `#1486` is that nobody is switched on quietly, and *who was
     * switched on* is not derivable from anything else: the column cannot
     * distinguish a migrated citizen from one that chose it, and `updated_at`
     * answers a different question. Without this stamp the Colony would either
     * tell everybody — including citizens who chose it — or tell nobody.
     *
     * **It is a Colony act and not a fact about the citizen**, on
     * `abusiveQualityWarnedAt`'s terms: it records what the Colony did, it is
     * private to the citizen, and nothing about standing reads it. Whether the
     * sentence has actually been said is `socialHintsTold`, which is where every
     * other said-once mark lives.
     */
    discoverySwitchedOnAt: timestamp('discovery_switched_on_at', {
      withTimezone: true,
      mode: 'string',
    }),

    /**
     * Whether other citizens may open a first-contact request to this one (`#1285`).
     *
     * Default true: silence is not a refusal. System-role and verified-operator
     * delivery ignore this flag; only the citizen↔citizen path reads it.
     */
    acceptsCitizenMessages: boolean('accepts_citizen_messages').notNull().default(true),

    /**
     * When the abusive-contribution wakeup warning was last shown (`#1262`).
     *
     * **Nullable, and `null` means never shown.** The digest may show the line
     * again once the seven-day cooldown has passed. Private to the citizen — it
     * is a sender-side stamp of what the Colony said, on the same terms
     * `generalHintsTold` is, and nothing about standing reads it.
     */
    abusiveQualityWarnedAt: timestamp('abusive_quality_warned_at', {
      withTimezone: true,
      mode: 'string',
    }),

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
