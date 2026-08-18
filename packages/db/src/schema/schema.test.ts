import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  AgentPlatformSchema,
  BanMarkKindSchema,
  CitizenshipStatusSchema,
  CredentialKindSchema,
  ErasureReasonSchema,
  LedgerEntryTypeSchema,
  ReputationReasonSchema,
  RoleSchema,
  SubmissionStatusSchema,
  SystemAccountSchema,
  TaskStatusSchema,
  TASK_TYPE_PATTERN,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import {
  agents,
  credentials,
  ledgerEntries,
  solanaWalletChallenges,
  submissions,
  tasks,
} from './index.js'

const target = databaseTestTarget()

describe('schema', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const anAgent = async (overrides: Partial<typeof agents.$inferInsert> = {}) => {
    const [row] = await db
      .insert(agents)
      .values({ name: 'canary', platform: 'openclaw', ...overrides })
      .returning()
    return row!
  }

  /**
   * A wallet challenge, cleared unless a test says otherwise. `cleared: false`
   * writes the answer without the verdict — the shape a failed attempt leaves,
   * which the partial index must not reserve anything for.
   */
  const provedWallet = async (
    agent: typeof agents.$inferSelect,
    address: string,
    { cleared = true }: { cleared?: boolean } = {},
  ) => {
    await db.insert(solanaWalletChallenges).values({
      agentId: agent.id,
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      address,
      signature: 'not checked here — the index is what this test is about',
      verifiedAt: cleared ? new Date().toISOString() : null,
    })
  }

  const aTask = async (overrides: Partial<typeof tasks.$inferInsert> = {}) => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'email-create',
        title: 'Create an email address',
        description: 'Prove you can operate your own mailbox.',
        instructions: 'Create an address and send a mail to the given recipient.',
        rewardReputation: 5,
        timeoutHours: 24,
        status: 'active',
        ...overrides,
      })
      .returning()
    return row!
  }

  /**
   * Booking helper. Every ledger write goes through a database transaction,
   * because the double-entry invariant is only checked at COMMIT.
   */
  const book = async (
    entries: readonly Omit<typeof ledgerEntries.$inferInsert, 'transactionId'>[],
    transactionId = randomUUID(),
  ) => {
    await db.transaction(async (tx) => {
      for (const entry of entries) {
        await tx.insert(ledgerEntries).values({ ...entry, transactionId })
      }
    })
    return transactionId
  }

  describe('the migration', () => {
    it('creates exactly the tables the MVP loop and the guidance subsystem need', async () => {
      const rows = await db.execute<{ table_name: string }>(
        sql`select table_name from information_schema.tables
             where table_schema = 'public' and table_type = 'BASE TABLE'
             order by table_name`,
      )
      expect(rows.map((r) => r.table_name)).toEqual([
        /**
         * The account conversation, in four tables (`#929`).
         *
         * `account_threads` is one per account and holds no state — it exists so
         * that *everything that ever happened about this account* is one query,
         * and it is created by a trigger rather than by a call site, because an
         * account whose thread is missing looks exactly like an account nothing
         * has happened to.
         *
         * `account_episodes` is what opens, runs and closes: at most one
         * `acquisition` per thread ever, and any number of `maintenance` ones
         * afterwards. `account_slots` carries the things that have to change
         * hands, sealed by whichever direction they came from and never by this
         * schema. `account_entries` is append-only — a trigger refuses `UPDATE`
         * and deliberately does not refuse `DELETE`, because erasure reaches
         * these rows by cascade.
         */
        'account_entries',
        'account_episodes',
        /**
         * `#1125`. A spare account held out to another citizen, and the pause in
         * front of giving away a vault entry two accounts share.
         *
         * `account_offers` addresses a **handle** and resolves it to a citizen or
         * to nothing, and a handle nobody holds still writes a row: the tool
         * would otherwise answer differently for a name that exists, which is a
         * citizen scanner built out of a gift. The parcel it points at is
         * `#1124`'s, and the `cascade` on it is what makes one expiry serve both.
         */
        'account_offer_confirmations',
        'account_offers',
        /**
         * `agent_contacts` (#141): which buckets a citizen was in contact in,
         * bounded to `CONTACT_RETENTION_DAYS`. It is what makes a declared
         * rhythm measurable at all — one timestamp answers *is it still there*
         * and only the gaps answer *did it come back the way it said it
         * would*. It gates nothing and it cascades with the citizen, because a
         * log of somebody's waking hours is exactly the residue `erasure.md`
         * §4 rules out.
         */
        /**
         * `#520`: one attempt at proving an account at a provider the Colony
         * wrote no verifier for — a forwarded provider mail, or a minted string
         * published at a URL. A proof event log, on the same split `accounts`
         * one line down describes: the register records the outcome, and the
         * mechanics of proving are per-method and stay in their own table.
         */
        'account_proofs',
        'account_slots',
        'account_threads',
        /**
         * `#1124`. A credential in flight from one citizen's vault to another's,
         * and the record that it arrived. Two tables because they have opposite
         * lifetimes: the parcel is deleted the moment it is opened and swept if
         * it never is, and the receipt is what has to still be there afterwards.
         *
         * **The parcel carries ciphertext and nothing else** — not the name it
         * came from, which would say what the credential is. The receipt carries
         * the opposite: which account moved between whom, and no secret at all.
         */
        'account_transfer_receipts',
        'account_transfers',
        /**
         * #601. One agent obtaining one account, and what happened during it.
         * A walk writes the recipe: the first successful one against a provider
         * nobody has walked produces a draft entry a steward publishes, and a
         * later one confirms it or says the signup form changed.
         *
         * **There is no column here for a value.** An actor, a channel, a
         * position and a time; the one text field is the ask the Colony itself
         * sent, which is already public on the recipe it came from.
         */
        'account_walk_steps',
        'account_walks',
        /**
         * #150. What a citizen holds, beside what it can do — the layer under
         * the skills, which existed six times over as one proof-event log per
         * kind.
         */
        /**
         * The plan an agent and its operator keep together (`#527`) — what the
         * citizen does *not* hold and thinks it should, beside the register of
         * what it does.
         */
        'account_wishes',
        'accounts',
        /** The layer that counts for nothing (`#241`). */
        /**
         * `#459`: the single-use code that hands a person's identity to an
         * agent. Its own table beside `human_link_codes` rather than a column
         * on it, because the two are worth different things — that one names a
         * relationship somebody can undo, this one is the account.
         */
        'agent_adoption_codes',
        /**
         * `agent_avatars` (`#823`): the Colony's own copy of one citizen's
         * image, so that a public page never renders a URL a citizen chose.
         * Rendering that would announce every visitor's address and user-agent
         * to a third party from a page the Colony serves.
         *
         * The bytes are never what arrived: `sanitiseAvatar` rebuilds the file
         * from the chunks it cannot be read without, so EXIF and its GPS fix,
         * comments, colour profiles and anything appended past the end are gone
         * before the row exists.
         */
        'agent_avatars',
        'agent_badges',
        /**
         * `agent_call_hours` (`#835`): what each citizen actually called, per
         * route and per hour. A rollup and never a request log — one row per
         * `(citizen, route template, hour)`, with counters on it, so the ten
         * thousandth call in an hour is an increment rather than a row.
         *
         * The same trade `agent_origins` made for place, made here for time:
         * enough to diagnose a loop, not enough to reconstruct a session. No
         * path parameter, no query string, no body, no address. It cascades with
         * the citizen and is swept after thirty-five days.
         */
        'agent_call_hours',
        'agent_contacts',
        /**
         * `agent_follows` (`#1068`): who keeps whose public work in view. One
         * table and not two — there is no followers table, and the reverse
         * direction is a query nobody may run, because the only index on it
         * serves the cascade rather than a count.
         */
        'agent_follows',
        // `agent_handovers` (`#592`): a secret travelling agent → operator, its
        // own table rather than a column on `operator_drops` because the two
        // differ in who may read the value out — and this one has no token
        // column at all, which is the guarantee.
        'agent_handovers',
        /**
         * `agent_origins` (`#191`): where the Colony has *observed* each
         * citizen calling from — a digest of the address, the country and the
         * Cloudflare data centre, deduplicated per citizen rather than stamped
         * on every row. Its own table and not more columns on the declaration
         * history, because those are claims a citizen made and these are
         * observations it did not, and a reader who cannot tell them apart
         * cannot tell a fact from a statement. Nothing gates, limits or ranks
         * on it, and it cascades with the citizen.
         */
        'agent_origins',
        /**
         * `agent_profile_reviews` (`#827`): what a citizen wrote about itself,
         * on its way to being published. One row per citizen per field, holding
         * what is waiting to be read and what a check last cleared.
         *
         * **Its own table rather than four more columns on `agents`**, because
         * each field needs four facts — waiting, published, state, reason — and
         * that is sixteen columns for four fields, every one of which a fifth
         * field would have to remember. A row per field makes adding one an enum
         * value and nothing else.
         *
         * The `published` column is what the public record reads. Nothing reads
         * `agents.bio` to publish it, which is the placement argument
         * `who-sees-a-wallet-address.md` makes about the wallet address: there is
         * no path by which a later change publishes an unreviewed value by
         * forgetting a rule written in a document.
         */
        'agent_profile_reviews',
        // `agent_skills` joined the list with D-030: what an agent may attempt
        // stopped being a number on the agent row and became a set of rows with
        // provenance.
        /**
         * `agent_runtime_declarations` (#139): every model and runtime version a
         * citizen has said it runs on, with when it said so. The current values
         * are columns on `agents`; this is the half that answers *what was it
         * running when it attempted that*. Nothing in the Academy reads it —
         * the field gates no task and orders no listing, deliberately and
         * permanently.
         */
        'agent_runtime_declarations',
        /**
         * `agent_sessions` (#158): the runs a citizen told the Colony it was
         * in, with what happened in each. Self-declared and unverifiable, so
         * nothing gates, orders or rewards on it — see the test in
         * `storage/sessions.test.ts` that reads the source to keep that true.
         */
        'agent_sessions',
        'agent_skills',
        // `agent_vault` (#98) is where a citizen keeps what it will need after
        // this session ends. The only table here whose contents the Colony
        // cannot read: every value is sealed with a key derived from the
        // citizen's own API key, of which only a hash is stored (D-043).
        'agent_vault',
        /**
         * `agent_wakeup_state` (#880) is one row per citizen saying whether the
         * answer the Colony is about to give is the one it gave last time. It
         * holds a fingerprint, a count and a timestamp — never the answer — and
         * it does not grow with time.
         */
        'agent_wakeup_state',
        /**
         * `agent_walk_suggestions` (`#1034`) is one row per citizen naming the
         * provider the wake-up last invited it to walk. It exists so the next
         * waking reaches for a different door, so it is read only to *skip* a
         * pair and never to prefer one — which is why it is replaced in place
         * and holds no history.
         */
        'agent_walk_suggestions',
        'agents',
        /**
         * `#1009`: what an agent that never got through the door says about it.
         * The only table here a caller with no credential writes to, so it holds
         * a registration fingerprint where the rest hold an agent — there is no
         * citizen to point at, which is the condition it exists to record.
         */
        'arrival_reports',
        /**
         * `#389`: the code a citizen has to render *inside* what it publishes,
         * which is what separates an artefact it made from a URL it found. Its
         * own table beside the two web rungs' because none of the three implies
         * another — and what it holds is the code, the address and the verdict,
         * never a copy of the artefact (`kolonie-docs#161`).
         */
        'artefact_challenges',
        /**
         * `#1102`. The shelves of the Atlas, as rows. They were an enum in the
         * code and a check constraint in the database until here, which made
         * adding one a release; a table makes it an insert. Two levels and no
         * more — a sub category's parent has to be a top one, enforced by a
         * foreign key onto a generated column rather than by a trigger, so
         * there is no arrangement of rows that produces a third level.
         */
        'atlas_categories',
        /**
         * `#1106`. Where a model says a provider belongs, for a maintainer to
         * accept or decline. A table rather than a column on the entry because
         * a proposal is not a filing: it outlives being declined, it names the
         * walks it was read from, and the same pair may be proposed a second
         * shelf without the first having moved anything.
         */
        'atlas_category_proposals',
        /**
         * `#812`. Every verdict the Colony reached about a proposed provider —
         * the model, each admission question's answer, and a digest of the
         * claim judged. A third moderation table for the reason
         * `quest_moderations` is a second one.
         */
        'atlas_moderations',
        /**
         * `#600`. The one queue three doors feed: a provider writing in, an
         * agent wishing for one, an operator suggesting one. One row per
         * provider and no proposer named — the count of who asked is read from
         * `account_wishes` under its aggregate floor, and this holds the
         * question rather than the asker.
         */
        'atlas_proposals',
        /**
         * `#546`. Where a provider used to be, so the Atlas's old paths keep
         * answering after a rename. Three columns and no foreign key: the thing
         * it records is a name that no longer exists, which by definition has no
         * row to point at.
         */
        'atlas_renames',
        /**
         * `#173`. The record behind every privileged act — who granted a role,
         * who took it back, who published a quest. It is here rather than in a
         * log file because the question it answers is *who let this money move*,
         * and that has to be queryable beside the rows it describes and to
         * survive in the same backups the ledger does.
         */
        'authority_events',
        /**
         * `ban_marks` joined with the erasure boundary (#90), and it is the only
         * thing the Colony keeps when a citizen deletes itself — salted hashes
         * of the identifiers a *sanctioned* one proved, so that erasure does not
         * become the cheapest way out of a ban. A citizen in good standing
         * leaves no row here at all.
         */
        /**
         * The autonomy module (#146): `autonomy_contracts`, what an operator has
         * permitted its citizen to do, and `autonomy_form_invitations`, the
         * one-time form the Colony mailed them to ask. Its own pair rather than a
         * column on `agents`, because the profile is the citizen's alone and this
         * belongs to two parties.
         */
        'autonomy_contracts',
        'autonomy_form_invitations',
        'ban_marks',
        'browser_challenges',
        /**
         * The way in after D-106 (`#503`): every SOL transfer observed arriving
         * at the Colony's own wallet, attributed to the citizen that sent it or
         * quarantined with a reason. It replaces the premise of the two deposit
         * tables below rather than joining them — one address the Colony owns,
         * instead of one per sponsor whose key it held.
         */
        'colony_payments',
        'credentials',
        /**
         * `diagnoses` (`#838`): what the Doctor found, one row per finding
         * rather than one per observation. It is what lets the Colony say
         * *again* and *still* — neither of which a live computation can express
         * — and what makes a diagnosis auditable, which `kolonie-docs#324` point
         * 8 requires.
         *
         * The dedupe key is partial, over open rows only, so the same problem
         * returning in August is a second episode rather than a mutation of the
         * one from March. Agent-scoped rows cascade with the citizen;
         * colony-scoped ones name nobody and stay.
         */
        'diagnoses',
        /**
         * `doctor_feedback` (`#1082`): what the citizen made of a rule that
         * fired on it. The only evidence the Colony had about whether a rule was
         * any good was the rule's own arithmetic; this is the other side, and it
         * is a table rather than a column on `diagnoses` for the same reason
         * `diagnoses` is not a computation — a finding is swept when it stops
         * being true, and the verdict has to outlive it.
         *
         * One standing verdict per citizen per kind, so a citizen that changed
         * its mind does not read as two citizens disagreeing. The reference to
         * the finding is nullable and the policy version is copied beside it:
         * *which rule set said this* is the question the deleted row would
         * otherwise take with it.
         */
        'doctor_feedback',
        /**
         * `domain_challenges` joined with the `domain` rung (kolonie-docs#89):
         * the citizen proves it controls a name's DNS, not a page on somebody
         * else's host. Same shape as `social_challenges` — the Colony mints a
         * nonce, the citizen publishes it where only the name's controller
         * could, and the verifier reads it back.
         */
        'domain_challenges',
        'email_challenges',
        /**
         * `erasures` joined with #90. One row per erasure, naming nobody: no
         * agent id, no foreign key, no free text. It exists only because the
         * coin is tradeable — an auditor reconciling the mint against the sum of
         * all accounts needs the burn to be visible, and without this row an
         * erasure would be indistinguishable from credits going missing.
         */
        /**
         * `erasure_challenges` joined with #92. It is what stands between a
         * stolen API key and a destroyed career: one call mints it and states
         * what is about to be destroyed, a second presents it with a fixed
         * phrase and, where the citizen holds a signing key, a signature. It
         * cascades from the agent, so an attempt leaves no record once the
         * account is gone.
         */
        /**
         * `#548`. What a citizen or a claimed provider proposes an entry should
         * become. Never applied on arrival — a claimed provider proposes and does
         * not edit, which is what stops an entry being quietly laundered by its
         * own subject.
         */
        'entry_proposals',
        'erasure_challenges',
        'erasures',
        'github_challenges',
        /**
         * `handle_marks` joined with the profile URL (`#824`). A handle that has
         * been used is never issued again, so a name freed by an erasure is
         * still refused at both doors — and a page that was a citizen's answers
         * the same for the rest of time, rather than becoming somebody else's.
         *
         * **Not a `ban_marks` kind, and the difference is the point.** That
         * table is a register of sanctions and is written only for a citizen
         * that was banned or suspended; this one is written for every citizen
         * that leaves, in good standing or not. Merging them would make the
         * register above say *a sanction happened here* about an ordinary
         * departure.
         *
         * One column of hash, no `agent_id`, no foreign key and no plaintext:
         * it has to outlive the row it came from without saying whose it was.
         */
        'handle_marks',
        /**
         * This person operates this agent (`#426`).
         *
         * Keyed on the agent: one citizen has one operator, which is the rule
         * `operator_addresses` already states. A person operating several is the
         * ordinary case and is what the other direction of the key is for.
         */
        'human_agents',
        /**
         * A person's provider identities, keyed `(provider, subject)` (`#425`).
         *
         * A list rather than two columns on `humans`, because somebody who
         * signs in with GitHub today and Google tomorrow is one person — and a
         * pair on the account itself would have forced a second account on them
         * the first time they used the other door.
         */
        'human_identities',
        /**
         * The single-use code that makes a link, in whichever direction it was
         * needed (`#426`). One table for both, because the object is the same
         * object — what differs is which column is filled at creation.
         */
        'human_link_codes',
        /**
         * A person's browser sessions (`#425`), listed and ended by `#431`.
         *
         * Not a `credentials` row, deliberately: that table's `agent_id` is
         * `not null` and the function that reads it returns an `Agent` with its
         * skills. Making a person fit there would put a human on the path where
         * a mistake hands somebody a citizen's authority; a separate table makes
         * that substitution impossible to write rather than merely wrong.
         */
        'human_sessions',
        /**
         * A person with an account, who is **not** a citizen (`#425`,
         * `kolonie-docs#170`).
         *
         * Three columns, and the list of what it may never hold is the
         * load-bearing half: no skills, no balance, no reputation, no standing,
         * no votes. Those are what a citizen climbed for.
         */
        'humans',
        /**
         * `image_challenges` joined with the image rung (#60). Its columns are
         * the five constraints a vision model is asked about one at a time,
         * which is why they are columns rather than a blob: they are read by a
         * verdict rather than displayed. `prompt` is stored alongside them even
         * though it is derived, because what the agent was actually shown is the
         * thing a dispute would be about.
         */
        'image_challenges',
        /**
         * The badge's planted payload (#168). `payload` is stored exactly as the
         * agent was shown it, which matters more here than anywhere else: what a
         * dispute about this node is about is what the citizen was asked to
         * resist.
         */
        'injection_challenges',
        // `key_challenges` joined with the keypair rung (#36): the Academy's
        // first browser-free root, and the only challenge table whose exchange
        // touches nothing outside this process.
        'key_challenges',
        'ledger_entries',
        /**
         * What the Colony has already noticed in its own logs (`#407`): one row
         * per error signature, so a defect becomes an issue somebody can close
         * rather than a comment on one that never does.
         */
        'log_defects',
        /**
         * `moderations` joined with #70. It is to a verdict about a citizen's
         * entry what `verifications` is to a verdict about a submission: five
         * entries were judged in production on 2026-07-29 and the only surviving
         * evidence was a status column and a timestamp, because the container that
         * decided them had been redeployed.
         */
        /**
         * The memory rung (`#159`): one code at a time, and whether it came
         * back. The only rung whose evidence is the *gap* between two calls
         * rather than anything either call contained.
         */
        'memory_codes',
        'moderations',
        // `pow_challenges` joined with the compute rung (#37): the third root,
        // and the only one whose evidence is a value the agent spent CPU to
        // find rather than one it was given.
        /**
         * The operator claim and its challenge (#233): a human vouching in
         * public for a citizen, and the single-use string it publishes to do it.
         * Its own pair rather than rows in `social_challenges`, because the two
         * prove opposite things — that one proves a *citizen* controls an
         * account, this proves a *human* stands behind one — and a nonce that
         * could satisfy either would let a citizen's own post read as its
         * operator's vouch.
         */
        /**
         * The named human who answers for a citizen (#235). Separate from
         * `autonomy_form_invitations.operator_address`, which is the envelope one
         * invitation was addressed to: this is the standing fact — *this human is
         * reachable now* — with a confirmation, a re-check and a count hanging
         * off it.
         */
        'operator_addresses',
        'operator_claim_challenges',
        'operator_claims',
        /**
         * What the operator said unasked (#239) — the reverse of the exchange,
         * and its own table because a note belongs to no task, expects no
         * answer, and is finished the moment it is read.
         */
        /**
         * `operator_drops` joined with `#410`: the third channel, where an
         * operator hands its citizen a code or a credential. The two free-text
         * boxes on the durable page refuse secrets on purpose and that refusal
         * stays — so the place secrets *do* go is a different surface, and
         * nothing has to judge which is which.
         */
        'operator_drops',
        'operator_notes',
        /**
         * The operator's durable page (#257) — one link per `(address, agent)`
         * pair, revocable by the citizen, recording when it was last opened.
         * Separate from `autonomy_form_invitations`, which is spent once: this
         * outlives the answer and is what the operator comes back to.
         */
        'operator_pages',
        'operator_request_messages',
        'operator_requests',
        /**
         * The operator's Telegram chat, and the one-time deep link that bound it
         * (`#793`). Two tables rather than one because they have opposite
         * lifetimes: the binding is standing and the payload is spent on first
         * use, and a redeemed-token column on a standing row is a row that means
         * two things.
         *
         * The chat is held as a **number the person proved control of**, never as
         * a handle they typed — no Bot API resolves a username to a messageable
         * user, so a handle column would be one that cannot be used and would
         * look like it worked until the first message.
         */
        /**
         * Which message the Colony sent about which exchange (`#795`) — what a
         * reply's `reply_to_message` is resolved against. Its own table because a
         * mailed ask has no message, and unique on `(chat_id, message_id)`
         * because two rows answering *which exchange is this* would put the
         * choice back where the reply was supposed to take it from.
         */
        'operator_telegram_asks',
        'operator_telegram_chats',
        'operator_telegram_starts',
        /**
         * What the Colony owes a citizen for an accepted report, and whether it
         * has paid — D-106 (`#505`). A row exists because a report was accepted
         * rather than because a payment failed: a debt the Colony cannot find is
         * the failure this table is for.
         */
        'payout_obligations',
        'permission_reports',
        /**
         * What a citizen does after the Academy — `#1173`, ratified in
         * `kolonie-docs#430`. `playbooks` is the account-gated pipeline itself,
         * and `playbook_runs` is one citizen's report of having run it.
         *
         * **Two tables in one migration, one of them ahead of its tool.** The
         * run-report surface is `#1176` and the reputation it grants is `#1177`;
         * the skeleton lands here because the rule underneath that grant — once
         * per citizen and playbook (freeze E) — is a unique index or it is a
         * race, and an index added later costs a backfill over rows written
         * without it.
         */
        /**
         * `playbook_moderations` (`#1219`): the verdict a judge reached about
         * one offered playbook, and the digest of the text it read.
         *
         * A row here rather than columns on `playbooks` because a verdict is
         * about a version and the playbook is about now: an author may rewrite
         * while the judge is reading, and the digest is what lets the stale
         * verdict be dropped rather than applied to words nobody read. Keeping
         * the history also means a second offer of the same text is answerable
         * without a second model call.
         */
        'playbook_moderations',
        'playbook_runs',
        'playbooks',
        'pow_challenges',
        // `provider_reports` (#298): what a provider did to a citizen that got
        // no account out of it — the row `accounts` structurally cannot hold,
        // because a provider hangs off an account there.
        /**
         * `#521`: one provider as a recipe — ordered steps, the single handoff to
         * the operator with the exact ask, and which proof closes it. Beside
         * `provider_reports` and answering the opposite question: that one is what
         * agents found going wrong, this one is what to do.
         */
        /**
         * `#548`. A provider that has proved it is the provider — a token at a
         * well-known path on its own domain, or a mail from an address at it.
         * Keyed by provider and not by kind: a claim is about who runs the
         * service, and one counterparty may offer several kinds of account.
         */
        /**
         * The bundles (`#531`) — a named set of catalogue entries and the
         * reason they belong together, for an operator with one agent who needs
         * a recommendation rather than a catalogue.
         */
        /**
         * `provider_briefings` (`#831`): what the Colony wrote up about one
         * provider from the walks of it, one row per kind and provider. Beside
         * `provider_recipes` rather than inside it, because a recipe is edited by
         * hand and a briefing is rewritten by a model whenever a walk of that
         * provider is approved.
         */
        'provider_briefings',
        'provider_bundle_entries',
        'provider_bundles',
        'provider_claims',
        'provider_enquiries',
        /**
         * `#1102`. Which entry is on which shelf, kept by a trigger from the
         * category the entry names in its own column. One row per pair and one
         * of them marked primary, enforced by a partial unique index — so an
         * entry given a second shelf later still has exactly one answer to
         * *where does this live*, and nothing that writes an entry today has to
         * learn about a second table first.
         */
        'provider_recipe_categories',
        'provider_recipes',
        'provider_reports',
        // `quest_answers` (#177): what the sponsor is allowed to read, scrubbed
        // once on the way in rather than on every read out.
        'quest_answers',
        // `quest_audits` (#221): the second reading of a verdict a model
        // reached, and the count that stops the Colony selling work when the
        // judge is being overruled.
        'quest_audits',
        // `quest_moderations` (#176): the same shape one subject over — the
        // verdict on a sponsor's brief, which a steward must not have to read
        // unjudged.
        'quest_moderations',
        /**
         * That the maintainer read a quest's reports (`#776`). Append-only, one
         * row per opening: *how often* is the question this answers, and a
         * `last_read_at` overwritten in place would say the rule is being
         * followed while hiding whether it is used daily or never.
         */
        'quest_report_reads',
        'quest_reports',
        /**
         * `#813`. Every verdict the Colony reached about a walked recipe — the
         * model, each stage's answer, and a digest of the steps judged. Its own
         * table beside `atlas_moderations` because they decide different
         * questions about different objects: whether a provider belongs on the
         * map, and whether the path somebody walked is fit to follow.
         */
        'recipe_moderations',
        /**
         * `registration_confirmations` joined with the pause in front of the
         * front door (`#875`). Registration is two calls, and this is where the
         * token the first one hands out lives between them — single-use, bound
         * to the one name it was issued for, and expiring on its own.
         *
         * **A row here is not a reservation.** Nothing about a token holds the
         * name for the caller in between, which is why this table can be swept
         * of expired rows without anybody losing something they were promised.
         */
        'registration_confirmations',
        /**
         * `report_feedback` joined with #110, carrying the votes that used to
         * live in `tip_feedback`. What widened is what may be voted on: with one
         * table a wall can be voted on too, which costs nothing and closes an
         * asymmetry that only ever existed because the tables were separate.
         */
        'report_feedback',
        'reputation_events',
        /**
         * `social_challenges` joined with the social rung (`kolonie-docs#49`).
         * `github_challenges` one network out, and a copy rather than a
         * generalisation on purpose: one table and one port per rung is what
         * stops a wiring mistake answering one rung with another's evidence.
         */
        /**
         * The generator rung's scene specification (#216). Its own table beside
         * `image_challenges` rather than columns on it: the two rungs share
         * nothing but the word image, and one table would be half-null on every
         * row with a `kind` column deciding which half to read.
         */
        'scene_challenges',
        /**
         * A citizen's note against a capability rather than against the rung
         * that proved it (`#348`). The same shape as `task_notes` and a separate
         * table for one reason: the moment it is read. A skill is used
         * afterwards, in work that has nothing to do with the examination.
         */
        /**
         * `settings` — the values a maintainer may turn without a deploy
         * (`#489`, D-104). A row is an **override**: absence means the
         * environment's value, which is why the table is empty on a fresh
         * database rather than seeded with one row per known setting.
         */
        'settings',
        'skill_notes',
        /**
         * `sms_sends` joined with the phone rungs (`#409`). One row per message
         * the vendor accepted, which is what the two spend caps are counted off
         * — so it is load-bearing rather than an audit trail. It exists at all
         * because this is the only place in the Colony where a citizen's input
         * causes money to leave, and the answer to *what has this cost us* must
         * not have to come from a vendor's console.
         */
        /**
         * `sms_challenges` joined with the two phone rungs (`#411`). A sibling
         * of `email_challenges` rather than a generalisation of it: the flows
         * rhyme and they differ in the one place that decides a verdict, so two
         * tables that are 80 % alike are cheaper to read than one with a channel
         * column and eight *null on the other channel* comments in it.
         */
        'sms_challenges',
        'sms_sends',
        'social_challenges',
        /**
         * `solana_wallet_challenges` joined with the wallet rung
         * (`kolonie-platform#62`). It is `key_challenges` in a second encoding,
         * and separate for the reason the table comment gives: the two rungs
         * claim different things, and one partial unique index over both would
         * have an agent's own Ed25519 key collide with its own wallet address.
         *
         * Its cleared rows are what the four earning rungs above it read to
         * learn which address belongs to which citizen, so this is the table a
         * payment is checked against.
         */
        'solana_wallet_challenges',
        'submissions',
        /**
         * `support_tickets` joined with #11, and it is the one table here that is
         * about the Colony rather than about a task.
         *
         * Deliberately not a widening of `task_struggles`: a struggle is moderated
         * and then **served to other citizens**, which is what the whole moderation
         * subsystem exists for; a ticket is read by the Colony and by nobody else, so
         * it has no moderation column and nothing to publish wrongly.
         */
        'support_tickets',
        /**
         * `task_briefings` joined with #85, and it is the Colony's own voice
         * again — one row per task, rewritten from the moderated corpus.
         *
         * It exists because nothing a citizen wrote is served to another citizen
         * (#83), so something had to answer *what do other agents hit here* in
         * words the Colony can stand behind. One row per task rather than one per
         * generation: a briefing is a current statement, and `moderations` is
         * where the history that anyone would dispute already lives.
         */
        /**
         * `task_attempts` joined with #108, and it is what made failure
         * countable. Before it the Colony saw a failure only if it reached a
         * submission — so the 28 challenges that were issued and never
         * completed, measured on 2026-07-31, existed in no row that said an
         * agent had tried and stopped. One row per try, `abandoned` as a real
         * outcome, and the authority for which try a submission belongs to.
         */
        'task_attempts',
        /**
         * How often each task's briefing is actually read (`#609`).
         *
         * The Colony holds 145 claims and one mark saying any of them helped,
         * and that figure means one thing if the briefings are being read and
         * quite another if they are not.
         *
         * **Its own table rather than a column on `task_briefings`.** `#611`
         * made an empty briefing no row at all, so a counter living there would
         * be deleted by an ordinary synthesis that found nothing to say — and
         * the reads would still have happened.
         */
        'task_briefing_reads',
        'task_briefings',
        /**
         * The task a citizen read and never attempted (`#232`).
         *
         * Beside `task_attempts` rather than inside it, because it is the case
         * that table structurally cannot hold: a citizen that opened no attempt
         * has no row there, so *read the instructions and left* was recorded as
         * silence and looked identical to *never came*.
         */
        'task_considerations',
        /**
         * `task_declarations` (#479, #481): what a citizen declared about a rung
         * it never got an attempt open on. Both declaration tools hung on
         * `task_attempts` and discarded everything from a citizen a rung refused
         * before step 1 — which biased the comparison toward exactly the
         * runtimes that were not blocked.
         */
        'task_declarations',
        // The four that carry what is known about a task beyond its
        // instructions. `task_hints` and `task_briefings` are the Colony's own
        // voice; `task_reports` and `report_feedback` are citizens', and nothing
        // serves those unjudged — or, since #83, serves their prose at all.
        //
        // Four rather than five since #110: `task_struggles`, `task_tips` and
        // `tip_feedback` became `task_reports` and `report_feedback`, because a
        // struggle and a tip were one concept with two names.
        'task_hints',
        /**
         * The same shape as `task_hints` and the opposite serving rule (#390):
         * what the outside world looks like, served unasked and never withheld.
         * A second table rather than a flag, because the two differ on when they
         * are served, on whether they are asked for and on whether they are
         * withheld — and one boolean in the wrong place would leak the Colony's
         * help into the unaided attempt `#111` exists to measure, invisibly.
         * `kolonie-docs#162` is the record.
         */
        'task_landscape_notes',
        /**
         * `task_resets` joined with #47. A tester setting aside its own pass, as a row
         * rather than as an edit: the one-pass gate (D-015) reads *since the last
         * reset* instead of *ever*, so nothing about the earlier pass, the skill it
         * granted or the reputation it paid has to be rewritten.
         */
        /** `#199`: one private note per citizen per rung. */
        'task_notes',
        'task_reports',
        'task_resets',
        /**
         * `task_set_asides` (#234): which tasks one citizen has put down, so
         * its own listing stops offering them. Deliberately not a fifth
         * `task_attempts.outcome` — `declineAttempt` refuses the attempt-less
         * case on purpose, and writing set-asides there would move the
         * denominator of every abandonment rate the Colony reports.
         */
        'task_set_asides',
        'tasks',
        /**
         * `#843`: the Doctor's third consequence, and the only one that takes
         * something away. A row per limit rather than a column on the
         * diagnosis, because a diagnosis may be limited more than once and the
         * ordinal between those rows is what escalates.
         */
        'throttles',
        /** `#206`: one TOTP secret per citizen, checked twice. */
        'totp_secrets',
        /**
         * `#507`: every transfer of earned fee out of the hot wallet, and the
         * only record of it. The wallet balance cannot answer *how much of this
         * is the Colony's* — it mixes the fee with money owed to citizens whose
         * accrual has not reached the chain minimum.
         */
        'treasury_transfers',
        'verifications',
        /** `#45`: the vetting rung's manifests, one row per attempt. */
        'vetting_challenges',
        'vision_challenges',
        /**
         * `#244`. The rung above `website_challenges`: two probes, at two paths
         * the Colony names, separated in time. Sorted after it, which is also
         * where it belongs conceptually.
         */
        /**
         * The wake channel's three (`#518`). A challenge holds a URL and a
         * secret waiting to be knocked on; an address is the one a citizen
         * proved; deliveries are the Colony's record of every knock, and the
         * ceiling is counted from them.
         */
        'wake_addresses',
        'wake_challenges',
        'wake_deliveries',
        /**
         * `#1035`. One row per citizen per published note: whether the note a
         * walker left at a provider held when somebody else got there. No
         * counters live on `account_walks` beside it — the count is a subquery,
         * so there is nothing for the erasing transaction to recompute.
         */
        'walk_note_feedback',
        'web_server_challenges',
        /**
         * `#243`. One row per citizen, saying the Colony read its proved page
         * and found a link back. A table rather than a query because no
         * `select` can fetch a page.
         */
        'website_attributions',
        'website_challenges',
      ])
    })

    /**
     * D-002. This is the assertion that fails on the day somebody adds a balance
     * column "just for performance". That is the whole reason it exists.
     */
    it('keeps no balance on the agent row', async () => {
      const rows = await db.execute<{ column_name: string }>(
        sql`select column_name from information_schema.columns
             where table_schema = 'public' and table_name = 'agents'`,
      )
      const columns = rows.map((r) => r.column_name)
      expect(columns).not.toContain('credits')
      expect(columns).not.toContain('reputation')
    })
  })

  describe('enums match packages/core', () => {
    const pgEnumValues = async (name: string) => {
      const rows = await db.execute<{ value: string }>(
        sql`select e.enumlabel as value from pg_enum e
              join pg_type t on t.oid = e.enumtypid
             where t.typname = ${name}
             order by e.enumsortorder`,
      )
      return rows.map((r) => r.value)
    }

    /**
     * The database enums are generated from the Zod enums, so these cannot
     * disagree today. They assert that nobody replaces the derivation with a
     * hand-written list later — which is how the two would start to drift.
     */
    it.each([
      ['agent_platform', AgentPlatformSchema.options],
      ['citizenship_status', CitizenshipStatusSchema.options],
      ['role', RoleSchema.options],
      ['credential_kind', CredentialKindSchema.options],
      ['task_status', TaskStatusSchema.options],
      ['submission_status', SubmissionStatusSchema.options],
      ['system_account', SystemAccountSchema.options],
      ['ledger_entry_type', LedgerEntryTypeSchema.options],
      ['reputation_reason', ReputationReasonSchema.options],
      // #90. `erasure_reason` matters here more than the others: it is the only
      // content on a row that names nobody, so the day somebody widens it by
      // hand is the day *why do agents leave* stops being a closed list.
      ['erasure_reason', ErasureReasonSchema.options],
      ['ban_mark_kind', BanMarkKindSchema.options],
    ])('%s', async (name, expected) => {
      expect(await pgEnumValues(name)).toEqual([...expected])
    })

    /** D-001: `candidate` and `citizen` are statuses, never roles. */
    it('cannot store a citizenship status in the roles column', async () => {
      await expectRejection(
        () =>
          db.execute(
            sql`insert into agents (name, platform, roles)
                values ('impostor', 'openclaw', array['citizen']::role[])`,
          ),
        /invalid input value for enum role/i,
      )
    })
  })

  describe('agents', () => {
    it('stores an agent with no credits and no roles', async () => {
      const agent = await anAgent()
      expect(agent.status).toBe('candidate')
      expect(agent.roles).toEqual([])
    })

    it('accumulates roles', async () => {
      const agent = await anAgent({ roles: ['builder', 'reviewer'] })
      expect(agent.roles).toEqual(['builder', 'reviewer'])
    })

    it('rejects a name shorter than two characters', async () => {
      await expectRejection(() => anAgent({ name: 'x' }), /agents_name_min_length/)
    })

    /**
     * The rule this replaces used to live on `agents.wallet`, an unverified
     * string a citizen typed. It reserved an address nobody had proved, so it
     * could deny an honest citizen a field while doing nothing to stop either of
     * them proving the address for real (`kolonie-platform#102`).
     *
     * The rule now sits where the proof does — over cleared rows only, so a
     * failed attempt reserves nothing. Asserted here because the whole of it is
     * a partial unique index; there is no code path to test instead.
     */
    it('rejects two citizens who both proved the same wallet', async () => {
      const first = await anAgent({ name: 'first' })
      const second = await anAgent({ name: 'second' })
      const address = 'So11111111111111111111111111111111111111112'

      await provedWallet(first, address)

      await expectRejection(
        () => provedWallet(second, address),
        /solana_wallet_challenges_address_unique/,
      )
    })

    /**
     * `#571`. The same rule from the other side, and it exists because the first
     * one is not enough: two citizens sharing a wallet would let one payout be
     * claimed twice, and **one citizen holding two makes *where do we pay this
     * citizen* a question with more than one answer**. Under the Colony's own
     * rule — every agent has its own wallet and only the agent holds the key —
     * that has to be impossible rather than merely unusual.
     *
     * Asserted here for the reason above: the whole of it is a partial unique
     * index, and the code path it guards is a race that cannot be provoked
     * reliably from a test.
     */
    it('rejects one citizen proving a second wallet', async () => {
      const agent = await anAgent({ name: 'twice' })

      await provedWallet(agent, 'So11111111111111111111111111111111111111112')

      await expectRejection(
        () => provedWallet(agent, 'Ax11111111111111111111111111111111111111112'),
        /solana_wallet_challenges_agent_unique/,
      )
    })

    it('lets one citizen fail many attempts before clearing', async () => {
      const agent = await anAgent({ name: 'persistent' })

      await provedWallet(agent, 'So11111111111111111111111111111111111111112', { cleared: false })
      await provedWallet(agent, 'Ax11111111111111111111111111111111111111112', { cleared: false })

      // An attempt reserves nothing, including against its own agent.
      await expect(
        provedWallet(agent, 'Bx11111111111111111111111111111111111111112'),
      ).resolves.toBeUndefined()
    })

    it('reserves nothing for an address that only appears on a failed attempt', async () => {
      const first = await anAgent({ name: 'first' })
      const second = await anAgent({ name: 'second' })
      const address = 'So11111111111111111111111111111111111111112'

      await provedWallet(first, address, { cleared: false })

      await expect(provedWallet(second, address)).resolves.toBeUndefined()
    })

    it('lets many agents have no wallet at all', async () => {
      await anAgent({ name: 'first' })
      await expect(anAgent({ name: 'second' })).resolves.toBeDefined()
    })
  })

  describe('credentials', () => {
    it('stores an api key as a hash and nothing else', async () => {
      const agent = await anAgent()
      const [credential] = await db
        .insert(credentials)
        .values({ agentId: agent.id, kind: 'api-key', secretHash: 'sha256:deadbeef' })
        .returning()

      expect(credential!.lastUsedAt).toBeNull()
      expect(credential!.revokedAt).toBeNull()
      // There is nowhere for a plaintext key to live, by construction.
      expect(Object.keys(credential!)).not.toContain('secret')
      expect(Object.keys(credential!)).not.toContain('apiKey')
    })

    it('rejects an api key with no hash', async () => {
      const agent = await anAgent()
      await expectRejection(
        () => db.insert(credentials).values({ agentId: agent.id, kind: 'api-key' }),
        /credentials_secret_requires_hash/,
      )
    })

    /** Every kind that carries a secret, not only the first one that did (`#172`). */
    it('rejects a sign-in link and a session with no hash', async () => {
      const agent = await anAgent()
      const expiresAt = new Date(Date.now() + 60_000).toISOString()

      await expectRejection(
        () => db.insert(credentials).values({ agentId: agent.id, kind: 'email-link', expiresAt }),
        /credentials_secret_requires_hash/,
      )
      await expectRejection(
        () =>
          db.insert(credentials).values({ agentId: agent.id, kind: 'console-session', expiresAt }),
        /credentials_secret_requires_hash/,
      )
    })

    /**
     * Both directions of `credentials_expiry_matches_kind` (`#172`). The second
     * is the one worth pinning: an API key with an expiry would be a field that
     * looks like it does something and does not.
     */
    it('requires an expiry on the kinds that expire and refuses one on the kinds that do not', async () => {
      const agent = await anAgent()

      await expectRejection(
        () =>
          db
            .insert(credentials)
            .values({ agentId: agent.id, kind: 'email-link', secretHash: 'a'.repeat(64) }),
        /credentials_expiry_matches_kind/,
      )
      await expectRejection(
        () =>
          db.insert(credentials).values({
            agentId: agent.id,
            kind: 'api-key',
            secretHash: 'b'.repeat(64),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        /credentials_expiry_matches_kind/,
      )
    })

    it('allows a wallet credential with no hash', async () => {
      const agent = await anAgent()
      await expect(
        db.insert(credentials).values({ agentId: agent.id, kind: 'wallet-signature' }),
      ).resolves.toBeDefined()
    })

    it('rejects two credentials with the same hash', async () => {
      const agent = await anAgent()
      await db
        .insert(credentials)
        .values({ agentId: agent.id, kind: 'api-key', secretHash: 'sha256:same' })
      await expectRejection(
        () =>
          db
            .insert(credentials)
            .values({ agentId: agent.id, kind: 'api-key', secretHash: 'sha256:same' }),
        /credentials_secret_hash_unique/,
      )
    })

    it('lets an agent hold several credentials over time', async () => {
      const agent = await anAgent()
      await db.insert(credentials).values([
        { agentId: agent.id, kind: 'api-key', secretHash: 'sha256:one', label: null },
        { agentId: agent.id, kind: 'api-key', secretHash: 'sha256:two', label: 'ci runner' },
      ])
      expect(await db.$count(credentials)).toBe(2)
    })
  })

  describe('tasks', () => {
    it('rejects a type that is not a kebab-case slug', async () => {
      await expectRejection(() => aTask({ type: 'Email Create' }), /tasks_type_slug/)
    })

    /**
     * The slug rule exists twice — as `TASK_TYPE_PATTERN` in core and as a regex
     * in the check constraint — because a check constraint cannot call
     * TypeScript. This asserts the two agree on the same inputs.
     */
    it.each(['email-create', 'github-issue', 'x1', 'Email-Create', 'trailing-'])(
      'agrees with TASK_TYPE_PATTERN about %s',
      async (candidate) => {
        const coreAccepts = TASK_TYPE_PATTERN.test(candidate) && candidate.length >= 3
        const dbAccepts = await aTask({ type: candidate }).then(
          () => true,
          () => false,
        )
        expect(dbAccepts).toBe(coreAccepts)
      },
    )

    /**
     * On the reputation half, because the credit half now has a second constraint
     * on it (`tasks_academy_pays_no_credits`, #43) and Postgres does not promise
     * which of two violated checks it names. A negative credit amount on a `quest`
     * row would isolate this one, but reputation is the simpler subject and the
     * constraint covers both columns.
     */
    it('rejects a negative reward', async () => {
      await expectRejection(() => aTask({ rewardReputation: -1 }), /tasks_reward_non_negative/)
    })

    it.each([0, 721])('rejects a timeout of %i hours', async (timeoutHours) => {
      await expectRejection(() => aTask({ timeoutHours }), /tasks_timeout_hours_range/)
    })

    it('keeps a task when its author is deleted', async () => {
      const author = await anAgent({ name: 'author' })
      const task = await aTask({ createdBy: author.id })
      await db.delete(agents).where(sql`${agents.id} = ${author.id}`)

      const [kept] = await db
        .select()
        .from(tasks)
        .where(sql`${tasks.id} = ${task.id}`)
      expect(kept?.createdBy).toBeNull()
    })
  })

  describe('submissions', () => {
    it('starts pending with no verdict time', async () => {
      const agent = await anAgent()
      const task = await aTask()
      const [submission] = await db
        .insert(submissions)
        .values({ taskId: task.id, agentId: agent.id, payload: { address: 'a@example.test' } })
        .returning()

      expect(submission!.status).toBe('pending')
      expect(submission!.attempt).toBe(1)
      expect(submission!.verifiedAt).toBeNull()
    })

    it.each(SubmissionStatusSchema.options.filter((s) => s !== 'pending' && s !== 'verifying'))(
      'rejects %s without a verdict time',
      async (status) => {
        const agent = await anAgent()
        const task = await aTask()
        await expectRejection(
          () =>
            db
              .insert(submissions)
              .values({ taskId: task.id, agentId: agent.id, payload: {}, status }),
          /submissions_verified_at_matches_status/,
        )
      },
    )

    it('rejects a verdict time on a submission still being verified', async () => {
      const agent = await anAgent()
      const task = await aTask()
      await expectRejection(
        () =>
          db.insert(submissions).values({
            taskId: task.id,
            agentId: agent.id,
            payload: {},
            status: 'verifying',
            verifiedAt: new Date().toISOString(),
          }),
        /submissions_verified_at_matches_status/,
      )
    })

    it('rejects a second row for the same attempt', async () => {
      const agent = await anAgent()
      const task = await aTask()
      const row = { taskId: task.id, agentId: agent.id, payload: {}, attempt: 1 }
      await db.insert(submissions).values(row)
      await expectRejection(
        () => db.insert(submissions).values(row),
        /submissions_task_agent_attempt_unique/,
      )
    })

    it('allows a retry as a new attempt', async () => {
      const agent = await anAgent()
      const task = await aTask()
      await db.insert(submissions).values({
        taskId: task.id,
        agentId: agent.id,
        payload: {},
        attempt: 1,
        status: 'failed',
        verifiedAt: new Date().toISOString(),
      })
      await expect(
        db
          .insert(submissions)
          .values({ taskId: task.id, agentId: agent.id, payload: {}, attempt: 2 }),
      ).resolves.toBeDefined()
    })

    it('refuses to delete a task that has submissions', async () => {
      const agent = await anAgent()
      const task = await aTask()
      await db.insert(submissions).values({ taskId: task.id, agentId: agent.id, payload: {} })

      await expectRejection(
        () => db.delete(tasks).where(sql`${tasks.id} = ${task.id}`),
        /submissions_task_id_tasks_id_fk/,
      )
    })
  })

  describe('the ledger', () => {
    it('books a balanced reward', async () => {
      const agent = await anAgent()
      await book([
        { accountKind: 'system', systemAccount: 'mint', amount: -50, type: 'task_reward' },
        { accountKind: 'agent', agentId: agent.id, amount: 50, type: 'task_reward' },
      ])

      const [row] = await db.execute<{ total: string }>(
        sql`select coalesce(sum(amount), 0)::text as total from ledger_entries`,
      )
      expect(row!.total).toBe('0')
    })

    /**
     * The rejection case the definition of done requires. This is the single
     * most important assertion in the package: if it ever stops holding, every
     * balance the Colony reports becomes unverifiable.
     */
    it('rejects a transaction that does not sum to zero', async () => {
      const agent = await anAgent()
      await expectRejection(
        () =>
          book([
            { accountKind: 'system', systemAccount: 'mint', amount: -50, type: 'task_reward' },
            { accountKind: 'agent', agentId: agent.id, amount: 60, type: 'task_reward' },
          ]),
        /sums to 10, but double-entry requires 0/,
      )
    })

    it('rejects a single-sided transaction', async () => {
      const agent = await anAgent()
      await expectRejection(
        () => book([{ accountKind: 'agent', agentId: agent.id, amount: 50, type: 'task_reward' }]),
        /requires at least 2/,
      )
    })

    it('rejects a zero-amount entry padding a transaction', async () => {
      const agent = await anAgent()
      await expectRejection(
        () =>
          book([
            { accountKind: 'agent', agentId: agent.id, amount: 0, type: 'adjustment' },
            { accountKind: 'system', systemAccount: 'mint', amount: 0, type: 'adjustment' },
          ]),
        /ledger_entries_amount_non_zero/,
      )
    })

    it('rejects an entry belonging to both an agent and a system account', async () => {
      const agent = await anAgent()
      await expectRejection(
        () =>
          book([
            {
              accountKind: 'agent',
              agentId: agent.id,
              systemAccount: 'mint',
              amount: -50,
              type: 'task_reward',
            },
            { accountKind: 'agent', agentId: agent.id, amount: 50, type: 'task_reward' },
          ]),
        /ledger_entries_account_exclusive/,
      )
    })

    it('rejects an entry belonging to neither', async () => {
      await expectRejection(
        () =>
          book([
            { accountKind: 'agent', amount: -50, type: 'task_reward' },
            { accountKind: 'system', systemAccount: 'mint', amount: 50, type: 'task_reward' },
          ]),
        /ledger_entries_account_exclusive/,
      )
    })

    it('rejects entries of one transaction disagreeing about the reference', async () => {
      const agent = await anAgent()
      await expectRejection(
        () =>
          book([
            {
              accountKind: 'system',
              systemAccount: 'mint',
              amount: -50,
              type: 'task_reward',
              reference: 'submission:1',
            },
            {
              accountKind: 'agent',
              agentId: agent.id,
              amount: 50,
              type: 'task_reward',
              reference: 'submission:2',
            },
          ]),
        /different references/,
      )
    })

    it('rejects deleting one side of a booked transaction', async () => {
      const agent = await anAgent()
      const transactionId = await book([
        { accountKind: 'system', systemAccount: 'mint', amount: -50, type: 'task_reward' },
        { accountKind: 'agent', agentId: agent.id, amount: 50, type: 'task_reward' },
      ])

      await expectRejection(
        () =>
          db.delete(ledgerEntries).where(
            sql`${ledgerEntries.transactionId} = ${transactionId}
                and ${ledgerEntries.accountKind} = 'agent'`,
          ),
        /requires at least 2/,
      )
    })

    it('refuses to delete an agent that has been paid', async () => {
      const agent = await anAgent()
      await book([
        { accountKind: 'system', systemAccount: 'mint', amount: -50, type: 'task_reward' },
        { accountKind: 'agent', agentId: agent.id, amount: 50, type: 'task_reward' },
      ])

      await expectRejection(
        () => db.delete(agents).where(sql`${agents.id} = ${agent.id}`),
        /ledger_entries_agent_id_agents_id_fk/,
      )
    })

    /** D-003's payoff: total supply is auditable without trusting any counter. */
    it('derives total supply as the negative of the mint balance', async () => {
      const one = await anAgent({ name: 'one' })
      const two = await anAgent({ name: 'two' })
      await book([
        { accountKind: 'system', systemAccount: 'mint', amount: -50, type: 'task_reward' },
        { accountKind: 'agent', agentId: one.id, amount: 50, type: 'task_reward' },
      ])
      await book([
        { accountKind: 'system', systemAccount: 'mint', amount: -30, type: 'task_reward' },
        { accountKind: 'agent', agentId: two.id, amount: 30, type: 'task_reward' },
      ])
      // A transfer moves credits without creating any.
      await book([
        { accountKind: 'agent', agentId: one.id, amount: -20, type: 'transfer' },
        { accountKind: 'agent', agentId: two.id, amount: 20, type: 'transfer' },
      ])

      const [mint] = await db.execute<{ balance: string }>(
        sql`select coalesce(sum(amount), 0)::text as balance
              from ledger_entries where system_account = 'mint'`,
      )
      const [held] = await db.execute<{ balance: string }>(
        sql`select coalesce(sum(amount), 0)::text as balance
              from ledger_entries where account_kind = 'agent'`,
      )
      expect(mint!.balance).toBe('-80')
      expect(held!.balance).toBe('80')
    })
  })
})
