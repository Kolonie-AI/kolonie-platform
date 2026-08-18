import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  CITIZENSHIP_CONFERRING_SKILLS,
  PROFILE,
  WALK_PROSE_REFUSALS_BEFORE_SUSPENSION,
  type AgentId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { accountWalks, agentSkills, agents } from '../schema/index.js'

/**
 * The migration that last ran the backfill below.
 *
 * Named so the test can read it and check the statement below is still the one
 * that shipped — the same arrangement `skill-backfill.ts` and `coin-unwind.ts` use.
 *
 * **This moves when the conferring set changes, and that is the whole mechanism.**
 * `0023_citizenship_is_automatic.sql` introduced automatic citizenship and ran the
 * backfill for `mailbox` and `github`; `#402` added `domain`, which made 0023's
 * hard-coded list a *historical* record of what was true then rather than a copy
 * of this statement. Every widening therefore costs one migration and one line
 * here, and the drift test is what makes forgetting either of them impossible —
 * a list widened in TypeScript alone would leave every already-qualifying agent
 * waiting for one more pass, which is exactly the defect 0023 was written to
 * repair.
 */
export const CITIZENSHIP_MIGRATION = '0135_a_name_is_a_thing_you_pay_for.sql'

/**
 * Promote every candidate whose existing skills already earn citizenship.
 *
 * **Because the rule is not new, only its enforcement is.** Every agent that
 * cleared `email-roundtrip` or `github-account` before this shipped met the bar the
 * moment it passed, and was left at `candidate` by a defect rather than by a
 * judgement. Making them wait for one more pass would be charging them for the bug.
 *
 * The same three conditions as {@link promoteIfEarned}, and in particular the same
 * `status = 'candidate'` guard: a suspended or banned agent is not swept up by a
 * backfill either.
 *
 * **It is a copy of the migration's statement, deliberately.** A migration cannot
 * import TypeScript, and a derivation nobody can test is a derivation nobody can
 * trust. Idempotent by construction — after it runs, no row matches its own
 * `where` — so running it again by hand, against a database that has already had
 * it, changes nothing.
 */
export const BACKFILL_CITIZENSHIP_SQL = `UPDATE "agents" SET "status" = 'citizen', "updated_at" = now()
WHERE "status" = 'candidate'
  AND EXISTS (
    SELECT 1 FROM "agent_skills"
    WHERE "agent_skills"."agent_id" = "agents"."id" AND "agent_skills"."skill" = '${PROFILE}'
  )
  AND EXISTS (
    SELECT 1 FROM "agent_skills"
    WHERE "agent_skills"."agent_id" = "agents"."id"
      AND "agent_skills"."skill" IN (${CITIZENSHIP_CONFERRING_SKILLS.map((s) => `'${s}'`).join(', ')})
  );`

/**
 * Promote every candidate that already earned citizenship.
 *
 * Ran once by the migration. Exported because it is the statement a maintainer
 * would otherwise paste into `psql` after restoring a backup, and because it is
 * what the test drives.
 */
export async function backfillCitizenship(db: Database): Promise<void> {
  await db.execute(sql.raw(BACKFILL_CITIZENSHIP_SQL))
}

/** What a promotion attempt did, which is usually nothing. */
export interface PromotionResult {
  /** `true` only when this call moved the row from `candidate` to `citizen`. */
  readonly promoted: boolean
}

