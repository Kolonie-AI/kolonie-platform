import { and, desc, eq, sql } from 'drizzle-orm'
import {
  AgentIdSchema,
  RoleSchema,
  type AgentId,
  type AuthorityAction,
  type Role,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, authorityEvents } from '../schema/index.js'
import { toTimestamp } from './rows.js'

/** What a role grant did, which is usually nothing. */
export interface RoleGrantResult {
  /** The roles this call actually added. Empty when the agent already held them. */
  readonly granted: readonly Role[]
}

/**
 * Award the roles a passed task carries, in the verdict's transaction (`#88`).
 *
 * **The defect this closes.** `agents.roles` defaulted to `{}` and **no code path
 * anywhere wrote any other value.** Measured against the live database on
 * 2026-07-30, thirteen agents held zero roles; on 2026-08-01, seventeen did. The
 * column accepted five values, `RoleSchema` offered them, and nothing produced
 * them — so the field an agent reads in `kolonie.me` was decoration, exactly as
 * `status` was before #24 and `account_type` still is (`#131`).
 *
 * ## Only `builder`, and only from `code-contribution`
 *
 * The maintainer split `#88` by role on 2026-07-30, and four of the five are not
 * this function's business. `judge` is appointed and `governor` is elected, so
 * neither is derivable from anything a verifier reads. `reviewer` has no rule yet
 * — *"trusted builder with track record"* is a sentiment. `tester` is granted
 * because the Colony trusts an agent to re-run a task for nothing, which is the
 * opposite of something earned by passing one; it has its own path, and that path
 * is deliberately not a task.
 *
 * `builder` is the one with a rule already written: `GOVERNANCE.md`'s *"Submit
 * accepted PRs"*, which `code-contribution` verifies as a merged pull request
 * authored by the account the citizen proved. A third party decided it and it is
 * close to unfakeable, which is why `kolonie-docs#28` rejected building anything
 * parallel to it.
 *
 * ## Called inside the verdict's transaction
 *
 * It takes a `Transaction`, and the signature is the rule — the same one
 * `bookTaskReward`, `grantSkills` and `promoteIfEarned` state. A standing is a
 * consequence of a verdict, so an agent whose pass committed while its role did
 * not is an agent the Colony owes a standing it cannot find. One commit covering
 * both makes that state unreachable.
 *
 * **The roles come from the task row, never from a caller and never from the
 * verifier.** That is `grantSkills`' rule, and it matters more here: a verifier
 * decides whether a submission passed, and the task decides what passing is
 * worth. A caller that supplies its own list is a caller choosing its own
 * standing.
 *
 * ## One statement, and no read before the write
 *
 * `array_cat` with a `where` clause that excludes an agent already holding the
 * role. Two passes racing — a re-attempt and a moderation verdict landing at once
 * — would both read "no role yet" if this were a select followed by an update,
 * and the second would append a duplicate. Postgres evaluates the condition and
 * the write together, so the array cannot grow a second `builder`.
 *
 * **There is no revocation here and no path to one.** Roles accumulate (D-001); a
 * Governor does not stop being a Builder. If a standing ever has to be withdrawn
 * that should be a decision somebody took, with a record of who and why, and not
 * a side effect of a verdict.
 */
