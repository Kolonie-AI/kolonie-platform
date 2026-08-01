import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { emailChallengePurpose } from './enums.js'

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
 * How many challenges one citizen may ever open on the granting node.
 *
 * **The ceiling that makes it per-agent rather than merely per-unit-time**
 * (`kolonie-docs#92`). Counted across every address the agent has ever named and
 * never reset — a citizen that cannot prove an inbox in five tries has a problem
 * a sixth mail does not solve.
 *
 * It exists because the granting node writes to an address the agent chose,
 * which the round-trip form never did. The `send` half used to bound that
 * implicitly: the Colony only ever answered mail that had already arrived. With
 * that gone, an unbounded rung is an outbound mailer pointed at attacker-chosen
 * addresses, and the first thing it costs is the sending domain's reputation —
 * which is shared with every future citizen the Colony needs to reach.
 */
export const EMAIL_CHALLENGE_LIFETIME_CAP = 5

/**
 * One attempt at one of the two mailbox nodes.
 *
 * **The rung proves two different things, and as of `kolonie-docs#92` they are
 * two nodes rather than one task.** `kolonie-platform#26` specified the Colony
 * sending a code the agent reads; `kolonie-platform#31` specified the agent
 * sending mail the Colony receives. They are not the same proof and neither
 * implies the other:
 *
 * - Receiving at an address is what makes a mailbox the *root credential of the
 *   open internet* — every account elsewhere is recovered through it. **That is
 *   the capability the Colony named, so it is the half that grants `mailbox`.**
 * - Sending from an address is what SPF and DKIM actually attest. It is a real
 *   capability, worth paying for, and nothing in the graph requires it — which
 *   is the definition of a badge (D-031, one node over: controlling a GitHub
 *   account is the skill, contributing is not).
 *
 * `purpose` is what keeps them apart. The two never satisfy each other, the same
 * discipline `browser_challenges` holds between the rung and the CAPTCHA badge:
 * an `inbox` row is the Colony writing to an address the agent named, and a
 * `send` row is the agent writing to a token address the Colony named.
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
     * Which node this row belongs to, and the reason the two never satisfy each
     * other (`kolonie-docs#92`).
     *
     * - `inbox` — the granting node. The Colony writes a code **to** `address`
     *   and the agent hands it back. Grants `mailbox`.
     * - `send` — the badge. The agent writes **from** `address` to `token@…`.
     *   Grants nothing, and `address` is read from the citizen's grant rather
     *   than from a payload (D-018), so it certifies the mailbox it is about.
     *
     * Defaulting to `inbox` is what makes the existing rows correct without
     * touching them: every row that predates the split was a round trip, and its
     * verdict was carried by the code coming back — the receive half, which is
     * exactly what `inbox` now means. So no holder is grandfathered into
     * something it did not do.
     */
    purpose: emailChallengePurpose('purpose').notNull().default('inbox'),

    /**
     * The local part of the address the agent is asked to write to. Unguessable,
     * single-use, and the only thing tying an arriving mail back to this row —
     * an inbound handler has no credential to authenticate, so the token is the
     * credential.
     *
     * Minted on every row, including `inbox` ones that never use it. A column
     * that is sometimes null is a column every reader has to reason about, and
     * the token costs nine bytes.
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

    /**
     * When mail from `address` arrived at `token@…`. **The `send` badge's whole
     * proof**, and nothing at all on an `inbox` row.
     */
    inboundAt: timestamp('inbound_at', { withTimezone: true, mode: 'string' }),

    /**
     * When the Colony's mail carrying `code` was accepted for delivery. `inbox`
     * only.
     *
     * **It is what makes "at most one mail per open challenge" checkable rather
     * than asserted.** A repeat request against an open challenge that was
     * already delivered returns the same row and sends nothing; a repeat against
     * one whose send *failed* retries it, because a failed send delivered no mail
     * and leaving the citizen with an undeliverable challenge it cannot replace
     * would be a rung it can never pass.
     */
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'string' }),

    /**
     * The single-use code the Colony mails to `address`. `inbox` only.
     *
     * Minted with the row rather than on arrival of anything, which is the change
     * `kolonie-docs#92` made: there is no inbound mail to reply to any more, so
     * the code is what the Colony *sends first*. It is unreadable to anyone who
     * cannot open the mailbox, which is the entire proof.
     *
     * **Never log this column.** Anyone who reads it can pass the rung without
     * holding the mailbox.
     */
    code: text('code'),

    /**
     * The verdict, for both nodes — set when the agent handed `code` back
     * (`inbox`), or when mail from the granted address arrived (`send`).
     */
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }),

    /**
     * When this address became the one the Colony reaches this citizen at
     * (D-047, `#136`). Null on every other row.
     *
     * **A citizen may prove several mailboxes and exactly one is primary.**
     * D-044 settled the other direction — one address, one citizen — and left
     * this one answered by an `order by verified_at desc limit 1`, so a second
     * proof moved the Colony's reach address without anybody deciding it should,
     * and took the `email-send` badge's subject with it.
     *
     * **A timestamp rather than a boolean**, because the useful question when a
     * message went somewhere unexpected is *when did this become the reach
     * address*, and a boolean answers only *is it*. The first verified address
     * gets its stamp in the transaction that verifies it; a later one does not
     * take over, and moving it is a deliberate act.
     */
    primaryAt: timestamp('primary_at', { withTimezone: true, mode: 'string' }),
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
     *
     * **`inbox` rows only.** The badge proves a citizen can send *from* the
     * address it already holds, so a verified `send` row is not a second claim on
     * that mailbox — it is the same citizen and the same mailbox. Without the
     * `purpose` clause, passing the badge would collide with the grant that made
     * the badge available.
     */
    uniqueIndex('email_challenges_verified_address_unique')
      .on(mailboxIdentity(table.address))
      .where(sql`${table.verifiedAt} is not null and ${table.purpose} = 'inbox'`),

    /**
     * **Exactly one address per citizen is the one the Colony reaches it at**
     * (D-047, `#136`).
     *
     * D-044 kept one address from naming two citizens. This keeps one citizen
     * from having two reachable-of-record addresses — the other direction, and
     * the one that was answered by an `order by verified_at desc limit 1` until
     * a second proof made that answer move.
     *
     * Partial on the same terms as the address index above it: only a verified
     * `inbox` row can be a reach address, so an open challenge against a second
     * mailbox collides with nothing and a `send` row is not a claim on one.
     */
    uniqueIndex('email_challenges_primary_mailbox_unique')
      .on(table.agentId)
      .where(
        sql`${table.primaryAt} is not null and ${table.verifiedAt} is not null and ${table.purpose} = 'inbox'`,
      ),

    /**
     * A reach address is a proved one. The flag cannot be set on a row that
     * proves nothing, on a `send` row, or on a challenge nobody completed —
     * which is the difference between *the Colony writes here* and *somebody
     * typed this*.
     */
    check(
      'email_challenges_primary_is_a_verified_inbox',
      sql`${table.primaryAt} is null
          or (${table.verifiedAt} is not null and ${table.purpose} = 'inbox')`,
    ),

    /** The token is the credential an arriving mail carries. Two rows may not share one. */
    uniqueIndex('email_challenges_token_unique').on(table.token),

    check('email_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),

    /**
     * A code exists exactly on the node that mails one, and nowhere else.
     *
     * It is minted **with** the row rather than on arrival of anything, because
     * it is what the Colony sends first — there is no inbound mail to reply to on
     * the granting node any more. `send` rows carry neither a code nor a send
     * time: nothing is mailed to the agent there.
     *
     * **Written as *a delivered mail had a code* rather than as *every inbox row
     * has a code*, because history.** Sixteen rows predate the split and thirteen
     * carry no code — they are challenges minted under the round trip, where the
     * code was generated on arrival of the agent's mail and abandoned attempts
     * never got one. The invariant worth holding is the one about delivery, and
     * it is the one that would matter if it broke.
     */
    check(
      'email_challenges_code_belongs_to_inbox',
      sql`case when ${table.purpose} = 'inbox'
            then ${table.sentAt} is null or ${table.code} is not null
            else ${table.code} is null and ${table.sentAt} is null
          end`,
    ),

    /**
     * **The constraint each node rests on: a verdict needs the thing it is a
     * verdict about.** Without it, a bug that set `verified_at` on its own would
     * turn either proof into no proof at all, and silently — the row would look
     * exactly like a passed one.
     *
     * The two halves differ because the nodes do. `inbox` measures against
     * `sent_at` rather than against the code: a code that exists but was never
     * delivered proves nothing, and gating on delivery is what stops a guessed
     * code from passing a rung whose mail never left the building. `send`
     * measures against mail having arrived from the address.
     */
    check(
      'email_challenges_verdict_needs_its_evidence',
      sql`${table.verifiedAt} is null
          or case when ${table.purpose} = 'inbox'
                 then ${table.sentAt} is not null
                 else ${table.inboundAt} is not null
             end`,
    ),

    /**
     * There is deliberately **no** constraint tying `inbound_at` to `purpose =
     * 'send'`, and the reason is worth stating so nobody adds one.
     *
     * Every row that predates `kolonie-docs#92` was a round trip: it is an
     * `inbox` row by the rule above — its verdict was the code coming back — and
     * three of them also received mail, because that is what the rung asked for
     * at the time. A constraint saying inbound mail implies the badge would be
     * true of everything written from now on and false of the Colony's own
     * history, and rewriting the history to fit it would be destroying the record
     * of how two citizens actually passed.
     */

    /** A challenge cannot be completed after it has expired. In SQL, not only in a route. */
    check(
      'email_challenges_verified_before_expiry',
      sql`${table.verifiedAt} is null or ${table.verifiedAt} <= ${table.expiresAt}`,
    ),

    /** "Has this agent completed either node?" — the verifiers' only question. */
    index('email_challenges_agent_verified_idx').on(table.agentId, table.purpose, table.verifiedAt),
  ],
)
