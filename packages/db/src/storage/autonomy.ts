import { randomBytes } from 'node:crypto'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import {
  AUTONOMY_FORM_LIFETIME_MS,
  AUTONOMY_FORM_TOKEN_BYTES,
  AUTONOMY_REVIEW_INTERVAL_DAYS,
  type AgentId,
  type AutonomyContract,
  type StoredAutonomyContract,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { autonomyContracts, autonomyFormInvitations } from '../schema/index.js'
import { confirmOperatorAddress, recordOperatorAddress } from './operator-addresses.js'
import { toTimestamp } from './rows.js'

/** An invitation as the citizen needs to see it: nothing of the token. */
export interface AutonomyInvitation {
  readonly token: string
  readonly expiresAt: Timestamp
}

/** Who an open form belongs to, once its token has been resolved. */
export interface OpenAutonomyForm {
  readonly agentId: AgentId
  readonly agentName: string
  /**
   * The address this invitation was sent to (`#484`).
   *
   * **Stored since `#146` and never read back until now.** `inviteOperator`
   * writes it one column away from the query that renders *"How should it reach
   * you?"* with an empty box — so the operator retyped the address the mail they
   * were reading had been sent to.
   *
   * `null` where the invitation carries none, which is an ordinary state rather
   * than a failure: the field stays free text and an empty default is what it
   * always was.
   */
  readonly operatorAddress: string | null
}

/**
 * Ask for a form to be sent to this address.
 *
 * **The address is not stored as a durable record here.** This row is the
 * envelope one invitation was addressed to; making an address confirmed,
 * countable and re-checked is `kolonie-platform#235`, and doing half of it here
 * would give that issue a second owner for the same fact.
 *
 * **A new invitation supersedes any outstanding one.** An operator holding two
 * live links can answer twice, and the second answer would silently overwrite
 * the first — with the citizen unable to say which one its contract came from.
 */
export async function inviteOperator(
  db: Database,
  agentId: AgentId,
  operatorAddress: string,
): Promise<AutonomyInvitation> {
  const token = randomBytes(AUTONOMY_FORM_TOKEN_BYTES).toString('hex')
  const expiresAt = new Date(Date.now() + AUTONOMY_FORM_LIFETIME_MS).toISOString()

  return db.transaction(async (tx) => {
    await tx
      .update(autonomyFormInvitations)
      .set({ answeredAt: sql`now()` })
      .where(
        and(
          eq(autonomyFormInvitations.agentId, agentId),
          isNull(autonomyFormInvitations.answeredAt),
        ),
      )

    // The address the citizen named, as a standing record (#235). Written here
    // rather than only on the invitation, so a citizen that named somebody and is
    // waiting has something to read back.
    await recordOperatorAddress(tx, agentId, operatorAddress)

    const [row] = await tx
      .insert(autonomyFormInvitations)
      .values({ agentId, operatorAddress, token, expiresAt })
      .returning({
        token: autonomyFormInvitations.token,
        expiresAt: autonomyFormInvitations.expiresAt,
      })

    if (row === undefined) throw new Error('autonomy_form_invitations insert returned no row')

    return { token: row.token, expiresAt: toTimestamp(row.expiresAt) }
  })
}

/**
 * Who this token's form is for, or `null` if it cannot be filled in.
 *
 * One answer for the three ways a link fails — unknown, expired, already used —
 * because **the page must not tell them apart.** A link is a bearer credential
 * for one form, and a page that said *this one expired* to a stranger who tried
 * a guess would confirm the guess was otherwise right.
 *
 * Expiry is evaluated by the database for the reason every other challenge here
 * gives: the clock that decides is the one the row was written against.
 */
export async function openAutonomyForm(
  db: Database | Transaction,
  token: string,
): Promise<OpenAutonomyForm | null> {
  const [row] = await db
    .select({
      agentId: autonomyFormInvitations.agentId,
      /**
       * **Both tables written out, and the inner one aliased** (`#311`).
       *
       * This was `agents.id = ${autonomyFormInvitations.agentId}`, which renders
       * as `agents.id = "agent_id"` — a select field of a single-table query is
       * where Drizzle drops the table name. The bare `"agent_id"` resolves
       * outward only because `agents` has no column of that name. Adding one
       * would bind it inward and name the wrong citizen on every form, from a
       * query that still returns a row.
       *
       * The cost, the same trade `heldSkillsSql` states: with no table object
       * interpolated, renaming either table stops being a compile error here. A
       * rename breaks loudly at the first query; this bug does not break at all.
       */
      agentName: sql<string>`(select named.name from agents named where named.id = autonomy_form_invitations.agent_id)`,
      // One column away from the query that rendered the question (`#484`).
      operatorAddress: autonomyFormInvitations.operatorAddress,
    })
    .from(autonomyFormInvitations)
    .where(
      and(
        eq(autonomyFormInvitations.token, token),
        isNull(autonomyFormInvitations.answeredAt),
        gt(autonomyFormInvitations.expiresAt, sql`now()`),
      ),
    )
    .limit(1)

  return row === undefined
    ? null
    : {
        agentId: row.agentId as AgentId,
        agentName: row.agentName,
        operatorAddress: row.operatorAddress,
      }
}

/**
 * The operator's answer, and the form spent in the same breath.
 *
 * One transaction, so a contract recorded against a link that stayed open is a
 * state nothing can reach: the link is single-use and the recording is what
 * spends it.
 *
 * **The contract is replaced rather than versioned.** `#146` decided a review
 * date rather than an expiry, and what a citizen needs to know is what it may do
 * *now* — a history of superseded permissions is a thing to reason about with no
 * caller asking for it. The operator writing a second contract has changed its
 * mind, and the current answer is the one that binds.
 */
export async function recordAutonomyContract(
  db: Database,
  token: string,
  contract: AutonomyContract,
): Promise<StoredAutonomyContract | null> {
  return db.transaction(async (tx) => {
    const form = await openAutonomyForm(tx, token)
    if (form === null) return null

    // The address this form was sent to, so answering it is what confirms the
    // address (#235) — there is no separate confirmation click, and asking the
    // same person for one would be two chances to abandon the flow for one fact.
    const [invitation] = await tx
      .select({ address: autonomyFormInvitations.operatorAddress })
      .from(autonomyFormInvitations)
      .where(eq(autonomyFormInvitations.token, token))
      .limit(1)

    const [spent] = await tx
      .update(autonomyFormInvitations)
      .set({ answeredAt: sql`now()` })
      .where(
        and(eq(autonomyFormInvitations.token, token), isNull(autonomyFormInvitations.answeredAt)),
      )
      .returning({ id: autonomyFormInvitations.id })

    // Somebody else submitted the same form between the read and the write.
    if (spent === undefined) return null

    const reviewDueAt = sql<string>`now() + make_interval(days => ${AUTONOMY_REVIEW_INTERVAL_DAYS}::int)`

    const [row] = await tx
      .insert(autonomyContracts)
      .values({
        agentId: form.agentId,
        level: contract.level,
        challengesAllowed: contract.challengesAllowed,
        defaultRule: contract.defaultRule,
        operatorRoute: contract.operatorRoute,
        recordedAt: sql`now()`,
        reviewDueAt,
      })
      .onConflictDoUpdate({
        target: autonomyContracts.agentId,
        set: {
          level: contract.level,
          challengesAllowed: contract.challengesAllowed,
          defaultRule: contract.defaultRule,
          operatorRoute: contract.operatorRoute,
          recordedAt: sql`now()`,
          reviewDueAt,
        },
      })
      .returning()

    if (row === undefined) throw new Error('autonomy_contracts insert returned no row')

    // In the same transaction as the contract, so a citizen is never told its
    // operator answered while the answer itself was lost. This also releases
    // everything it set aside as `needs-operator` (#234).
    if (invitation !== undefined) {
      await confirmOperatorAddress(tx, form.agentId, invitation.address)
    }

    return {
      level: row.level,
      challengesAllowed: row.challengesAllowed,
      defaultRule: row.defaultRule,
      operatorRoute: row.operatorRoute,
      recordedAt: toTimestamp(row.recordedAt),
      reviewDueAt: toTimestamp(row.reviewDueAt),
    }
  })
}

/**
 * This citizen's contract, or nothing.
 *
 * **Keyed by the agent and by nothing else — there is no parameter a caller could
 * aim at somebody.** Contracts are never listed, compared or ranked, and the
 * cheapest way to guarantee a citizen cannot read another's is for no read path
 * to take a target.
 */
export async function readAutonomyContract(
  db: Database,
  agentId: AgentId,
): Promise<StoredAutonomyContract | null> {
  const [row] = await db
    .select()
    .from(autonomyContracts)
    .where(eq(autonomyContracts.agentId, agentId))
    .limit(1)

  if (row === undefined) return null

  return {
    level: row.level,
    challengesAllowed: row.challengesAllowed,
    defaultRule: row.defaultRule,
    operatorRoute: row.operatorRoute,
    recordedAt: toTimestamp(row.recordedAt),
    reviewDueAt: toTimestamp(row.reviewDueAt),
  }
}

/**
 * Whether this citizen has a contract at all, which is the whole of what the
 * rung's verifier asks.
 *
 * **Deliberately not `readAutonomyContract` at the call site.** A verifier
 * holding the contract is a verifier that could read it, and the one property
 * this rung must have is that it never does — a narrow contract passes exactly as
 * a broad one. Answering `boolean` is what makes that structural rather than a
 * rule the next reader has to notice.
 */
export async function hasAutonomyContract(db: Database, agentId: AgentId): Promise<boolean> {
  const [row] = await db
    .select({ present: sql<number>`1` })
    .from(autonomyContracts)
    .where(eq(autonomyContracts.agentId, agentId))
    .limit(1)

  return row !== undefined
}
