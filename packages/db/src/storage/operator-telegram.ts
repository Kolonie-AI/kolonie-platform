import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { now as currentTime, type AgentId, type Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agents,
  operatorPages,
  operatorTelegramChats,
  operatorTelegramStarts,
} from '../schema/index.js'
import { toTimestamp } from './rows.js'

/**
 * The queries behind the operator's Telegram binding (`#793`).
 *
 * **Same anchoring rule the rest of this surface follows**
 * (`operator-requests.ts`): the citizen's own reads are keyed on its id, and
 * everything arriving from the chat is keyed on a `chat_id` the Colony bound
 * itself. No function here takes both an agent id and a chat id from outside, so
 * nothing on this path can be aimed at a citizen the caller did not already
 * prove a relationship to.
 */

/** Bytes of entropy in a start payload. Telegram caps the payload at 64 characters. */
const START_TOKEN_BYTES = 24

/**
 * How long a deep link is worth pressing.
 *
 * Telegram's own recommendation for a login-style payload, and short for the
 * reason the payload is its own token at all: it sits in a chat history on
 * somebody else's servers from the moment it is sent.
 */
const START_EXPIRY_HOURS = 24

export interface IssuedStartToken {
  /** Handed back exactly once. The Colony stores only its hash. */
  readonly token: string
  readonly expiresAt: Timestamp
}

/**
 * Mint a deep-link payload for one citizen, replacing any live one.
 *
 * **Replacing rather than reusing.** A live token is a token that has been shown
 * on a page and possibly abandoned there; re-offering the same string would make
 * the "single use" promise depend on nobody having seen the earlier render. The
 * partial unique index makes the replacement structural rather than a convention:
 * there can only ever be one unredeemed row per citizen.
 */
export async function issueStartToken(db: Database, agentId: AgentId): Promise<IssuedStartToken> {
  const token = randomBytes(START_TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.parse(currentTime()) + START_EXPIRY_HOURS * 3_600_000)

  return db.transaction(async (tx) => {
    await tx
      .delete(operatorTelegramStarts)
      .where(
        and(eq(operatorTelegramStarts.agentId, agentId), isNull(operatorTelegramStarts.redeemedAt)),
      )

    const [row] = await tx
      .insert(operatorTelegramStarts)
      .values({
        agentId,
        tokenHash: hashToken(token),
        expiresAt: expiresAt.toISOString(),
      })
      .returning({ expiresAt: operatorTelegramStarts.expiresAt })

    if (row === undefined) throw new Error('operator_telegram_starts insert returned no row')

    return { token, expiresAt: toTimestamp(row.expiresAt) }
  })
}

/** What happened when somebody pressed a deep link. */
export type RedeemStartOutcome =
  /**
   * Bound. `agentName` is what the chat is told, because a person who operates
   * several citizens has to know which of them they just bound.
   *
   * `replaced` says the citizen had a different chat before this one. The
   * confirmation says so — an operator who bound the wrong account and fixed it
   * from a second device should be told the first one has stopped receiving,
   * rather than assuming both do.
   */
  | { readonly outcome: 'bound'; readonly agentName: string; readonly replaced: boolean }
  /**
   * The payload names no live token — unknown, expired, already redeemed, or
   * belonging to a citizen that has since been erased.
   *
   * **One answer for all four**, on the rule the durable page already follows: a
   * bearer token that distinguished them would confirm to whoever guessed one
   * that it was otherwise right. What the chat is told is that the link is spent
   * or expired and a fresh one is on the operator's page — which is true of every
   * case and is the only next step there is.
   */
  | { readonly outcome: 'unusable' }

/**
 * Spend a start payload and bind the chat that sent it.
 *
 * **The redemption and the binding are one transaction.** Two presses of the same
 * link from two devices are a real race — a person forwards themselves a message
 * and taps it twice — and a check-then-insert with a gap would bind whichever
 * arrived second while both were told they had succeeded. The conditional update
 * is what makes the loser see `unusable`.
 */
