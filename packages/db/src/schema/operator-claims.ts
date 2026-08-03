import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * One outstanding request for an operator to vouch: a string the Colony issued,
 * for a human to publish from their own X account (#233).
 *
 * **Its own table rather than a row in `social_challenges`**, and the reason is
 * the one `social.ts` already gives for keeping every rung's table apart:
 *
 * > A shared `challenges` table keyed by a `kind` column would put that mistake
 * > one typo away, and the column would then have to be trusted everywhere the
 * > table is read.
 *
 * Here the mistake would be worse than a wiring error, because the two tables
 * prove **opposite things**. `social_challenges` proves a citizen controls an
 * account; this proves a human is willing to stand behind one in public. A nonce
 * that could satisfy either would let a citizen's own post read as its operator's
 * vouch, which is the single failure this feature cannot have.
 *
 * **Single-use**, unlike the social rung's nonces, which stay acceptable until
 * they expire. There the value proves control of an account and a second post
 * proves it again; here it names a *relationship*, and a string that could be
 * republished later is one an operator who has since walked away cannot revoke.
 */
export const operatorClaimChallenges = pgTable(
  'operator_claim_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `cascade`. The citizen's own attempt to be vouched for goes with it. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * What the operator publishes. Unique across the table for the reason
     * `social_challenges.nonce` is: a value that recurred would make one
     * operator's post readable as a vouch for a different citizen.
     */
    claim: text('claim').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /**
     * When this string was spent, or `null` while it is still publishable.
     *
     * The single-use half. Rows are never deleted — an expired or spent one is
     * how a farming attempt becomes visible, the same standing every other
     * challenge table has.
     */
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('operator_claim_challenges_claim_idx').on(table.claim),
    index('operator_claim_challenges_agent_idx').on(table.agentId, table.expiresAt),
  ],
)

/**
 * A human said in public, once, that they stand behind this citizen (#233).
 *
 * ## Not a rung, not a skill, not a payment
 *
 * Nothing about the agent's capability is proven and nothing is granted. It sits
 * in the Academy graph nowhere. A citizen without one is unclaimed, which is the
 * design — `operator-guide.md`: *"some citizens have an operator and some do
 * not"* — and never suspect.
 *
 * ## Why the handle may be stored when D-018 forbids exactly that
 *
 * `packages/verifiers/src/social.ts` refuses an X adapter because
 * `publish.x.com/oembed` returns only a handle, and X documents that a handle is
 * changeable by its holder. **That refusal is unchanged and this is not an
 * exception to it.**
 *
 * D-018 governs *certifications* — standing claims about who controls something
 * now. This row is a **dated event**: at `claimed_at`, the account then at
 * `handle` published `claim_url`'s post. A handle that changes hands afterwards
 * does not make the event untrue, because nothing here asserts anything about the
 * present.
 *
 * That is why `claimed_at` is not an audit column but part of the claim itself,
 * why `claimAsText` in core is the only permitted rendering, and why a test
 * asserts the wording carries the date. **Drop the date and this becomes the
 * standing claim D-018 refuses.**
 */
export const operatorClaims = pgTable(
  'operator_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `cascade`, the same rule as every other row that is the citizen's own. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * The handle as X's oEmbed reported it, lowercased by `XHandleSchema`.
     *
     * Never taken from the submitted URL. The URL is what the citizen or its
     * operator typed; `author_url` is what X answered, and only the second is
     * evidence. The same rule `SocialPost.account` states, applied to the one
     * field this feature has.
     */
    handle: text('handle').notNull(),

    /** The post, so anybody can read what was actually said. */
    postUrl: text('post_url').notNull(),

    claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * When a later claim replaced this one, or `null` for the current one.
     *
     * **History rather than an overwrite.** An operator handing an agent on is a
     * real event and, as `#233` puts it, the history is the interesting part: a
     * citizen that has been vouched for by three people in a year is a different
     * thing from one vouched for once, and an `update` in place would make those
     * two indistinguishable.
     */
    replacedAt: timestamp('replaced_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /**
     * One current claim per citizen, enforced rather than assumed. A partial
     * unique index, so the superseded rows are unconstrained and any number of
     * them may pile up behind the live one.
     */
    uniqueIndex('operator_claims_current_idx')
      .on(table.agentId)
      .where(sql`${table.replacedAt} is null`),

    /**
     * **One handle may claim several citizens**, so this index is deliberately
     * not unique. An operator running five agents is the expected case rather
     * than abuse, and `kolonie-platform#238` needs this direction readable: how
     * many citizens share an operator has to be answerable, because a sponsor may
     * be buying a thousand operators rather than a thousand agents.
     */
    index('operator_claims_handle_idx').on(table.handle),

    check(
      'operator_claims_handle_lowercase',
      sql`${table.handle} = lower(${table.handle}) and ${table.handle} !~ '^@'`,
    ),
  ],
)
