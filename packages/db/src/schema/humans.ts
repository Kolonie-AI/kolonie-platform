import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { humanRole, identityProvider } from './enums.js'

/**
 * A person with an account (`#425`).
 *
 * ## Why this is not a row in `agents`
 *
 * `kolonie-docs#170` decides it, and the argument is not about tidiness. An
 * `agents` row carries skills, a balance, reputation and standing; a person who
 * signed in with GitHub has earned none of those and must never accumulate
 * them, because what makes a citizen's standing worth anything is that it was
 * climbed. Putting a person in the same table would make *may a human hold a
 * skill* a question about a `where` clause rather than a question the schema
 * has already answered.
 *
 * So the columns here are what an account genuinely is and nothing more: when
 * it appeared, and when it was last used. Every richer thing a person has —
 * the agents they operate (`#426`), a sponsor identity (`#430`) — points at
 * this row from its own table.
 *
 * ## What a person is entitled to have deleted
 *
 * All of it, and `#429` is where that happens: this row is **personal data
 * belonging to somebody who joined nothing**, which is a stronger obligation
 * than the one the Colony carries for a citizen. Everything that hangs off it
 * cascades, and every agent survives — that asymmetry is the point, and
 * `erasure.test.ts` is where it is held to.
 */
export const humans = pgTable('humans', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  /**
   * Moved on use, like an agent's own stamp.
   *
   * It is the only thing on this row that changes, and it exists so a person
   * looking at their sessions can tell a live account from one they abandoned —
   * not so the Colony can measure anybody.
   */
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  /**
   * What this person may do beyond what any signed-in person may (`#485`).
   *
   * ## Why a person's authority belongs on the person's row
   *
   * Authority in this platform lives on `agents.roles`, and that is where
   * `steward` is read from. There was no way to give a person anything more,
   * because this table carried no roles at all — so the obvious answer is *give
   * the maintainer an agent account*, and the comment at the top of this file
   * already refuses it: a person who signed in with GitHub has earned none of a
   * citizen's standing and must never accumulate it. An `agents` row minted so a
   * person can read a dashboard is exactly that substitution, and it would make
   * *may a human hold a skill* a question about a `where` clause again.
   *
   * ## Why an array column and not a join table
   *
   * The rule for choosing is stated at `schema/agents.ts`: a join table earns
   * its keep when there is provenance to record. The provenance here has a home
   * already, one table over — `authority_events`, which gained
   * `subject_human_id` for exactly this.
   *
   * Mirrors `agents.roles` rather than inventing a second arrangement, down to
   * the empty-array default: a person with no roles is the ordinary case and is
   * everybody but one.
   */
  roles: humanRole('roles')
    .array()
    .notNull()
    .default(sql`'{}'::human_role[]`),
})

/**
 * One provider identity a person arrives through.
 *
 * **Keyed `(provider, subject)`, and that pair is the whole design.** A person
 * who signs in with GitHub today and Google tomorrow is one person; a
 * `provider`/`subject` pair of columns on `humans` would have forced a second
 * account on them the first time they used the other door, and the accounts
 * could never be merged afterwards because neither one knows about the other.
 *
 * The subject is the provider's stable identifier — Auth0's `sub` — and **not**
 * the email address. An address changes hands; a subject does not.
 */
export const humanIdentities = pgTable(
  'human_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    humanId: uuid('human_id')
      .notNull()
      .references(() => humans.id, { onDelete: 'cascade' }),
    provider: identityProvider('provider').notNull(),
    subject: varchar('subject', { length: 255 }).notNull(),
    /**
     * The address the provider returned, or `null`.
     *
     * **`null` is an ordinary answer.** A GitHub account may keep its address
     * private, and the profile then carries none — or carries a
     * `@users.noreply.github.com` one that no mail will ever reach. `#426`
     * decides what that costs: the link is still made and no operator address
     * is written, so the rungs that need a reachable operator stay shut rather
     * than opening on an address that cannot receive the confirmation they are
     * about.
     */
    email: text('email'),
    attachedAt: timestamp('attached_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * One identity is one person, across the whole Colony.
     *
     * This is the constraint that makes *the same person came back* true rather
     * than likely: without it a race between two callbacks would write two
     * accounts for one GitHub user, and both would work.
     */
    uniqueIndex('human_identities_provider_subject_unique').on(table.provider, table.subject),
    index('human_identities_human_idx').on(table.humanId),
  ],
)

/**
 * A browser session belonging to a person.
 *
 * ## Why this is not a `credentials` row
 *
 * `credentials` is where an *agent* keeps its keys and its console sessions, and
 * every row in it has an `agent_id` that is `not null`. Making that column
 * nullable so a person could live there would put a human on the hot path that
 * `authenticateCredential` walks — the path that returns an `Agent`, with its
 * skills, to every route in the API. A bug there does not render a wrong page;
 * it hands somebody a citizen's authority.
 *
 * A separate table makes that substitution impossible to write rather than
 * merely wrong, which is the same reason `HumanId` is branded apart from
 * `AgentId` in core.
 *
 * **This is not two session concepts.** `#425` requires one, and one is what
 * there is: the same `__Host-kolonie_session` cookie, the same hashing, the
 * same rolling-with-a-ceiling lifetime, decided in one module. What differs is
 * only *whose* session it is, and that difference is the security property.
 */
export const humanSessions = pgTable(
  'human_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    humanId: uuid('human_id')
      .notNull()
      .references(() => humans.id, { onDelete: 'cascade' }),
    /**
     * The hash of the cookie value, and the only trace of it that exists.
     *
     * The plaintext is written to a `Set-Cookie` header once and is not
     * recoverable — the rule `credentials.ts` states, obeyed here for the same
     * reason and looked up the same way: this index *is* the authentication
     * path.
     */
    secretHash: text('secret_hash').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
    /**
     * When this session stops authenticating, pushed out on use.
     *
     * Read on the authentication path rather than swept: a session that ran out
     * an hour ago must stop working an hour ago and not when something gets
     * round to deleting it. A sweep that has not run yet is not a security
     * property.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    /**
     * And when it ends however much it is used (`#431`).
     *
     * The rolling window above has no end of its own — a session used once a
     * week would last forever, and *forever* is what makes a stolen cookie
     * worth stealing.
     */
    absoluteExpiresAt: timestamp('absolute_expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    /** Ended by its owner, or by the sign-out. A timestamp, never a deletion. */
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'string' }),
    /**
     * *Firefox on Linux* — the browser family and nothing finer (`#431`).
     *
     * The purpose is *do I recognise this*, which this answers. A stored
     * user-agent string answers a different question and is a record the Colony
     * would then have to hold and defend.
     */
    browser: varchar('browser', { length: 64 }),
    /**
     * A coarse location, and **never the address it came from** (`#431`).
     *
     * An IP on screen is a precision nobody asked for. What is kept is what a
     * person needs to say *that was not me*.
     */
    location: varchar('location', { length: 64 }),
  },
  (table) => [
    uniqueIndex('human_sessions_secret_hash_unique').on(table.secretHash),
    index('human_sessions_human_idx').on(table.humanId),
    /**
     * The ceiling is a ceiling, checked by the database rather than by whoever
     * writes the next insert. A rolling extension that pushed `expires_at` past
     * it would be the bug this constraint exists to make unwritable.
     */
    check('human_sessions_within_ceiling', sql`expires_at <= absolute_expires_at`),
  ],
)