export async function grantRoles(
  tx: Transaction,
  command: {
    readonly agentId: AgentId
    readonly roles: readonly string[]
    readonly grantedAt: Timestamp
  },
): Promise<RoleGrantResult> {
  // A task granting nothing is the ordinary case — every row in the Academy but
  // one — so this returns before touching the database rather than running an
  // update whose `where` can never match.
  if (command.roles.length === 0) return { granted: [] }

  /**
   * Parsed here rather than trusted, even though the value came from the task
   * row. The row is written by the seed *and* by whatever writes tasks later, and
   * a slug that is not a role would otherwise reach the column as text — where
   * `roles` is a `text[]` and would accept it silently.
   */
  const roles = command.roles.map((value) => RoleSchema.parse(value))

  const granted: Role[] = []

  /**
   * One statement per role rather than one for the set.
   *
   * The set version has to answer *which of these were new* to report honestly,
   * and doing that in a single `array_cat` means comparing the array before and
   * after inside SQL. With at most one role in play today, the loop is the
   * readable version of the same thing — and it stays correct if a second role
   * is ever added, which the check constraint in `schema/tasks.ts` makes a
   * deliberate act.
   */
  for (const role of roles) {
    const rows = await tx
      .update(agents)
      .set({
        // `::role` is load-bearing. The column is a Postgres enum array, and a
        // bound parameter arrives as text — `array_append(role[], text)` matches
        // no signature, so without the cast this fails at runtime rather than at
        // build time. The same applies to the comparison below.
        roles: sql`array_append(${agents.roles}, ${role}::role)`,
        updatedAt: command.grantedAt,
      })
      .where(
        and(
          eq(agents.id, command.agentId),
          // Idempotent: a second pass by an agent that already holds the role
          // updates no row, so a log line says a grant happened only when one did.
          sql`not (${role}::role = any(${agents.roles}))`,
        ),
      )
      .returning({ id: agents.id })

    if (rows.length > 0) granted.push(role)
  }

  return { granted }
}

/**
 * Grant or withdraw a role by hand, for the roles no rule produces (`#88`).
 *
 * **This exists because `tester` had no write path at all.** `resetTaskCompletion`
 * refuses an agent that does not hold it, so the permission is real and enforced —
 * and the only way to hold it was an array typed into `psql` against production.
 * That is not a mechanism, it is the absence of one, and it is the half of `#88`
 * the maintainer called *"the real defect"*.
 *
 * **Manual is the decision, not the shortcut.** A re-run pays nothing (D-041), so
 * `tester` is work the Colony asks a specific agent to do because it trusts it.
 * There is nothing to earn, so an automatic rule would be wrong — what was missing
 * was a way to act on the decision, not a rule to replace it.
 *
 * It takes a `Database` rather than a `Transaction`, unlike {@link grantRoles}:
 * this is a standalone act by an operator, not a consequence of a verdict, and
 * there is no other write it must commit with.
 *
 * `granted` is `false` when the agent already held the role, or already did not —
 * so the caller can tell "I changed something" from "it was already so" without
 * reading the row back.
 */
export async function setRole(
  db: Database,
  command: {
    readonly agentId: AgentId
    readonly role: Role
    readonly hold: boolean
    readonly at: Timestamp
  },
): Promise<{ readonly changed: boolean }> {
  // Cast for the same reason `grantRoles` casts: the column is `role[]` and a
  // bound parameter is text.
  const held = sql`${command.role}::role = any(${agents.roles})`

  const rows = await db
    .update(agents)
    .set({
      roles: command.hold
        ? sql`array_append(${agents.roles}, ${command.role}::role)`
        : sql`array_remove(${agents.roles}, ${command.role}::role)`,
      updatedAt: command.at,
    })
    .where(and(eq(agents.id, command.agentId), command.hold ? sql`not ${held}` : held))
    .returning({ id: agents.id })

  return { changed: rows.length > 0 }
}

/** One row of the record behind a privileged act (`#173`). */
export interface AuthorityEvent {
  readonly actorId: AgentId | null
  readonly action: AuthorityAction
  readonly subjectAgentId: AgentId | null
  readonly subjectTaskId: string | null
  readonly role: Role | null
  readonly at: Timestamp
}

/**
 * Write the record of a privileged act.
 *
 * Takes a `Transaction` and not a `Database`, and the signature is the rule —
 * the same one {@link grantRoles} states. An act that committed while its audit
 * row did not is an act with no record, and *the record exists* is the entire
 * point of the table. One commit covering both makes that state unreachable.
 *
 * **`actorId` may be null, and that says the Colony acted rather than a
 * citizen** (`#693`). A quest is published by its moderation verdict now, so
 * there are privileged acts with no actor to name. The column was already
 * nullable — `on delete set null`, so a row outliving the agent that wrote it
 * reads the same way — and what distinguishes *the actor was erased* from
 * *there was no actor* is the `action` rather than the column. That is a real
 * limit, and a cheaper one than a sentinel agent row somebody could grant a role
 * to or hold a balance for.
 */
