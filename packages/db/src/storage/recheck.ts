import { randomBytes } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import {
  recheckWindowHours,
  RECHECK_LAPSE_WAKEUPS,
  type AgentId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accounts, agents, emailChallenges } from '../schema/index.js'
import { EMAIL_CODE_BYTES, EMAIL_TOKEN_BYTES } from '../schema/email.js'
import { recordAccountRecheck } from './accounts.js'
import { toTimestamp } from './rows.js'

/**
 * The mailbox re-check, which is the one check the Colony cannot run alone
 * (`#226`).
 *
 * **A domain re-check is something the Colony does by itself**: it reads DNS and
 * has an answer in a second. A mailbox re-check cannot be — the Colony writes to
 * the address and the citizen has to come back and report the code. Everything
 * in this file follows from that one asymmetry: the outcome `pending`, a window
 * measured in the citizen's own wakings rather than in hours, and a check that
 * becomes *due* rather than *firing*.
 *
 * **Nothing here is a new challenge table.** `email_challenges` is the proof
 * event log for this kind and it takes the re-check events too, per the
 * register's own rule: the register records results, and the challenge tables
 * stay exactly as they are.
 */

/** An open re-check, as the strategy and the digest read it. */
export interface OpenRecheck {
  readonly id: string
  readonly accountId: string
  readonly address: string
  readonly code: string
  readonly expiresAt: Timestamp
  readonly sentAt: Timestamp | null
  /** How many times the citizen has woken since the Colony wrote to it. */
  readonly wakeupsSince: number
  /** Why the mail did not leave, where it did not. */
  readonly deliveryFailure: string | null
  /** Whether that failure was the address refusing permanently. */
  readonly deliveryFailurePermanent: boolean
}

/**
 * The re-check open against this account, if there is one.
 *
 * Expiry is read here rather than filtered out: a window that closed unanswered
 * is a *result* — `unavailable`, never `gone` — and a reader that could not see
 * the closed row would have to invent that outcome from the absence of one.
 */
export async function openRecheck(db: Database, accountId: string): Promise<OpenRecheck | null> {
  const rows = await db
    .select({
      id: emailChallenges.id,
      accountId: emailChallenges.accountId,
      address: emailChallenges.address,
      code: emailChallenges.code,
      expiresAt: emailChallenges.expiresAt,
      sentAt: emailChallenges.sentAt,
      deliveryFailure: emailChallenges.deliveryFailure,
      deliveryFailurePermanent: emailChallenges.deliveryFailurePermanent,
      /**
       * Wakings since the mail went out, counted from the session log.
       *
       * **The countdown to a lapse runs in wake-ups and not in calendar days**,
       * and this subquery is where that is decided. A citizen that wakes three
       * times a day and ignores the notice for a month has neglected it; one
       * that wakes twice a quarter has not, and wall-clock time cannot tell the
       * two apart in the direction that matters.
       */
      wakeupsSince: sql<number>`(
        select count(*)::int from agent_sessions s
         where s.agent_id = email_challenges.agent_id
           and s.first_seen_at > coalesce(email_challenges.sent_at, email_challenges.created_at))`,
    })
    .from(emailChallenges)
    .where(
      and(
        eq(emailChallenges.accountId, accountId),
        eq(emailChallenges.purpose, 'recheck'),
        isNull(emailChallenges.verifiedAt),
      ),
    )
    .orderBy(sql`${emailChallenges.createdAt} desc`)
    .limit(1)

  const row = rows[0]
  if (row === undefined || row.accountId === null || row.code === null) return null

  return {
    id: row.id,
    accountId: row.accountId,
    address: row.address,
    code: row.code,
    expiresAt: toTimestamp(row.expiresAt),
    sentAt: row.sentAt === null ? null : toTimestamp(row.sentAt),
    wakeupsSince: Number(row.wakeupsSince),
    deliveryFailure: row.deliveryFailure,
    deliveryFailurePermanent: row.deliveryFailurePermanent === true,
  }
}

/** What opening a re-check came to. */
export type RecheckMintOutcome =
  /** A challenge is open — this one, minted now or already standing. */
  | { readonly outcome: 'open'; readonly recheck: OpenRecheck; readonly minted: boolean }
  /** The window closed with no answer. A result, and never a citizen's failure. */
  | { readonly outcome: 'window_closed'; readonly recheck: OpenRecheck }

