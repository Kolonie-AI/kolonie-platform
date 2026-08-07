import { index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { humans } from './humans.js'
import { tasks } from './tasks.js'
import { authorityAction, role } from './enums.js'

/**
 * Who let this happen — the record behind every privileged act (`#173`).
 *
 * ## Why a table and not a log line
 *
 * Reputation and skills have never needed one, and that is not an inconsistency.
 * A skill grant is derivable: the submission, the verification and the verdict
 * are all rows, and the grant is what they add up to. A *permission* is not — a
 * steward granting another steward leaves nothing behind but the changed array
 * on `agents.roles`, and the array says who holds the role and nothing about who
 * decided that.
 *
 * The quest programme is the first place in the Colony where **one account's
 * decision moves another account's money**. The question *who let this money
 * move* has to have an answer that survives the actor, and a log line does not:
 * logs rotate, are not queryable beside the rows they describe, and are not part
 * of any backup the ledger is part of.
 *
 * ## Why the actor is nullable
 *
 * `on delete set null`, exactly as `tasks.created_by` is. `governance/erasure.md`
 * gives every citizen the right to delete itself and everything it wrote, and a
 * steward is a citizen. The audit row is not the citizen's writing — it is the
 * Colony's record of a decision that moved somebody else's money — so it stays,
 * and it stays naming nobody.
 *
 * That is the same trade `tasks.created_by` already makes and the same one
 * `erasure.md` argues for: what the Colony built out of an act survives; the
 * actor does not.
 */
export const authorityEvents = pgTable(
  'authority_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Who did it, or `null` once that identity has been erased.
     *
     * Never the subject of the act. A steward granting itself a role is not a
     * thing that can happen — the first steward comes from a migration — so
     * actor and subject differing is the ordinary case rather than a check.
     */
    actorId: uuid('actor_id').references(() => agents.id, { onDelete: 'set null' }),

    action: authorityAction('action').notNull(),

    /**
     * The identity the act was about, for the acts that have one.
     *
     * Null for a quest publication, which is about a task. The two subject
     * columns are separate rather than one polymorphic id, because a foreign key
     * that sometimes points at one table and sometimes at another is a foreign
     * key the database cannot enforce — and this is the one table where an
     * unenforceable reference would be worst.
     */
    subjectAgentId: uuid('subject_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),

    /**
     * The *person* the act was about, for the acts that are about one (`#485`).
     *
     * Added when `humans.roles` did, and for the reason this table already
     * gives one column up: a permission is not derivable. Granting a person the
     * `maintainer` role leaves nothing behind but the changed array on
     * `humans.roles`, and the array says who holds the role and nothing about
     * who decided that.
     *
     * **A third separate column rather than a polymorphic id**, on the argument
     * `subject_agent_id` states: a foreign key that sometimes points at one
     * table and sometimes at another is a foreign key the database cannot
     * enforce, and this is the one table where that would be worst.
     *
     * `on delete set null`, exactly as the other two are. `#429` gives a person
     * the right to have everything about them deleted; the Colony's record of a
     * decision is not the person's writing, so it stays, naming nobody.
     */
    subjectHumanId: uuid('subject_human_id').references(() => humans.id, {
      onDelete: 'set null',
    }),

    /** The quest a publication was about. Null for a role grant or revocation. */
    subjectTaskId: uuid('subject_task_id').references(() => tasks.id, { onDelete: 'set null' }),

    /**
     * Which role was granted or revoked. Null for the acts that are not about one.
     *
     * **Null for a *human* grant as well, and there is no second column for
     * one (`#485`).** `HumanRole` has exactly one member, so a `human_role`
     * column here would carry no information: `role-granted` with
     * `subject_human_id` set already says everything a `maintainer` row could.
     * Adding the column now would be the vocabulary-ahead-of-the-case that
     * `HumanRoleSchema` refuses one file over.
     *
     * It is written down rather than left implicit so that the day a second
     * human role exists, this is a known gap to fill rather than a surprise —
     * and so nobody reads the null as a bug.
     */
    role: role('role'),

    at: timestamp('at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * *What has this steward done* — the question an audit is read with, and the
     * one a review of a suspected abuse starts from.
     */
    index('authority_events_actor_idx').on(table.actorId, table.at.desc()),
    /** *Who granted this identity what* — the same question from the other end. */
    index('authority_events_subject_idx').on(table.subjectAgentId, table.at.desc()),
    /** And the same question about a person (`#485`). */
    index('authority_events_subject_human_idx').on(table.subjectHumanId, table.at.desc()),
  ],
)