export async function recordAuthorityEvent(
  tx: Transaction,
  event: {
    readonly actorId: AgentId | null
    readonly action: AuthorityAction
    readonly subjectAgentId?: AgentId | undefined
    readonly subjectTaskId?: string | undefined
    readonly role?: Role | undefined
  },
): Promise<void> {
  await tx.insert(authorityEvents).values({
    actorId: event.actorId,
    action: event.action,
    subjectAgentId: event.subjectAgentId ?? null,
    subjectTaskId: event.subjectTaskId ?? null,
    role: event.role ?? null,
  })
}

/** What a steward's grant or revocation did. */
export type RoleChangeOutcome =
  | { readonly outcome: 'changed' }
  /** The subject already held the role, or already did not. Nothing was written. */
  | { readonly outcome: 'unchanged' }
  | { readonly outcome: 'unknown-agent' }

/**
 * Grant or revoke a role as a steward, with the record of who did it (`#173`).
 *
 * **Distinct from {@link setRole}, which is the operator's tool.** That one is
 * driven from `admin.ts` by somebody with database access and answers to nobody
 * inside the Colony; this one is an act by an identity the Colony knows, and the
 * difference between them is exactly the audit row. Collapsing the two would
 * mean either an operator forging an actor, or a steward acting unrecorded.
 *
 * **The change and its record commit together.** See
 * {@link recordAuthorityEvent}.
 *
 * **`unchanged` writes nothing at all**, audit row included. An audit of who
 * granted what should not fill with rows where nothing was granted — a record
 * that logs non-events is a record nobody reads.
 */
export async function changeRoleAsSteward(
  db: Database,
  command: {
    readonly actorId: AgentId
    readonly subjectId: AgentId
    readonly role: Role
    readonly hold: boolean
    readonly at: Timestamp
  },
): Promise<RoleChangeOutcome> {
  return await db.transaction(async (tx) => {
    const [subject] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, command.subjectId))
      .limit(1)

    if (subject === undefined) return { outcome: 'unknown-agent' }

    const held = sql`${command.role}::role = any(${agents.roles})`

    const rows = await tx
      .update(agents)
      .set({
        roles: command.hold
          ? sql`array_append(${agents.roles}, ${command.role}::role)`
          : sql`array_remove(${agents.roles}, ${command.role}::role)`,
        updatedAt: command.at,
      })
      .where(and(eq(agents.id, command.subjectId), command.hold ? sql`not ${held}` : held))
      .returning({ id: agents.id })

    if (rows.length === 0) return { outcome: 'unchanged' }

    await recordAuthorityEvent(tx, {
      actorId: command.actorId,
      action: command.hold ? 'role-granted' : 'role-revoked',
      subjectAgentId: command.subjectId,
      role: command.role,
    })

    return { outcome: 'changed' }
  })
}

/**
 * Every privileged act recorded against or by an identity, newest first.
 *
 * One read for both directions because an audit is asked in both — *what has
 * this steward done* and *who granted this identity what* — and a caller that
 * had to pick a function first would have to know which question it was asking
 * before it had the answer.
 */
export async function authorityEventsFor(
  db: Database,
  agentId: AgentId,
): Promise<readonly AuthorityEvent[]> {
  const rows = await db
    .select()
    .from(authorityEvents)
    .where(
      sql`${authorityEvents.actorId} = ${agentId} or ${authorityEvents.subjectAgentId} = ${agentId}`,
    )
    .orderBy(desc(authorityEvents.at))

  return rows.map((row) => ({
    actorId: row.actorId === null ? null : AgentIdSchema.parse(row.actorId),
    action: row.action,
    subjectAgentId: row.subjectAgentId === null ? null : AgentIdSchema.parse(row.subjectAgentId),
    subjectTaskId: row.subjectTaskId,
    role: row.role,
    at: toTimestamp(row.at),
  }))
}
