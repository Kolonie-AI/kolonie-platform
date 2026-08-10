import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import {
  AUTONOMY_FORM_LIFETIME_MS,
  AUTONOMY_FORM_TOKEN_BYTES,
  AUTONOMY_REVIEW_INTERVAL_DAYS,
  type AgentId,
  type AutonomyContract,
  type AutonomyContractVersion,
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
  /**
   * The operator's other agents, which this one form may also answer for
   * (`#514`).
   *
   * **Empty is the ordinary first answer.** An operator's first form covers one
   * agent, because nothing yet proves it operates any other; siblings appear on
   * the second and later forms, which is exactly the case the issue describes —
   * *when an operator already holds a contract with one agent, a later ask from
   * a sibling offers the same answer for this one too.*
   *
   * See {@link eligibleSiblings} for what counts as proof, and why an agent that
   * merely *claims* this address is not in the list.
   */
  readonly alsoFor: readonly { readonly agentId: AgentId; readonly name: string }[]
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
 * The operator's other agents, which one form may answer for (`#514`).
 *
 * ## What counts as *the same operator*, and why two proofs rather than one
 *
 * **A confirmed operator address**, or **the same human account**. Both are
 * proofs the Colony holds rather than claims a citizen made:
 *
 * - `operator_addresses.confirmed_at` is set by *this operator having answered a
 *   form for that agent already*, which is the strongest evidence available on a
 *   surface where the operator has no account. `distinct-operators.ts` treats a
 *   confirmed address as operator identity for the same reason.
 * - `human_agents` is the operator link (`#510`), for the operators that do have
 *   a console account.
 *
 * **An unconfirmed address is deliberately not enough**, and this is the whole
 * safety of the feature. `agents.operator` and an unconfirmed
 * `operator_addresses` row are both things a citizen typed about itself, so
 * anybody's agent could name your address and appear in your form — and a form
 * that offered a stranger's agent a tick box would hand it a contract you
 * thought you were giving your own.
 *
 * Ordered by name so the form reads the same way twice.
 */
async function eligibleSiblings(
  db: Database | Transaction,
  agentId: AgentId,
  operatorAddress: string,
): Promise<readonly { agentId: AgentId; name: string }[]> {
  const rows = await db.execute<{ id: string; name: string }>(sql`
    select a.id, a.name
      from agents a
     where a.id <> ${agentId}
       and (
         exists (
           select 1 from operator_addresses theirs
            where theirs.agent_id = a.id
              and theirs.confirmed_at is not null
              and lower(btrim(theirs.address)) = lower(btrim(${operatorAddress}))
         )
         or exists (
           select 1
             from human_agents mine
             join human_agents theirs on theirs.human_id = mine.human_id
            where mine.agent_id = ${agentId}
              and theirs.agent_id = a.id
         )
       )
     order by a.name`)

  return rows.map((row) => ({ agentId: row.id as AgentId, name: row.name }))
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

  if (row === undefined) return null

  return {
    agentId: row.agentId as AgentId,
    agentName: row.agentName,
    operatorAddress: row.operatorAddress,
    alsoFor:
      row.operatorAddress === null
        ? []
        : await eligibleSiblings(db, row.agentId as AgentId, row.operatorAddress),
  }
}

/**
 * The operator's answer, and the form spent in the same breath.
 *
 * One transaction, so a contract recorded against a link that stayed open is a
 * state nothing can reach: the link is single-use and the recording is what
 * spends it.
 *
 * **A new version supersedes rather than overwrites** (`#658`). What binds now
 * stays one row, while the previous answer keeps the dates and terms needed to
 * judge what was permitted when an earlier action happened.
 */
export async function recordAutonomyContract(
  db: Database,
  token: string,
  contract: AutonomyContract,
  /**
   * The operator's other agents it ticked, if any (`#514`, variant B).
   *
   * **Every id is checked against {@link eligibleSiblings} inside this
   * transaction and anything else is dropped**, silently. This arrives from a
   * form post on an unauthenticated page, so it is a request and never an
   * instruction: an id nobody may cover is not an error worth telling a stranger
   * about, and answering *that agent is not yours* would confirm the agent
   * exists.
   *
   * **No inheritance, which is the substance of the issue's choice.** The
   * operator ticks each agent; a sibling that asks tomorrow is not covered by
   * what was agreed today. The contract answers *what may this agent do on your
   * behalf*, and a contract granted to an agent the operator never saw would
   * make the one thing it promises untrue.
   */
  alsoFor: readonly AgentId[] = [],
): Promise<StoredAutonomyContract | null> {
  return db.transaction(async (tx) => {
    const form = await openAutonomyForm(tx, token)
    if (form === null) return null

    const permitted = new Set(form.alsoFor.map((sibling) => String(sibling.agentId)))
    const covering = alsoFor.filter((candidate) => permitted.has(String(candidate)))

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

    /**
     * **The link is spent once, for everything it covered** (`#514`). It was
     * already spent above, before any contract is written, so a form answering
     * for twelve agents is exactly as single-use as one answering for one — and
     * every contract it produces is written in the same transaction, so there is
     * no state where the link is gone and half the answers are missing.
     */
    const write = async (agentId: AgentId) =>
      writeAutonomyContractVersion(tx, agentId, contract, spent.id)

    const row = await write(form.agentId)

    /**
     * **A per-agent contract still overrides**, and this is where that holds:
     * each ticked sibling gets its own row, replacing whatever it had, and an
     * agent whose operator answers its *own* form tomorrow replaces this one in
     * turn. There is no shared record for a per-agent answer to override —
     * `autonomy_contracts` is keyed by the agent and stays so.
     */
    for (const sibling of covering) await write(sibling)

    // In the same transaction as the contract, so a citizen is never told its
    // operator answered while the answer itself was lost. This also releases
    // everything it set aside as `needs-operator` (#234).
    if (invitation !== undefined) {
      await confirmOperatorAddress(tx, form.agentId, invitation.address)
    }

    return {
      ...row,
    }
  })
}

/** Write one version inside the caller's transaction, retiring the current one first. */
async function writeAutonomyContractVersion(
  tx: Transaction,
  agentId: AgentId,
  contract: AutonomyContract,
  invitationId: string | null,
): Promise<StoredAutonomyContract> {
  const at = sql<string>`now()`
  await tx
    .update(autonomyContracts)
    .set({ supersededAt: at })
    .where(and(eq(autonomyContracts.agentId, agentId), isNull(autonomyContracts.supersededAt)))

  const [row] = await tx
    .insert(autonomyContracts)
    .values({
      agentId,
      ...contract,
      recordedAt: at,
      reviewDueAt: sql`now() + make_interval(days => ${AUTONOMY_REVIEW_INTERVAL_DAYS}::int)`,
      invitationId,
    })
    .returning()

  if (row === undefined) throw new Error('autonomy_contracts insert returned no row')
  return {
    level: row.level,
    challengesAllowed: row.challengesAllowed,
    defaultRule: row.defaultRule,
    operatorRoute: row.operatorRoute,
    recordedAt: toTimestamp(row.recordedAt),
    reviewDueAt: toTimestamp(row.reviewDueAt),
  }
}

/** Record a version after a console route has proved this person operates the citizen (#658). */
export async function recordAutonomyContractForAgent(
  db: Database,
  agentId: AgentId,
  contract: AutonomyContract,
): Promise<StoredAutonomyContract> {
  return db.transaction((tx) => writeAutonomyContractVersion(tx, agentId, contract, null))
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
    .where(and(eq(autonomyContracts.agentId, agentId), isNull(autonomyContracts.supersededAt)))
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

/** Every version for this citizen, newest first; no caller can aim it at another citizen. */
export async function listAutonomyContracts(
  db: Database,
  agentId: AgentId,
): Promise<readonly AutonomyContractVersion[]> {
  const rows = await db
    .select()
    .from(autonomyContracts)
    .where(eq(autonomyContracts.agentId, agentId))
    .orderBy(desc(autonomyContracts.recordedAt))

  return rows.map((row) => ({
    level: row.level,
    challengesAllowed: row.challengesAllowed,
    defaultRule: row.defaultRule,
    operatorRoute: row.operatorRoute,
    recordedAt: toTimestamp(row.recordedAt),
    reviewDueAt: toTimestamp(row.reviewDueAt),
    supersededAt: row.supersededAt === null ? null : toTimestamp(row.supersededAt),
  }))
}

/**
 * The other agents the same form answered for (`#514`).
 *
 * **For the operator's page and for nothing else.** The issue's *thing to get
 * right* is that an operator can see, per agent, what it agreed to — *a shared
 * answer that leaves twelve agents each claiming a contract nobody can trace
 * back is worse than twelve forms*. This is that trace, in the form a person can
 * read: the names, rather than the invitation's id.
 *
 * **Not on the citizen's own read.** `readAutonomyContract` is what an agent
 * calls, and it does not carry this: who else shares an operator is not
 * something a citizen learns (`#510`). Keeping it a separate function is what
 * makes that hard to undo by accident.
 *
 * Empty for a contract answered on its own form, and for every contract recorded
 * before `#514` — those carry no invitation, which is *not recorded* rather than
 * *answered alone*.
 */
export async function contractCompanions(
  db: Database,
  agentId: AgentId,
): Promise<readonly string[]> {
  const rows = await db.execute<{ name: string }>(sql`
    select other.name
      from autonomy_contracts mine
      join autonomy_contracts theirs
        on theirs.invitation_id = mine.invitation_id
       and theirs.agent_id <> mine.agent_id
      join agents other on other.id = theirs.agent_id
      where mine.agent_id = ${agentId}
        and mine.superseded_at is null
       and mine.invitation_id is not null
     order by other.name`)

  return rows.map((row) => row.name)
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
    .where(and(eq(autonomyContracts.agentId, agentId), isNull(autonomyContracts.supersededAt)))
    .limit(1)

  return row !== undefined
}