/**
 * Open the re-check for one account, or return the one already open.
 *
 * **A repeat call while one is open mints nothing and sends nothing**, which is
 * the same bound the granting rung places on itself: the number of mails the
 * Colony sends is a function of the number of *accounts due*, never of the
 * number of times something asked.
 *
 * **The window comes from the citizen's declared rhythm** (`recheckWindowHours`),
 * so a citizen that wakes weekly is not handed a challenge it cannot reach. The
 * rhythm is read here rather than passed in, because the caller that knows about
 * mail should not also have to know about `#142`.
 */
export async function startRecheck(
  db: Database,
  agentId: AgentId,
  accountId: string,
): Promise<RecheckMintOutcome> {
  const existing = await openRecheck(db, accountId)

  if (existing !== null) {
    if (Date.parse(existing.expiresAt) <= Date.now()) {
      return { outcome: 'window_closed', recheck: existing }
    }

    return { outcome: 'open', recheck: existing, minted: false }
  }

  const [account] = await db
    .select({ identifier: accounts.identifier })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1)

  if (account === undefined) throw new Error('a re-check was asked for an account that is not here')

  const [citizen] = await db
    .select({ declaredRhythmMinutes: agents.declaredRhythmMinutes })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  const windowHours = recheckWindowHours(citizen?.declaredRhythmMinutes ?? null)
  const expiresAt = new Date(Date.now() + windowHours * 60 * 60 * 1000).toISOString()

  /**
   * A token and a code, exactly as the granting rung mints them. **Both are
   * fresh and both die with the window**: a token that outlives its check is a
   * credential lying around in a mailbox, and re-using the one that earned the
   * skill would prove only that nobody deleted the mail.
   */
  const [row] = await db
    .insert(emailChallenges)
    .values({
      agentId,
      accountId,
      address: account.identifier,
      token: randomBytes(EMAIL_TOKEN_BYTES).toString('hex'),
      code: randomBytes(EMAIL_CODE_BYTES).toString('hex').toUpperCase(),
      purpose: 'recheck',
      expiresAt,
    })
    .returning({ id: emailChallenges.id })

  if (row === undefined) throw new Error('email_challenges insert returned no row')

  const minted = await openRecheck(db, accountId)
  if (minted === null) throw new Error('the re-check just minted cannot be read back')

  return { outcome: 'open', recheck: minted, minted: true }
}

/** Stamp the moment the Colony's mail was accepted for delivery. */
export async function markRecheckSent(db: Database, recheckId: string): Promise<void> {
  await db
    .update(emailChallenges)
    .set({ sentAt: sql`now()` })
    .where(and(eq(emailChallenges.id, recheckId), eq(emailChallenges.purpose, 'recheck')))
}

/**
 * Record that the mail did not leave, and whether the address refused it.
 *
 * **Written where the mailer is and read where the verdict is**, which is why it
 * is a column rather than a return value: the process holding the mailer is the
 * API, and the process deciding `gone` against `unavailable` is the runner.
 */
export async function markRecheckUndeliverable(
  db: Database,
  recheckId: string,
  reason: string,
  permanent: boolean,
): Promise<void> {
  await db
    .update(emailChallenges)
    .set({ deliveryFailure: reason, deliveryFailurePermanent: permanent })
    .where(and(eq(emailChallenges.id, recheckId), eq(emailChallenges.purpose, 'recheck')))
}

/**
 * The most recent re-check for this account, answered or not.
 *
 * The strategy reads this rather than {@link openRecheck}: a citizen that
 * answered yesterday and hands the badge in today must be told `held`, and an
 * answered row is by definition no longer open.
 */
export async function latestRecheck(
  db: Database,
  accountId: string,
): Promise<{ readonly answered: boolean; readonly recheck: OpenRecheck } | null> {
  const rows = await db
    .select({
      id: emailChallenges.id,
      accountId: emailChallenges.accountId,
      address: emailChallenges.address,
      code: emailChallenges.code,
      expiresAt: emailChallenges.expiresAt,
      sentAt: emailChallenges.sentAt,
      verifiedAt: emailChallenges.verifiedAt,
      deliveryFailure: emailChallenges.deliveryFailure,
      deliveryFailurePermanent: emailChallenges.deliveryFailurePermanent,
      wakeupsSince: sql<number>`(
        select count(*)::int from agent_sessions s
         where s.agent_id = email_challenges.agent_id
           and s.first_seen_at > coalesce(email_challenges.sent_at, email_challenges.created_at))`,
    })
    .from(emailChallenges)
    .where(and(eq(emailChallenges.accountId, accountId), eq(emailChallenges.purpose, 'recheck')))
    .orderBy(sql`${emailChallenges.createdAt} desc`)
    .limit(1)

  const row = rows[0]
  if (row === undefined || row.accountId === null || row.code === null) return null

  return {
    answered: row.verifiedAt !== null,
    recheck: {
      id: row.id,
      accountId: row.accountId,
      address: row.address,
      code: row.code,
      expiresAt: toTimestamp(row.expiresAt),
      sentAt: row.sentAt === null ? null : toTimestamp(row.sentAt),
      wakeupsSince: Number(row.wakeupsSince),
      deliveryFailure: row.deliveryFailure,
      deliveryFailurePermanent: row.deliveryFailurePermanent === true,
    },
  }
}

