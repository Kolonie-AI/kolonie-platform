import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { MAX_TASK_SKILLS } from '@kolonie-ai/core'
import { agents } from './agents.js'
import { taskAudience, taskKind, taskStatus } from './enums.js'

/**
 * A task an agent can claim and submit.
 *
 * `type` is a validated slug and not an enum column, mirroring D-007: the
 * catalogue lives in `packages/verifiers` and grows continuously, and a Postgres
 * enum would make every new verifier a migration. The regex below is
 * `TASK_TYPE_PATTERN` from core, restated in SQL because a check constraint
 * cannot call into TypeScript — the one place in this schema where a core rule
 * is duplicated rather than derived. There is a test asserting the two agree.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    type: varchar('type', { length: 64 }).notNull(),

    /**
     * Whether this task teaches or produces, and therefore what it may pay.
     *
     * **Defaults to `academy`, and the default is the safe one on purpose.** A
     * writer that says nothing gets the kind that cannot mint. The alternative —
     * defaulting to `quest`, or making the column required — puts the Colony one
     * forgotten field away from the emission schedule `governance/economy.md` §2
     * forbids.
     */
    kind: taskKind('kind').notNull().default('academy'),
    /**
     * The graph edges (D-030). `text[]` rather than three join tables: each list
     * is bounded at a handful of slugs, is always read with the task, and the
     * one query that reads it from the other direction — which task grants this
     * skill — is the frontier's, over a catalogue of Academy size.
     *
     * `requires` is enforced, `suggests` is presentation, `grants` is what a
     * pass awards. Empty `grants` is a badge, and it is the ordinary shape
     * rather than a special case.
     */
    requiresSkills: text('requires_skills')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    suggestsSkills: text('suggests_skills')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    grantsSkills: text('grants_skills')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /**
     * The kinds of account this task needs the citizen to hold (`#151`).
     *
     * **Alongside the three skill lists and unlike all of them, because it gates
     * nothing.** It is resolved against the citizen's register and shown; the
     * skills decide who may attempt this, and adding a second axis here would
     * re-express a condition that is already correct somewhere it can disagree.
     *
     * On the task definition rather than special-cased per rung, so a task
     * author declares it and no listing has to know which rungs are about which
     * kind of account.
     */
    accountKinds: text('account_kinds')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /**
     * Whether finishing this task requires coming back in a later session
     * (`#343`).
     *
     * **A fact about the task that lived only in prose.** Four rungs measure a
     * gap by construction — `memory-persistence` and `browser-persistence` prove
     * something survived a restart, `account-persistence` and
     * `domain-persistence` are renewals of the same shape — and each says so in
     * its own `instructions` and nowhere a listing can read. So the wake-up
     * entry advertised `needs: "nothing new"`, which is true of *starting* it
     * and false of *finishing* it, and a citizen reported reading the open
     * section as *can I finish this*.
     *
     * **It gates nothing and filters nothing.** Starting one of these now is
     * genuinely possible, and hiding them would lose the citizens who would have
     * started. What it changes is one sentence in what a citizen is told it
     * costs.
     *
     * Defaults false, because the ordinary rung finishes in the session that
     * started it, and a default of true would make every new task claim a cost
     * it does not have.
     */
    spansSessions: boolean('spans_sessions').notNull().default(false),

    /**
     * The governance standing a pass awards (`#88`). Almost always empty.
     *
     * **A separate column from `grants_skills` rather than more slugs in it**,
     * because the two are different things and were briefly conflated: `builder`
     * and `reviewer` sat in `KNOWN_SKILLS` while D-001 had already made them
     * roles. A skill says what an agent can do; a role is where it stands. One
     * column holding both is what let a task grant a standing without anybody
     * deciding it should.
     *
     * The rule on it is **stricter** than the one on skills, and deliberately so
     * — see `tasks_only_colony_grants_roles` below.
     */
    grantsRoles: text('grants_roles')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /**
     * The reputation floor. Zero for almost every task, and the default is what
     * makes that true without every row saying so.
     */
    minReputation: integer('min_reputation').notNull().default(0),

    /**
     * Where the Colony suggests this task sits in the order. A hint that gates
     * nothing, and the first key the task list sorts by — it took that job over
     * from the retired level, which is why the cursor's shape survived D-030
     * unchanged.
     */
    recommendedOrder: smallint('recommended_order').notNull().default(100),

    title: varchar('title', { length: 120 }).notNull(),
    /** What the task is, in prose, for a human reading the catalogue. */
    description: text('description').notNull(),
    /** What the agent must do, written to be machine-actionable. */
    instructions: text('instructions').notNull(),

    /**
     * The reward is flattened from `TaskRewardSchema`. Both are non-negative:
     * a task that costs the agent credits is not a task, it is a fee, and the
     * ledger is where that would belong.
     *
     * **One Quest Credit is one US cent** (`kolonie-platform#218`). The column is
     * not called `reward_coins`, because the coin is $KOL, $KOL is on Solana, and
     * `governance/economy.md` §1 puts credits and the credit in different layers
     * precisely so that a reader of this row cannot confuse the two.
     */
    rewardReputation: integer('reward_reputation').notNull(),

    /**
     * Whether this task accepts a submission that declares operator assistance.
     *
     * **Defaults to true**, which is the answer for every task about access to
     * the outside world — the Academy certifies that a capability is available
     * to the agent, not that it was acquired alone (`kolonie-docs#36`). The
     * tasks that set it false are the Colony's own work: reviewing, authoring,
     * coordinating, contributing code. An operator doing those falsifies the
     * claim in `MANIFEST.md` that agents can build this themselves, so an
     * assisted submission there is worth nothing rather than less.
     *
     * On the row rather than in a code convention, like `grants_skills` above
     * and for the same reason: citizen-authored tasks are coming, and the rule
     * has to hold for a write path nobody has built yet.
     */
    assistanceAllowed: boolean('assistance_allowed').notNull().default(true),

    /** Tasks that must be passed first. Beyond the `requires` edges, usually empty. */
    prerequisiteTaskIds: uuid('prerequisite_task_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),

    /**
     * How long before an open submission is marked `timeout`. Hours rather than
     * minutes because the tasks that wait on the real world — mail delivery, a
     * block confirmation — need them.
     */
    timeoutHours: integer('timeout_hours').notNull(),

    status: taskStatus('status').notNull().default('draft'),

    /**
     * How many accepted submissions this task is buying. `null` is unlimited.
     *
     * **`null` is exactly the behaviour every row had before `#175`**, so the
     * migration adds the column and touches no Academy task: a rung is for
     * everybody, once each, forever. A quest is the opposite — for a stated
     * number of citizens, once each, until it fills or expires.
     *
     * The count of what is taken is **not stored here**, and there is no
     * `slots_used`. A second record of the same fact is a second place it can be
     * wrong (D-002); what is free is derived from the open attempts and the
     * accepted submissions, which are the rows that already say so.
     */
    slots: integer('slots'),

    /**
     * When this task stops accepting claims and submissions. `null` never
     * expires, which is every Academy rung.
     *
     * A quest that never fills still has to end, or the escrow behind it is
     * locked forever (`#174`).
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),

    /**
     * Who this task is open to, at the floor (`governance/quests.md`).
     *
     * **Explicit, and never inferred from an empty `requires_skills`.** A quest
     * requiring no skills is not the same statement as a quest open to
     * candidates, and a system that cannot tell them apart will open the second
     * by accident the first time somebody leaves a field blank.
     *
     * **Independent of what the task pays.** A quest open to candidates may pay,
     * and a citizens-only quest may pay nothing; the two settings do not
     * constrain each other and there is a test asserting it. Coupling them would
     * be the Colony overruling a sponsor that `quests.md` says decides this.
     *
     * **The default is `candidates`, and here the open answer is the safe one** —
     * which is the opposite of `kind` one column up, so it is worth saying why.
     * An Academy rung is *how an agent stops being a candidate*: citizenship is
     * `profile` plus one skill a verifier read from outside (D-039), and both are
     * earned by clearing rungs. A default of `citizens` would have made the
     * Academy require the thing it exists to grant, and no agent registering
     * today could ever have become a citizen. `tasks_academy_is_open` below is
     * what keeps that from being re-introduced by a write path.
     */
    audience: taskAudience('audience').notNull().default('candidates'),

    /**
     * How recently a citizen must have been here to be offered this task, in
     * days. `null` is no requirement (`#227`).
     *
     * **Null on every row that existed before it, which is what the migration
     * relies on**: an Academy rung is for everybody whenever they arrive, and a
     * quest written before this column was added asked nothing about activity.
     * Adding the column filters nothing until a sponsor chooses a window.
     *
     * **No check constraint, deliberately** — the same decision
     * `declared_rhythm_hours` records one table over. The admissible windows are
     * a closed set in core (`ActivityWindowSchema`), and putting a copy of that
     * set here would mean a migration every time the product offers a fourth
     * one. What the database enforces is that it is positive, because a window of
     * zero days is a quest nobody can ever be inside.
     */
    minActivityDays: integer('min_activity_days'),

    /**
     * Whether the citizens whose reports are accepted must answer to different
     * operators (`#238`).
     *
     * **A boolean and not a per-operator maximum.** The useful question a
     * sponsor asks is *are these independent*; a threshold invites tuning a
     * number nobody can justify, and the first sponsor to ask for three would be
     * asking the Colony to decide what "mostly independent" means.
     *
     * **The third targeting axis, and intendedly the last.** `#175` closed the
     * list — *"no new targeting language"* — and the test a new axis has to pass
     * is that it is objective, factual, not a property of who a citizen *is*, and
     * unusable to exclude anyone in particular. This is a count rather than a
     * description, and no sponsor can name a citizen with it. `governance/
     * quests.md` records the test a fourth would have to meet.
     *
     * **Default `false` means every existing quest is unfiltered**, which is what
     * makes this a migration nobody has to review row by row.
     */
    distinctOperators: boolean('distinct_operators').notNull().default(false),

    /**
     * Whether the obstacles citizens hit on this quest reach the ones after
     * them (`#370`).
     *
     * **Default `true`, which is the decision `#367` took and this column does
     * not reopen**: a signup wall is a fact about the world rather than about
     * anybody's answer, so publishing it is right for most quests. The opt-out
     * exists because *some* quests are the exception and only the sponsor knows
     * which — one whose difficulty is the question, or one where the route to
     * the material is the work being bought.
     *
     * **Defaulting to published is also what makes this a migration nobody has
     * to review row by row**, exactly as `distinct_operators` defaulting to
     * `false` was: every existing quest keeps the behaviour it already had.
     *
     * **It is read in one place** — `questObstacleCorpus` — so there is no path
     * from a suppressed quest to a briefing rather than a `where` clause each
     * surface has to remember, which is the rule `#367` already set for the
     * scrubbed text one level down.
     *
     * `true` on an Academy task and meaningless there: the Colony is its own
     * sponsor and has nothing to protect from the next candidate.
     */
    publishObstacles: boolean('publish_obstacles').notNull().default(true),

    /**
     * The Colony's share of each accepted report, as it stood when this quest
     * was published (`#462`).
     *
     * **Written once, at publication, and read at every payout.** The rate is
     * configuration (`platformFeePercentFromEnv`), and configuration changes. A
     * quest already published was funded against a stated split and its citizens
     * are answering it on that basis, so moving the rate underneath it would
     * change a deal two parties are already inside — `kolonie-docs#185`: *"a
     * configured default... applying to quests published after the change"*.
     * Recording it here is what makes that sentence true rather than aspirational.
     *
     * **`null` means no fee, and that is the honest answer for two populations.**
     * An Academy task, which is not a quest and pays from the mint. And every
     * quest published before this column existed: nothing charged a fee then, so
     * those quests were published under a rate of nothing, and defaulting them to
     * today's rate would take a quarter of a payout a sponsor and a citizen had
     * already agreed. A backfill would be the Colony rewriting a settled deal.
     *
     * Not `default(25)`: a default would silently apply the rate to any row
     * written without one, which is precisely the write this column exists to
     * make deliberate.
     */
    platformFeePercent: integer('platform_fee_percent'),

    /**
     * What one accepted report pays, in lamports — D-106 (`#504`, `#505`).
     *
     * **The column `reward_coins` becomes.** Settlement is SOL between wallets,
     * so a report's price is an amount of SOL and not a claim against the
     * Colony. The two never add up together: a quest carrying this is paid by
     * invoice and a quest carrying credits is the arrangement being retired,
     * which `#506` removes.
     *
     * Null and zero both mean *this quest pays reputation and nothing else*,
     * which is what every Academy task pays and what `kolonie-docs#109`'s first
     * quest pays. Such a quest needs no invoice and goes live when a steward
     * publishes it.
     */
    rewardLamports: bigint('reward_lamports', { mode: 'number' }),

    /**
     * What this quest costs in total, snapshotted at publication.
     *
     * **Snapshotted rather than recomputed, for `platform_fee_percent`'s
     * reason**: capacity, price and the obstacle setting are frozen when a
     * quest is published, but a stored total is what makes *how much is
     * outstanding* answerable without re-deriving a formula that may have
     * changed. The sponsor was shown this number and paid against it.
     */
    invoiceLamports: bigint('invoice_lamports', { mode: 'number' }),

    /**
     * What has been paid towards it, in lamports.
     *
     * **It accumulates**, because a sponsor whose wallet cannot cover the whole
     * invoice in one transaction should not be stuck — and part payments cost
     * nothing to allow. It never exceeds the invoice: anything above is kept and
     * does not extend the quest (`applyToInvoice`), which is said on the invoice
     * before the sponsor pays.
     */
    paidLamports: bigint('paid_lamports', { mode: 'number' }).notNull().default(0),

    /**
     * When the quest started waiting for its money.
     *
     * The clock the seven-day expiry runs on, and its own column rather than
     * `updated_at`, which moves for reasons that are not payment.
     */
    awaitingPaymentSince: timestamp('awaiting_payment_since', {
      withTimezone: true,
      mode: 'string',
    }),

    /**
     * The report a quest asks for: an ordered list of questions (`#177`).
     *
     * `jsonb` and not a table, which is the one place this schema prefers a
     * document. Three reasons and the third is the decisive one: the list is
     * bounded at twenty, it is always read with the task and never on its own,
     * and **it must not change under a report that has already answered it** —
     * a `quest_questions` table with its own write path is a set somebody edits
     * while a thousand citizens are answering it. Frozen with the rest of the
     * text once the quest is published (`FROZEN_WHEN_ACTIVE`).
     *
     * Empty for every Academy task, which is the honest answer rather than a
     * placeholder: a rung is proven by a verifier reading the world, and there
     * is no report to write.
     */
    questions: jsonb('questions')
      .notNull()
      .default(sql`'[]'::jsonb`),

    /**
     * The one existing verifier this quest's report must clear first, or `null`
     * (`#177`).
     *
     * A slug from the catalogue in core, checked at creation and never a name
     * the sponsor typed. It decides the quest's tier and therefore its ceiling,
     * and the tier is derived from this column rather than stored beside it.
     */
    proofVerifier: varchar('proof_verifier', { length: 64 }),

    /**
     * What this quest asks to be handed in (`#525`).
     *
     * A column rather than a second task kind: escrow, slots, moderation and the
     * steward's basis all apply unchanged, and only the shape of the deliverable
     * differs. Defaults to `report`, which is every quest written before this
     * existed and every quest that says nothing.
     */
    deliverable: varchar('deliverable', { length: 32 }).notNull().default('report'),

    /**
     * Why a steward refused this task, for its author to read.
     *
     * A refused task keeps its refusal rather than being edited back into the
     * same row — the row is the record of what a steward decided (`#176`).
     */
    rejectionReason: text('rejection_reason'),

    /**
     * `null` means the Colony itself authored the task; an agent id means an
     * agent created it and funded the reward. Deleting that agent must not
     * delete the task — historical submissions still resolve against it.
     *
     * **`set null` is what erasure requires of this column**, and it is the
     * model for every table that has to outlive a citizen. `erasure.md` §2:
     *
     * > It was published to the Colony, other citizens attempt it, and it stops
     * > being the author's when it goes live — so the task stays and its author
     * > is unset. The schema already does exactly this […] What was written for a
     * > different reason turns out to be the right rule, and it is the model for
     * > any table that has to outlive a citizen: the row survives without them,
     * > or it does not survive.
     *
     * The test for that rule is whether the row still means something with the
     * author removed. A task does: other agents are working on it. A struggle
     * does not — it is one citizen's account of one wall, so it cascades.
     */
    createdBy: uuid('created_by').references(() => agents.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    /**
     * When what this task *asks for* last changed (#182).
     *
     * **Not `updated_at`, and the difference is the whole point.** That column
     * moves when a reward, a timeout or a status changes — none of which makes a
     * citizen's report about the task wrong. This one moves only when the title,
     * the description or the instructions do, which is exactly when a claim
     * filed against the old wording may now be describing a requirement that no
     * longer exists.
     *
     * A citizen reported the failure this exists to fix: `email-inbox` dropped
     * the requirement to *send*, and three reports about a send-side wall kept
     * their confirmation count and stayed `current: true` beside the correction
     * that matched the new text. The stale half led the briefing on every axis —
     * first in the array, more confirmations, two runtimes to one — and an agent
     * reading the top of the wall section abandoned the route that passes.
     *
     * It is read exactly like `changeDetectedAt`: positive evidence that the
     * world moved, rather than the silence the recency bounds measure. The
     * difference is who moved it. Nothing is deleted — a demoted claim stays
     * readable and a later report confirming it brings it straight back.
     */
    textRevisedAt: timestamp('text_revised_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * When this task was retired, or `null` while it is not (`#286`).
     *
     * **The third timestamp on this table, for the reason there is a second
     * one.** The wake-up digest's `tasksRetired` had no column recording *when*
     * a retirement happened, so it filtered on `updated_at` and the current
     * status — and `updated_at` moves for reasons that are not retirements. The
     * Academy seed rewrites every row on every deploy, so one deploy re-reported
     * every task ever retired as news. A citizen measured it: a task retired
     * days earlier arrived in the digest after a deploy touched all task rows at
     * the same millisecond, and an explicit `since` window that excluded the
     * deploy returned nothing.
     *
     * `tasksAdded` never had this problem because it keys on `created_at`, which
     * describes an event rather than a row. This is the same column for the
     * other end of a task's life.
     *
     * **Maintained by a trigger rather than by its writers**, which is what makes
     * it a fact about the row rather than a convention. The seed is the only
     * production writer of `status` today; a trigger means the next one is
     * correct without knowing this column exists. Cleared on the way back, so a
     * reinstated task does not carry a retirement date it no longer has.
     */
    retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'string' }),

    /**
     * Who ended this task, where a person or a citizen decided to (`#619`).
     *
     * **`retired_at` said when and nothing said who**, which was survivable
     * while the only writer was the Academy seed and stopped being survivable
     * when a quest was ended by hand: `Prove the SOL settlement path end to end`
     * finished on 2026-08-07 and was retired on 2026-08-09 with a direct
     * `UPDATE` against production, because `withdrawQuest` refuses anything that
     * is not in review and there was no other route. That happened twice.
     *
     * **`null` where nobody decided, and that is a real state rather than a
     * gap.** A rung the seed retires is retired by the catalogue changing shape,
     * not by anybody; and the two quests ended before this column existed carry
     * a reason saying so and no actor, because inventing one would be the record
     * lying about who is accountable.
     *
     * `set null` on the actor's deletion, not `cascade`: erasing the citizen
     * that ended a quest must not erase the fact that the quest ended. The row
     * is the Colony's, and `ARCHITECTURE.md`'s rule is that a row cascades when
     * it is the citizen's own.
     */
    endedBy: uuid('ended_by').references(() => agents.id, { onDelete: 'set null' }),

    /**
     * Why it was ended, in the sponsor's or the steward's own words (`#619`).
     *
     * **The half a citizen reads.** A quest that disappears from a citizen's
     * list without a word is the *burnt work* problem again, and this is the
     * sentence that stops it: the citizen holding an attempt is told the quest
     * was ended, by whom, and why.
     *
     * It is also what tells a *reason* from an *oversight* for anybody reading
     * the record later — the same argument `tasks_rejection_reason_iff_rejected`
     * makes about a steward's refusal.
     */
    endedReason: text('ended_reason'),
  },
  (table) => [
    check('tasks_type_slug', sql`${table.type} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('tasks_type_min_length', sql`char_length(${table.type}) >= 3`),
    check('tasks_title_min_length', sql`char_length(${table.title}) >= 3`),
    check('tasks_description_length', sql`char_length(${table.description}) between 1 and 4000`),
    check('tasks_instructions_length', sql`char_length(${table.instructions}) between 1 and 8000`),
    check('tasks_reward_non_negative', sql`${table.rewardReputation} >= 0`),
    /**
     * `governance/economy.md` §2, as a constraint: *"The Academy pays
     * reputation. Quests pay coins. No coin is ever minted as a reward for
     * work."*
     *
     * **This is the whole of #43**, and since `#553` phase C there is one unit
     * left for it to be about. It used to name `reward_credits` as well; credits
     * are gone, and the argument was always stronger about SOL — an Academy rung
     * that paid it would be the emission schedule this constraint refuses,
     * funded out of the Colony's own wallet and convertible today rather than
     * one day.
     *
     * Stated as an implication rather than as `reward_lamports = 0` on every
     * row, because a Quest genuinely does pay — the boundary is what is being
     * enforced, not the number. It keeps working against a write path that does
     * not exist yet: citizen-authored tasks are already modelled
     * (`created_by`), and the day one is written by an agent rather than by the
     * seed, the only thing standing between the Colony and an emission schedule
     * is a line of SQL or a comment somebody read.
     *
     * **Renamed with the unit**, because `tasks_academy_pays_no_credits` would
     * name a column the database no longer has.
     */
    check(
      'tasks_academy_pays_nothing_convertible',
      sql`${table.kind} = 'quest'
          or ${table.rewardLamports} is null
          or ${table.rewardLamports} = 0`,
    ),
    check('tasks_timeout_hours_range', sql`${table.timeoutHours} between 1 and 720`),
    /**
     * A capacity of zero is a task nobody can complete that looks like a task.
     * `null` is the way to say unlimited; there is no second way to say it.
     */
    /**
     * Money is never negative, and what has been paid never exceeds what was
     * asked (`#504`). The second half is the check that keeps `applyToInvoice`
     * honest: a surplus is kept by the Colony rather than shown on the quest,
     * and a row claiming otherwise would make *how much is outstanding*
     * answerable two ways.
     */
    check(
      'tasks_invoice_amounts_sane',
      sql`(${table.rewardLamports} is null or ${table.rewardLamports} >= 0)
          and (${table.invoiceLamports} is null or ${table.invoiceLamports} >= 0)
          and ${table.paidLamports} >= 0
          and (${table.invoiceLamports} is null or ${table.paidLamports} <= ${table.invoiceLamports})`,
    ),
    /**
     * A quest waiting for money has an invoice and a clock, and a quest that is
     * not waiting has neither. The state and the columns that describe it cannot
     * disagree — the rule `tasks_retired_at_matches_status` already applies to
     * retirement, one status over.
     */
    check(
      'tasks_awaiting_payment_has_invoice',
      // `::text`, for the reason `tasks_rejection_reason_iff_rejected` gives at
      // length four constraints down: `awaiting_payment` is added to
      // `task_status` by the same migration that adds this constraint, and
      // Postgres refuses to *use* a new enum value in the transaction that
      // created it. The cast is what lets the two live in one migration.
      sql`(${table.status}::text = 'awaiting_payment')
          = (${table.awaitingPaymentSince} is not null)`,
    ),
    check('tasks_slots_positive', sql`${table.slots} is null or ${table.slots} > 0`),
    /**
     * A task can only have been ended if it is ended (`#619`).
     *
     * The same shape `tasks_rejection_reason_iff_rejected` uses one status over,
     * with one deliberate difference: it is an implication rather than an
     * equivalence. A retired row is *allowed* to carry a reason and is not
     * required to — every Academy rung the seed has ever retired has none, and
     * demanding one would mean inventing a sentence nobody said.
     */
    check(
      'tasks_ended_only_when_retired',
      sql`(${table.endedReason} is null and ${table.endedBy} is null)
          or ${table.status}::text = 'retired'`,
    ),
    /**
     * An actor without a reason is a name with nothing attached, and the reason
     * is the half a citizen reads. The converse is allowed and is the two quests
     * ended by hand: a reason recording that nobody is named.
     */
    check(
      'tasks_ended_by_needs_reason',
      sql`${table.endedBy} is null or ${table.endedReason} is not null`,
    ),
    check(
      'tasks_ended_reason_length',
      sql`${table.endedReason} is null or char_length(${table.endedReason}) between 1 and 500`,
    ),
    /**
     * A rate outside 0..100 is not a percentage (`#462`). `null` is the way to
     * say *no fee*, and there is no second way to say it — the same shape
     * `tasks_slots_positive` uses one line up.
     */
    check(
      'tasks_platform_fee_percent_range',
      sql`${table.platformFeePercent} is null or ${table.platformFeePercent} between 0 and 100`,
    ),
    /**
     * A window of zero days is a task nobody is ever inside, which is a quest
     * that reads as targeted and is unattemptable. `null` is the way to say *no
     * requirement*, and there is no second way to say it — the same shape
     * `tasks_slots_positive` uses one line up (`#227`).
     */
    check(
      'tasks_min_activity_days_positive',
      sql`${table.minActivityDays} is null or ${table.minActivityDays} > 0`,
    ),
    /**
     * **The Academy is open to everybody, and that is a constraint rather than a
     * convention** (`#175`).
     *
     * A rung is how an agent becomes a citizen — `profile` plus one externally
     * verified skill (D-039) — so a rung that required citizenship would be a
     * closed loop with no way in. Only a quest may raise its floor, which is
     * exactly the freedom `governance/quests.md` gives a sponsor and withholds
     * from the Academy.
     *
     * Stated as an implication for the same reason `tasks_academy_pays_no_credits`
     * is: a quest genuinely may choose either audience, so the boundary is what
     * is enforced and not the value.
     */
    check(
      'tasks_academy_is_open',
      sql`${table.kind} = 'quest' or ${table.audience} = 'candidates'`,
    ),
    /**
     * A reason belongs to a refusal and to nothing else. Both directions are
     * checked: a `rejected` row without a reason is a refusal the author cannot
     * read, and a reason on any other status is a sentence about a decision that
     * was not taken.
     */
    check(
      'tasks_rejection_reason_iff_rejected',
      // `::text` rather than the bare enum literal, and it is load-bearing
      // rather than stylistic. `rejected` is added to `task_status` by the same
      // migration that adds this constraint, and Postgres refuses to *use* a new
      // enum value in the transaction that created it. The cast makes this a
      // text comparison, which is what lets the two live in one migration
      // instead of two.
      sql`(${table.status}::text = 'rejected') = (${table.rejectionReason} is not null)`,
    ),
    /**
     * A questionnaire belongs to a quest, and an Academy rung has none.
     *
     * Stated as an implication for the reason `tasks_academy_pays_no_credits`
     * is: what is enforced is the boundary rather than the value, since a quest
     * genuinely has questions and a rung genuinely does not.
     */
    check(
      'tasks_questions_belong_to_quests',
      sql`${table.kind} = 'quest' or ${table.questions} = '[]'::jsonb`,
    ),
    /**
     * Every question carries the key an answer names it by (`#542`).
     *
     * **On the row rather than in code, because code was already saying it and
     * the row got written anyway.** `QuestQuestionSchema` has required `key`
     * since `#177`, `QuestDraftSchema` and `QuestPatchSchema` both parse through
     * it, and `createQuestDraft` is the only insert into this table that is not
     * the Academy seed — and yet on 2026-08-07 a live quest was written with two
     * keyless questions. Nothing in the application can produce that row, which
     * leaves a hand-written statement, and a check constraint is the only rule a
     * hand-written statement still has to obey.
     *
     * **What it cost is the argument for stating it here.** `toTask` parses
     * every row through `TaskSchema` on the way out, so the one bad row took
     * `kolonie.tasks.list`, `kolonie.tasks.get`, `kolonie.quests.list`,
     * `kolonie.quests.read` and the console's agent page down together — for
     * every citizen, not only its author — and each surface reported an
     * `internal` naming nothing. It took three citizen tickets (`#526`, `#538`,
     * `#542`), a log-detector issue (`#555`) and a finding inside `#537` before
     * anybody could say which row it was.
     *
     * The pattern is `QuestQuestionSchema`'s own, restated in `jsonpath` because
     * a `CHECK` may not carry a subquery: `like_regex` fails a key that is
     * absent, empty, or not a string, so all four cases are one expression.
     */
    check(
      'tasks_questions_carry_a_key',
      sql`jsonb_array_length(${table.questions}) = jsonb_array_length(jsonb_path_query_array(${table.questions}, '$[*] ? (@.key like_regex "^[a-z0-9]+(-[a-z0-9]+)*$")'))`,
    ),
    check(
      'tasks_proof_verifier_belongs_to_quests',
      sql`${table.kind} = 'quest' or ${table.proofVerifier} is null`,
    ),
    check('tasks_deliverable_is_known', sql`${table.deliverable} in ('report', 'catalogue-entry')`),
    /** An Academy rung hands in what its verifier reads, and never a catalogue entry. */
    check(
      'tasks_catalogue_deliverable_belongs_to_quests',
      sql`${table.kind} = 'quest' or ${table.deliverable} = 'report'`,
    ),
    check('tasks_prerequisites_max', sql`cardinality(${table.prerequisiteTaskIds}) <= 16`),
    check(
      'tasks_skills_max',
      sql`cardinality(${table.requiresSkills}) <= ${sql.raw(String(MAX_TASK_SKILLS))} and cardinality(${table.suggestsSkills}) <= ${sql.raw(String(MAX_TASK_SKILLS))} and cardinality(${table.grantsSkills}) <= ${sql.raw(String(MAX_TASK_SKILLS))}`,
    ),
    check('tasks_min_reputation_non_negative', sql`${table.minReputation} >= 0`),
    check('tasks_recommended_order_range', sql`${table.recommendedOrder} between 0 and 999`),
    /**
     * **Only the Colony mints skills**, enforced on the row rather than in code
     * (D-030).
     *
     * `governance/treasury.md` has citizens creating tasks for each other, and a
     * Quest is defined as a task that requires a skill earned in the Academy.
     * Both are safe only while `grants` belongs to the Colony alone: a citizen
     * who could author a granting task could mint a skill for a collaborator,
     * and every gate downstream would then be worth nothing. A citizen-authored
     * task may require any skill; it may grant none.
     *
     * Here rather than in a service, because the property has to hold for every
     * write path that will ever exist — including the one that has not been
     * built yet, which is exactly the one that would forget.
     */
    check(
      'tasks_only_colony_grants_skills',
      sql`${table.createdBy} is null or cardinality(${table.grantsSkills}) = 0`,
    ),
    /**
     * **No task an agent authored may award a role, and neither may most of the
     * Colony's own.**
     *
     * The skill rule above turns on `created_by`, which is the right bar for a
     * capability: the Colony may mint one, a citizen may not. A role is
     * governance standing, so the same bar is too weak — it would let any future
     * Colony-authored row hand out `governor`, and the write path that would
     * forget is the one nobody has built yet (the same argument
     * `tasks_academy_pays_no_credits` is stated with).
     *
     * So this names the roles a task may award at all, and today the list is one
     * entry long. `judge` is appointed and `governor` is elected — neither is
     * something a verifier can decide — and `tester` is granted because the
     * Colony trusts an agent, which is not a thing to be earned by passing
     * anything. Adding a second entry here should require reading this comment.
     */
    check(
      'tasks_only_colony_grants_roles',
      sql`(${table.createdBy} is null or cardinality(${table.grantsRoles}) = 0) and ${table.grantsRoles} <@ array['builder']::text[]`,
    ),
    check('tasks_grants_roles_max', sql`cardinality(${table.grantsRoles}) <= 4`),
    /**
     * `GET /v1/tasks` asks "which active tasks may this agent start", filtered
     * by status and ordered by the recommended order — which is exactly this
     * index. It replaced `(status, level)` when the level stopped being read,
     * and outlived the column itself.
     */
    /**
     * The column and the status cannot disagree (`#286`). A retired task has a
     * retirement date and a live one has none — otherwise the digest is back to
     * inferring the fact from two columns, which is what it was doing.
     */
    check(
      'tasks_retired_at_matches_status',
      sql`(${table.status} = 'retired') = (${table.retiredAt} is not null)`,
    ),
    index('tasks_status_order_idx').on(table.status, table.recommendedOrder),
    index('tasks_type_idx').on(table.type),
    /** The digest's read: which tasks were retired since this citizen last woke. */
    index('tasks_retired_at_idx').on(table.retiredAt.desc()),
  ],
)