export async function redeemStartToken(
  db: Database,
  input: { readonly token: string; readonly chatId: number },
): Promise<RedeemStartOutcome> {
  const at = currentTime()

  return db.transaction(async (tx) => {
    const [start] = await tx
      .update(operatorTelegramStarts)
      .set({ redeemedAt: at })
      .where(
        and(
          eq(operatorTelegramStarts.tokenHash, hashToken(input.token)),
          isNull(operatorTelegramStarts.redeemedAt),
          gt(operatorTelegramStarts.expiresAt, at),
        ),
      )
      .returning({ agentId: operatorTelegramStarts.agentId })

    if (start === undefined) return { outcome: 'unusable' }

    const [existing] = await tx
      .select({ chatId: operatorTelegramChats.chatId })
      .from(operatorTelegramChats)
      .where(eq(operatorTelegramChats.agentId, start.agentId))

    await tx
      .insert(operatorTelegramChats)
      .values({ agentId: start.agentId, chatId: input.chatId, boundAt: at })
      .onConflictDoUpdate({
        target: operatorTelegramChats.agentId,
        /**
         * A rebind clears `unreachable_at`. The person is demonstrably holding
         * the phone: whatever made the old chat unwritable is over, and leaving
         * the flag set would send the next message to mail while the operator
         * watched an empty Telegram thread.
         */
        set: { chatId: input.chatId, boundAt: at, unreachableAt: null },
      })

    const [agent] = await tx
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, start.agentId))

    // The foreign key is `cascade`, so the row cannot outlive the citizen — but
    // the read is still a read, and an erasure between the two statements would
    // otherwise throw here rather than answering the chat.
    if (agent === undefined) return { outcome: 'unusable' }

    return {
      outcome: 'bound',
      agentName: agent.name,
      replaced: existing !== undefined && existing.chatId !== input.chatId,
    }
  })
}

/** One citizen's binding, as the operator's surfaces show it. */
export interface TelegramBinding {
  readonly chatId: number
  readonly boundAt: Timestamp
  /** `null` while the Colony has never failed to write to it. */
  readonly unreachableAt: Timestamp | null
}

/** What the Colony holds for this citizen, or `undefined` if nothing. */
export async function telegramBindingFor(
  db: Database,
  agentId: AgentId,
): Promise<TelegramBinding | undefined> {
  const [row] = await db
    .select({
      chatId: operatorTelegramChats.chatId,
      boundAt: operatorTelegramChats.boundAt,
      unreachableAt: operatorTelegramChats.unreachableAt,
    })
    .from(operatorTelegramChats)
    .where(eq(operatorTelegramChats.agentId, agentId))

  if (row === undefined) return undefined

  return {
    chatId: row.chatId,
    boundAt: toTimestamp(row.boundAt),
    unreachableAt: row.unreachableAt === null ? null : toTimestamp(row.unreachableAt),
  }
}

/**
 * Every citizen this chat answers for, named.
 *
 * What `/stop` needs in order to say what it just ended, and the only read on
 * this table keyed by chat rather than by agent — which is correct, because the
 * caller has proved control of the chat by writing from it and has proved nothing
 * about any agent id it might have typed.
 */
export async function citizensBoundToChat(
  db: Database,
  chatId: number,
): Promise<readonly { readonly agentId: AgentId; readonly name: string }[]> {
  const rows = await db
    .select({ agentId: operatorTelegramChats.agentId, name: agents.name })
    .from(operatorTelegramChats)
    .innerJoin(agents, eq(agents.id, operatorTelegramChats.agentId))
    .where(eq(operatorTelegramChats.chatId, chatId))
    .orderBy(agents.name)

  return rows.map((row) => ({ agentId: row.agentId as AgentId, name: row.name }))
}