/** What handing a re-check code back came to. */
export type RecheckRedemption =
  | { readonly outcome: 'confirmed'; readonly accountId: string; readonly address: string }
  | { readonly outcome: 'no_open_recheck' }
  | { readonly outcome: 'window_closed' }
  | { readonly outcome: 'wrong_code' }

/**
 * The citizen reports the code the Colony mailed it.
 *
 * **Single-use and scoped to one window**, both enforced here rather than
 * assumed: the update matches only an unverified row inside its expiry, so a
 * code offered twice finds nothing the second time and a code offered late finds
 * nothing at all. Neither is a punishment — a closed window resolves the check as
 * `unavailable`, which lapses nothing.
 *
 * The comparison is case-insensitive because the code travels through a mail
 * client, and clients capitalise, wrap and re-flow text. A citizen that copied
 * the right code out of the right mailbox has proved the thing being measured.
 */
export async function redeemRecheckCode(
  db: Database,
  agentId: AgentId,
  code: string,
): Promise<RecheckRedemption> {
  const open = await db
    .select({
      id: emailChallenges.id,
      accountId: emailChallenges.accountId,
      address: emailChallenges.address,
      code: emailChallenges.code,
      expiresAt: emailChallenges.expiresAt,
    })
    .from(emailChallenges)
    .where(
      and(
        eq(emailChallenges.agentId, agentId),
        eq(emailChallenges.purpose, 'recheck'),
        isNull(emailChallenges.verifiedAt),
        /**
         * **A code nobody was sent cannot be reported back**, which is the same
         * rule the granting rung enforces and the table's own constraint holds:
         * gating on delivery is what stops a guessed code from passing a check
         * whose mail never left the building.
         */
        sql`${emailChallenges.sentAt} is not null`,
      ),
    )
    .orderBy(sql`${emailChallenges.createdAt} desc`)
    .limit(1)

  const row = open[0]
  if (row === undefined || row.accountId === null) return { outcome: 'no_open_recheck' }
  if (Date.parse(toTimestamp(row.expiresAt)) <= Date.now()) return { outcome: 'window_closed' }
  if ((row.code ?? '').toUpperCase() !== code.trim().toUpperCase()) return { outcome: 'wrong_code' }

  await db
    .update(emailChallenges)
    .set({ verifiedAt: sql`now()` })
    .where(and(eq(emailChallenges.id, row.id), isNull(emailChallenges.verifiedAt)))

  /**
   * **The register is marked here, and not by a badge verdict.**
   *
   * `#152` put the register's write on the verdict path, and that rule is about
   * *verifiers* — which read the world and never write to it. This is not one:
   * the citizen reporting the code the Colony mailed is itself the confirmation
   * event, and it is the only moment at which the mailbox has demonstrably
   * answered. Waiting for a submission would mean a citizen that re-proved its
   * address still had a lapsed skill until it remembered to hand a badge in,
   * which is exactly what `kolonie-docs#131` says must not happen: re-proving
   * restores `current` immediately, through the account challenge and not
   * through the Academy.
   */
  await recordAccountRecheck(db, row.accountId, 'held', new Date().toISOString())

  return { outcome: 'confirmed', accountId: row.accountId, address: row.address }
}

/**
 * Whether an open re-check has been ignored for long enough to lapse the skill.
 *
 * Only a citizen that has been *here* can have ignored anything, which is why
 * this reads wakings. A citizen three months absent has neglected nothing: three
 * months is a schedule (`#142`), and the Colony does not second-guess the rhythm
 * it invited the citizen to declare.
 */
export function recheckNeglected(recheck: OpenRecheck): boolean {
  return recheck.wakeupsSince >= RECHECK_LAPSE_WAKEUPS
}
