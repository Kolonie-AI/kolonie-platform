import { randomBytes } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { AgentId, HeldBadge, StoredAutonomyContract, Timestamp } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { operatorPages } from '../schema/index.js'
import { readAutonomyContract } from './autonomy.js'
import { badgesOf } from './badges.js'
import { toTimestamp } from './rows.js'

/** How many bytes of entropy a page token carries, before hex encoding. */
export const OPERATOR_PAGE_TOKEN_BYTES = 32

/** A page as its citizen reads it back. Never the token — that is the operator's. */
export interface OperatorPageRecord {
  readonly operatorAddress: string
  readonly issuedAt: Timestamp
  /** `null` means never opened, which is a different answer from *opened long ago*. */
  readonly lastOpenedAt: Timestamp | null
}

/** What the operator sees when the page opens. */
export interface OperatorPageView {
  readonly agentName: string
  readonly contract: StoredAutonomyContract | null
  /**
   * The badges this agent has been given (`#241`).
   *
   * Resolved here rather than by the route, so the page's subject is decided in
   * exactly one place: the token names the agent, and nothing downstream takes
   * an id from the caller.
   */
  readonly badges: readonly HeldBadge[]
}

/**
 * Issue the durable page for this `(address, agent)` pair, or return the live one.
 *
 * **Idempotent on purpose.** The citizen calls this whenever it wants the link
 * again, and minting a fresh token each time would silently break the link its
 * operator already has — which is revocation by accident, and the one thing a
 * citizen must do deliberately.
 */
export async function issueOperatorPage(
  db: Database,
  agentId: AgentId,
  operatorAddress: string,
): Promise<string> {
  const [existing] = await db
    .select({ token: operatorPages.token })
    .from(operatorPages)
    .where(
      and(
        eq(operatorPages.agentId, agentId),
        eq(operatorPages.operatorAddress, operatorAddress),
        isNull(operatorPages.revokedAt),
      ),
    )
    .limit(1)

  if (existing !== undefined) return existing.token

  const token = randomBytes(OPERATOR_PAGE_TOKEN_BYTES).toString('hex')

  const [row] = await db
    .insert(operatorPages)
    .values({ agentId, operatorAddress, token })
    .returning({ token: operatorPages.token })

  if (row === undefined) throw new Error('operator_pages insert returned no row')

  return row.token
}

/**
 * Open the page, and record that it was opened.
 *
 * **The timestamp moves on the read**, which is why this is not a pure query. It
 * is the only write the page performs and it is about the *operator*, not about
 * anything the operator sent — the page itself still accepts no input.
 *
 * A revoked, unknown or expired token is one answer: `null`. The response must
 * not distinguish a link that was taken away from one that never existed, or a
 * stranger who guessed a token learns that the guess was otherwise right.
 */
export async function openOperatorPage(
  db: Database,
  token: string,
): Promise<OperatorPageView | null> {
  const [row] = await db
    .update(operatorPages)
    .set({ lastOpenedAt: sql`now()` })
    .where(and(eq(operatorPages.token, token), isNull(operatorPages.revokedAt)))
    .returning({ agentId: operatorPages.agentId })

  if (row === undefined) return null

  const [agent] = await db.execute<{ name: string }>(
    sql`select name from agents where id = ${row.agentId}`,
  )

  const contract = await readAutonomyContract(db, row.agentId as AgentId)
  const badges = await badgesOf(db, row.agentId as AgentId)

  return { agentName: agent?.name ?? '', contract, badges }
}

/**
 * The citizen takes the page away.
 *
 * **Immediate, and it needs no confirmation from anybody** — least of all from
 * the operator, who is the party being revoked. `true` when something was
 * revoked; revoking nothing is not an error, for the reason `clearSetAside` gives.
 */
export async function revokeOperatorPage(
  db: Database | Transaction,
  agentId: AgentId,
  operatorAddress: string,
): Promise<boolean> {
  const rows = await db
    .update(operatorPages)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(operatorPages.agentId, agentId),
        eq(operatorPages.operatorAddress, operatorAddress),
        isNull(operatorPages.revokedAt),
      ),
    )
    .returning({ id: operatorPages.id })

  return rows.length > 0
}

/**
 * The pages this citizen currently has out, newest first.
 *
 * **Its own citizen's rows and nothing else.** There is no parameter a caller
 * could aim at somebody, which is the same guarantee `readAutonomyContract` has
 * and for the same reason.
 */
export async function listOperatorPages(
  db: Database,
  agentId: AgentId,
): Promise<readonly OperatorPageRecord[]> {
  const rows = await db
    .select()
    .from(operatorPages)
    .where(and(eq(operatorPages.agentId, agentId), isNull(operatorPages.revokedAt)))
    .orderBy(desc(operatorPages.issuedAt))

  return rows.map((row) => ({
    operatorAddress: row.operatorAddress,
    issuedAt: toTimestamp(row.issuedAt),
    lastOpenedAt: row.lastOpenedAt === null ? null : toTimestamp(row.lastOpenedAt),
  }))
}