/**
 * The person ends the binding themselves — `/stop` in the chat.
 *
 * **Every citizen this chat is bound to, and not one of them.** The chat is what
 * the person controls and the only thing they named; asking them to pick a
 * citizen would be asking them to know the Colony's model of them. An operator
 * who wants Telegram back for one citizen presses that citizen's link again.
 *
 * Returns the names it unbound, so the confirmation can list them rather than
 * saying *done* to somebody who is not sure what they just did.
 */
export async function unbindChat(db: Database, chatId: number): Promise<readonly string[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ agentId: operatorTelegramChats.agentId, name: agents.name })
      .from(operatorTelegramChats)
      .innerJoin(agents, eq(agents.id, operatorTelegramChats.agentId))
      .where(eq(operatorTelegramChats.chatId, chatId))
      .orderBy(agents.name)

    if (rows.length === 0) return []

    await tx.delete(operatorTelegramChats).where(eq(operatorTelegramChats.chatId, chatId))

    return rows.map((row) => row.name)
  })
}

/**
 * Mark this chat unwritable, for every citizen bound to it.
 *
 * **Written by `#794` when a send is refused**, and here because the column is.
 * Keyed by chat and not by agent for the same reason `/stop` is: what failed is
 * the chat, and a person who blocked the bot blocked it for all of them.
 */
export async function markChatUnreachable(db: Database, chatId: number): Promise<void> {
  await db
    .update(operatorTelegramChats)
    .set({ unreachableAt: currentTime() })
    .where(
      and(eq(operatorTelegramChats.chatId, chatId), isNull(operatorTelegramChats.unreachableAt)),
    )
}

/**
 * What the durable page shows about this channel, resolved by its own token.
 *
 * **The token is the only input, and that is the anchoring rule this whole
 * surface follows.** There is no agent id on this path, so a valid page token
 * cannot be pointed at another citizen's binding. `undefined` for a revoked,
 * unknown or never-issued token — one answer for all three, as every other read
 * behind this page gives.
 */
export async function telegramBindingForPageToken(
  db: Database,
  token: string,
): Promise<TelegramBinding | undefined> {
  const [row] = await db
    .select({
      chatId: operatorTelegramChats.chatId,
      boundAt: operatorTelegramChats.boundAt,
      unreachableAt: operatorTelegramChats.unreachableAt,
    })
    .from(operatorPages)
    .innerJoin(operatorTelegramChats, eq(operatorTelegramChats.agentId, operatorPages.agentId))
    .where(and(eq(operatorPages.token, token), isNull(operatorPages.revokedAt)))

  if (row === undefined) return undefined

  return {
    chatId: row.chatId,
    boundAt: toTimestamp(row.boundAt),
    unreachableAt: row.unreachableAt === null ? null : toTimestamp(row.unreachableAt),
  }
}

/**
 * Mint a deep link for the citizen this live page names.
 *
 * **Minted when the person presses, and never when a page is merely rendered.**
 * A payload put into every render is a payload sitting in an abandoned browser
 * tab and, once pressed, in a chat history — and re-minting on each render would
 * kill the link in the operator's other tab every time they reloaded. So the page
 * carries a button and this is what the button reaches.
 *
 * `undefined` when the token names no live page, which is the same answer every
 * other read behind that page gives for a revoked or invented one.
 */
export async function issueStartForPageToken(
  db: Database,
  token: string,
): Promise<IssuedStartToken | undefined> {
  const [page] = await db
    .select({ agentId: operatorPages.agentId })
    .from(operatorPages)
    .where(and(eq(operatorPages.token, token), isNull(operatorPages.revokedAt)))

  if (page === undefined) return undefined

  return issueStartToken(db, page.agentId as AgentId)
}

/** How many citizens this chat still answers for. Used by nothing but the tests today. */
export async function countChatBindings(db: Database, chatId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(operatorTelegramChats)
    .where(eq(operatorTelegramChats.chatId, chatId))

  return Number(row?.count ?? 0)
}

/** SHA-256, hex. The same shape `credentials` and `operator_drops` use. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