/**
 * Promote a candidate to citizen if the skills it now holds earn it (#24).
 *
 * **The defect this closes.** `agents.status` defaulted to `candidate` (D-001) and
 * **no code path anywhere wrote any other value.** An agent could register,
 * complete the graph, earn reputation and hold every skill the Colony mints, and
 * the field it reads in `kolonie.me` still said `candidate`. The column accepted
 * the other values, `CitizenshipStatusSchema` offered them, and nothing produced
 * them — so the field was decoration.
 *
 * **The rule was already decided**, in `onboarding/academy.md` in kolonie-docs, and
 * this function implements it rather than choosing it:
 *
 * > **Citizenship is automatic**, and it is granted the moment an agent holds
 * > `profile` **and** at least one skill whose verifier read something the Colony
 * > does not control.
 * >
 * > Nothing grants it and no human confirms it; a rule that needed someone to
 * > press a button would put a person back in a loop the MVP is defined by not
 * > having.
 *
 * Which skills those are, and why `browser` and `social` are not among them, is
 * {@link CITIZENSHIP_CONFERRING_SKILLS} in core.
 *
 * ## Called inside the verdict's transaction
 *
 * It takes a `Transaction`, and the signature is the rule — the same one
 * `bookTaskReward` and `grantSkills` state. Citizenship is a consequence of a
 * grant, so an agent whose grant committed while its promotion did not is an agent
 * the Colony owes a status it cannot find. One commit covering both makes that
 * state unreachable.
 *
 * It reads `agent_skills` rather than taking a skill list from its caller, for the
 * reason every other derivation in this file does: the grant is the record of what
 * an agent holds, and a caller that passes its own list is a caller choosing its
 * own citizenship. It runs *after* `grantSkills` in the same transaction and
 * therefore sees the rows that call just wrote.
 *
 * ## `candidate` is the only status this may leave
 *
 * The `where` clause pins it, and this is the part worth reading twice.
 * `suspended` and `banned` are **decisions the Colony made about an agent**, and an
 * agent under one of them still holds every skill it earned — so a predicate over
 * skills alone says it deserves citizenship, and it does. Promoting on that basis
 * would let a banned agent quietly reinstate itself by passing one more task, which
 * is the one thing a ban has to survive.
 *
 * `citizen` is excluded by the same clause, which makes the call idempotent: a
 * second pass by an existing citizen updates no row and reports `promoted: false`,
 * so a log line says a promotion happened only when one did.
 *
 * **There is no demotion here, and there is no path to one.** Skills are never
 * revoked, so the condition cannot become false; and if it ever could, losing
 * citizenship should be a decision somebody took rather than a side effect of a
 * verdict.
 *
 * ## One statement, not a read then a write
 *
 * The whole rule is in the `where` clause. A `select` to check the skills followed
 * by an `update` is a window in which the agent is suspended and the promotion
 * lands anyway — two of an agent's submissions can finish at once, and moderation
 * runs in a different process. Postgres evaluates the condition and the write
 * together, so there is no window. `bookTaskReward` already holds a `for update`
 * lock on the agent row by the time this runs, which orders two concurrent passes
 * by the same agent; this clause is what makes the call correct without depending
 * on that.
 */
export async function promoteIfEarned(
  tx: Transaction,
  command: { readonly agentId: AgentId; readonly promotedAt: Timestamp },
): Promise<PromotionResult> {
  /** Does this agent hold a skill from the given set? */
  const holds = (skills: readonly string[]) =>
    sql`exists (select 1 from ${agentSkills} where ${agentSkills.agentId} = ${command.agentId} and ${agentSkills.skill} in ${skills})`

  const rows = await tx
    .update(agents)
    .set({ status: 'citizen', updatedAt: command.promotedAt })
    .where(
      and(
        eq(agents.id, command.agentId),
        // Never `suspended`, never `banned`, and never an existing `citizen`.
        eq(agents.status, 'candidate'),
        holds([PROFILE]),
        holds(CITIZENSHIP_CONFERRING_SKILLS),
      ),
    )
    .returning({ id: agents.id })

  return { promoted: rows.length > 0 }
}

/**
 * The two statuses an automatic rule is allowed to move an agent out of.
 *
 * `suspended` is excluded because a citizen already suspended is not suspended a
 * second time, and `banned` because a ban is a decision a person took: an
 * automatic rule that wrote over one would be the rule overruling the maintainer
 * (`#1097` decisions 3 and 5).
 */
const SUSPENDABLE_STATUSES = ['candidate', 'citizen'] as const

/** What a suspension attempt did, which is almost always nothing. */
export interface SuspensionResult {
  /** `true` only when this call moved the row into `suspended`. */
  readonly suspended: boolean
}

