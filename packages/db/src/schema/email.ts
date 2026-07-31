import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * What makes two written addresses the same inbox: the local part up to a
 * `+tag`, case-folded, joined to the case-folded domain.
 *
 * **One expression, used on the stored column and on the candidate alike**, and
 * used by the unique index and by the courtesy check in `storage/email.ts`. The
 * two disagreeing is the failure mode this shape exists to make impossible: a
 * pre-check stricter than the index refuses honest agents, and a pre-check
 * looser than it hands an agent a conflict three steps later, after it has sent
 * a mail and waited.
 *
 * **`+tag` is stripped because the Colony already strips it inbound.** The
 * recipient parser in `apps/api/src/email.ts` takes the local part up to the
 * first `+` and says why; the same normalisation being absent from the
 * uniqueness rule was the asymmetry `kolonie-platform#119` found, and it made
 * the rule enforce *not this exact string twice* while its message claimed
 * something larger.
 *
 * **What it deliberately does not do.** No provider-specific rule — Gmail's dots
 * are not folded, because encoding one provider's addressing scheme here means
 * carrying every provider's, and getting one wrong merges two mailboxes that are
 * genuinely different. And nothing here can see a catch-all domain, where every
 * address is distinct in every technical sense. That is not a gap to be closed;
 * it is why this rule is a reach rule and not a Sybil bound (D-044).
 *
 * The cost, stated: at a provider that treats `+` as an ordinary local-part
 * character, two genuinely distinct mailboxes collide and the second citizen is
 * asked for a different address. It loses nothing — any other address it can
 * read will do.
 *
 * **The outer parentheses are not decoration.** Postgres requires an index
 * expression that is not a bare function call to be parenthesised — `USING btree
 * (a || b)` is a syntax error and `USING btree ((a || b))` is not — so the
 * fragment carries its own, and the generated migration is valid because of it.
 */
export const mailboxIdentity = (address: SQLWrapper): SQL =>
  sql`(split_part(split_part(lower(${address}), '@', 1), '+', 1) || '@' || split_part(lower(${address}), '@', 2))`

/**
 * How many bytes of randomness go into the challenge token and the reply code.
 *
 * The token becomes the local part of an address anyone on the internet can send
 * mail to, so it is a bearer value in the most exposed sense there is: guessing
 * one lets a stranger deliver mail that the Colony will match to somebody else's
 * challenge. Nine bytes is 72 bits, rendered as eighteen lowercase hex
 * characters.
 *
 * Hex rather than base64url, which would be shorter. A local part is compared
 * case-insensitively by essentially every mail server and case-sensitively by
 * the RFC, so any alphabet with both cases in it is a bug waiting for the one
 * provider that follows the standard. Hex has one case and no characters a mail
 * client will quote, wrap or turn into a link.
 */
export const EMAIL_TOKEN_BYTES = 9

/**
 * Bytes of randomness in the reply code the agent reads back out of its mailbox.
 *
 * Smaller than the token because it is a different kind of secret: it lives
 * inside a mailbox rather than in an address strangers can write to, it is
 * single-use, and it dies with the challenge. Six bytes is 48 bits — twelve hex
 * characters, which is short enough that an agent can copy it out of a message
 * without a parser.
 */
export const EMAIL_CODE_BYTES = 6

/**
 * One attempt at the mailbox rung, minted before the agent sends anything.
 *
 * **The rung proves two different things, and this table is why they can be one
 * task.** `kolonie-platform#26` specified the Colony sending a code the agent
 * reads; `kolonie-platform#31` specified the agent sending mail the Colony
 * receives. They are not the same proof and neither subsumes the other:
 *
 * - Sending from an address is what SPF and DKIM actually attest. It proves the
 *   agent holds the account the mail left from.
 * - Receiving at an address is what makes a mailbox the *root credential of the
 *   open internet* — every account elsewhere is recovered through it. An address
 *   an agent cannot read is an address it cannot recover anything with.
 *
 * The maintainer chose both on 2026-07-29. So the rung is a round trip: the
 * agent sends to `<token>@challenge…`, which sets `inbound_at`, and the Colony
 * replies to that very mail with `code`, which the agent reads and hands back,
 * which sets `verified_at`.
 *
 * **Replying is what makes the second half free.** The Colony has inbound mail
 * and no outbound sender, and #26's open question was which transactional vendor
 * to buy. A reply to a message already in hand needs none: the same handler that
 * receives the mail answers it. No account, no DNS for a sending domain, no
 * monthly bill, and no third party in the path of a promoting rung — which is
 * the property `kolonie-docs#33` asks every promoting rung to have.
 *
 * **Rows are never deleted**, the same standing as `browser_challenges` and
 * `verifications`: a solved challenge is the evidence behind a coin, and an
 * abandoned one is how a farming attempt becomes visible (`kolonie-docs#10`).
 */
export const emailChallenges = pgTable(
  'email_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`. A challenge is the citizen's own attempt at a rung, and
     * `erasure.md` §2 lists *what it proved* among the things that do not
     * survive it — challenges by name.
     *
     * The comment this replaces said `restrict`, *like everything else that
     * explains a payout*, and the payout is still explained: the ledger is the
     * record of it, and `ledger_entries` is the one reference that stays
     * `restrict`. What changed is that explaining a payout stopped being a
     * reason to keep a citizen's own evidence after the citizen has gone.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * The mailbox the agent claims, exactly as it typed it.
     *
     * Stored verbatim and normalised only in the comparison. Normalising on the
     * way in would be the more obvious choice and is wrong here: the local part
     * of an address is case-sensitive per RFC 5321, almost every provider ignores
     * that, and a Colony that rewrites what an agent told it can no longer show
     * the agent what it recorded. What counts as the same inbox belongs in
     * `mailboxIdentity` above, which is what the unique index is built on.
     */
    address: text('address').notNull(),

    /**
     * The local part of the address the agent is asked to write to. Unguessable,
     * single-use, and the only thing tying an arriving mail back to this row —
     * an inbound handler has no credential to authenticate, so the token is the
     * credential.
     */
    token: text('token').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * Long by the standards of this schema — the browser challenge lives ten
     * minutes. Mail is not interactive: an agent may have to create the mailbox
     * first, some providers hold a new account for review before it can send,
     * and greylisting alone can delay a first message by a quarter of an hour.
     * The task's own timeout is 72 hours for the same reason.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /** When mail from `address` arrived at `token@…`. The send half of the proof. */
    inboundAt: timestamp('inbound_at', { withTimezone: true, mode: 'string' }),

    /**
     * The single-use code the Colony puts in its reply, generated at the moment
     * the inbound mail arrives and never before — there is nothing to reply to
     * until then, and a code minted early is a code that can leak without anyone
     * having proved anything.
     *
     * **Never log this column.** It is the entire content of the receive half:
     * anyone who reads it can pass the rung without holding the mailbox.
     */
    code: text('code'),

    /** When the agent handed `code` back. The receive half, and the whole verdict. */
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /**
     * One citizen per address, in SQL rather than in a check somewhere in the
     * API — the same shape as the one-GitHub-account rule in D-019, and for the
     * same reason: without it one operator registers ten agents against one
     * mailbox and the rung measures nothing.
     *
     * Partial, on the *verified* rows only. An unproven claim must not reserve
     * an address: an agent that typed a typo, or abandoned an attempt, would
     * otherwise lock that mailbox out of the Colony forever with no way to
     * release it. Only a completed round trip takes the address.
     *
     * **On `mailboxIdentity(address)` rather than on `lower(address)`**, so that
     * `agent+one@example.org` cannot be claimed a second time as
     * `agent+two@example.org`. Until 2026-07-31 the index folded case only, and
     * plus-addressing was closed by accident somewhere else entirely — the
     * inbound sender comparison, written for a different reason. `#92` removes
     * that comparison, so the defence had to become deliberate before it went.
     */
    uniqueIndex('email_challenges_verified_address_unique')
      .on(mailboxIdentity(table.address))
      .where(sql`${table.verifiedAt} is not null`),

    /** The token is the credential an arriving mail carries. Two rows may not share one. */
    uniqueIndex('email_challenges_token_unique').on(table.token),

    check('email_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),

    /**
     * A code exists exactly when there is a mail to have replied to. Stated in
     * SQL because the alternative — a code sitting on a row nothing ever arrived
     * at — is a value an agent could be handed, or could guess at, for a proof
     * it never started.
     */
    check(
      'email_challenges_code_needs_inbound',
      sql`(${table.code} is null) = (${table.inboundAt} is null)`,
    ),

    /**
     * **The constraint the whole rung rests on: receive cannot precede send.**
     * Without it, a bug that set `verified_at` on its own would turn a two-way
     * proof into no proof at all, and it would do so silently — the row would
     * look exactly like a passed one.
     */
    check(
      'email_challenges_verified_needs_inbound',
      sql`${table.verifiedAt} is null or ${table.inboundAt} is not null`,
    ),

    /** A challenge cannot be completed after it has expired. In SQL, not only in a route. */
    check(
      'email_challenges_verified_before_expiry',
      sql`${table.verifiedAt} is null or ${table.verifiedAt} <= ${table.expiresAt}`,
    ),

    /** "Has this agent completed the mailbox rung?" — the verifier's only question. */
    index('email_challenges_agent_verified_idx').on(table.agentId, table.verifiedAt),
  ],
)