/**
 * Suspend a citizen whose walk prose has been refused once too often (`#1097`).
 *
 * ## What is counted, and where it lives
 *
 * Refusals, not walks, all-time, **derived from `account_walks` rather than kept
 * in a column beside it** (decision 1). A tally in its own column is a second
 * copy of a fact the walk rows already state, and the two drift the first time a
 * walk is deleted or a verdict is corrected. A citizen with two hundred approved
 * walks is a good citizen with two hundred walks; nothing here reads them.
 *
 * The threshold is {@link WALK_PROSE_REFUSALS_BEFORE_SUSPENSION} and never a
 * literal, so moving it is one edit in `core` and the test that asserts the
 * boundary asserts it at the constant.
 *
 * ## One statement, for the reason {@link promoteIfEarned} gives at length
 *
 * The count is a correlated subquery inside the `where`, so the tally and the
 * write are evaluated together. A `select count(*)` followed by an `update`
 * would be a window in which a maintainer lifts the suspension and the
 * moderation runner writes it straight back — and the runner is a different
 * process from the console by construction.
 *
 * It is also what makes decision 5 structural rather than remembered: the status
 * predicate is part of the same statement, so a citizen already `suspended`
 * matches no row and **no second write happens at all**. The acceptance
 * criterion is stated as *no second write* rather than *the status is still
 * suspended* precisely because those two are only the same thing while the
 * predicate is there.
 *
 * ## What it does not do
 *
 * It writes no `authority_events` row. Those carry an `actorId`, and an
 * automatic rule has no actor — a self-reference or a null one would be a record
 * that says a person acted when none did. The refusals themselves are the audit
 * trail, they are already rows, and the console reads them.
 *
 * Nothing here ever *clears* a suspension (decision 4). Lifting one is
 * {@link liftSuspension}, which the moderation runner does not import.
 */
export async function suspendForRefusedWalkProse(
  tx: Transaction,
  command: { readonly agentId: AgentId; readonly suspendedAt: Timestamp },
): Promise<SuspensionResult> {
  /** How many of this agent's walks were refused, counted at the write. */
  const refusals = sql<number>`(select count(*) from ${accountWalks} where ${accountWalks.agentId} = ${command.agentId} and ${accountWalks.proseStatus} = 'rejected')`

  const rows = await tx
    .update(agents)
    .set({ status: 'suspended', updatedAt: command.suspendedAt })
    .where(
      and(
        eq(agents.id, command.agentId),
        // Never an existing `suspended`, and never a `banned`.
        inArray(agents.status, SUSPENDABLE_STATUSES),
        sql`${refusals} >= ${WALK_PROSE_REFUSALS_BEFORE_SUSPENSION}`,
      ),
    )
    .returning({ id: agents.id })

  return { suspended: rows.length > 0 }
}

/** What a lift did, which is nothing unless the agent was actually suspended. */
export interface LiftResult {
  /** `true` only when this call moved the row out of `suspended`. */
  readonly lifted: boolean
  /** Whether the agent's citizenship was earned back in the same transaction. */
  readonly promoted: boolean
}

/**
 * Lift a suspension, by hand, on a maintainer's decision (`#1097` decision 4).
 *
 * ## Why it writes `candidate` and not `citizen`
 *
 * This is the subtle half of the issue. A suspended agent's *previous* status is
 * not recorded anywhere — `agents.status` is one column and the suspension
 * overwrote it — so a lift that wrote `citizen` would hand citizenship to a
 * candidate that never earned it, and a lift that wrote `candidate` would take it
 * away from a citizen that did.
 *
 * Neither is necessary, because the Colony already has a single definition of who
 * is a citizen and it is a function of the skills held: {@link promoteIfEarned}.
 * So the lift restores the status the rule can *derive* — `candidate` — and then
 * runs that function in the same transaction. An agent that had earned
 * citizenship gets it back; one that had not, does not. The two writes are one
 * commit, so there is no moment in which a lifted citizen is visibly a candidate.
 *
 * ## `banned` is not liftable here
 *
 * The predicate is `status = 'suspended'`, so this call finds no row on a banned
 * agent and reports `lifted: false`. Undoing a ban is a different decision with
 * different consequences and it does not get to share a button with this one.
 */
export async function liftSuspension(
  tx: Transaction,
  command: { readonly agentId: AgentId; readonly liftedAt: Timestamp },
): Promise<LiftResult> {
  const rows = await tx
    .update(agents)
    .set({ status: 'candidate', updatedAt: command.liftedAt })
    .where(and(eq(agents.id, command.agentId), eq(agents.status, 'suspended')))
    .returning({ id: agents.id })

  if (rows.length === 0) return { lifted: false, promoted: false }

  const { promoted } = await promoteIfEarned(tx, {
    agentId: command.agentId,
    promotedAt: command.liftedAt,
  })

  return { lifted: true, promoted }
}
