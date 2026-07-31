import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  LedgerTransactionIdSchema,
  type AgentId,
  type ErasureLimit,
  type ErasureReason,
  type ErasureReceipt,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { banMarkHash } from '../ban-salt.js'
import { rebuildGuidanceCounts } from './guidance-counts.js'
import { promoteDuplicatesOf } from './guidance-promotion.js'
import {
  agents,
  banMarks,
  emailChallenges,
  erasures,
  ledgerEntries,
  solanaWalletChallenges,
} from '../schema/index.js'

/** What happened when a citizen asked to be erased. */
export type EraseAgentResult =
  | { readonly outcome: 'erased'; readonly receipt: ErasureReceipt }
  /**
   * There is no such agent.
   *
   * **Not a quiet success**, which the issue asks for explicitly and which
   * matters more here than it looks. Erasure is irreversible, so *it worked* is
   * the one answer a caller cannot check afterwards — there is nothing left to
   * look at. A second erasure that returned a receipt would be indistinguishable
   * from the first, and an agent id that was never real would look erased.
   */
  | { readonly outcome: 'no-such-agent' }
  /**
   * The citizen's ledger history touches an account that is not the mint, so
   * removing it would move somebody else's balance. See `bookingsAreMintOnly`.
   */
  | {
      readonly outcome: 'entangled-ledger'
      readonly reason: string
    }

/**
 * The types that mean *money committed to something that is not the citizen's
 * to destroy*.
 *
 * `erasure.md` §5: *"Anything a sponsor paid for stays the sponsor's: an
 * escrowed quest credit is released back to the quest rather than burned,
 * because it was never the citizen's to destroy."*
 *
 * **There is no escrow mechanism, and this is the guard rather than the
 * mechanism.** Nothing books any of these types today — they are members of
 * `LedgerEntryTypeSchema` that the quest subsystem will use and nothing else
 * writes. So the honest thing is not to pretend the release path exists, but to
 * refuse an erasure that would destroy such a credit, and to say why. The day
 * escrow is built, this list is the one place that has to learn how to release
 * instead of refuse.
 */
const ESCROW_TYPES = ['task_funding', 'proposal_stake'] as const

/**
 * Erase a citizen: burn the balance, delete everything of theirs, leave one row
 * that names nobody (#91).
 *
 * ## One transaction, and no partially erased state
 *
 * Everything below happens inside a single database transaction. A failure at
 * any point leaves the citizen completely intact, which is the property
 * `erasure.md` §7 chose over a soft delete:
 *
 * > **Atomicity.** One transaction either erases everything or nothing. A staged
 * > purge can die halfway and leave a half-erased account, which is worse than
 * > either end state.
 *
 * ## The order is the design
 *
 * 1. Lock the agent row, so two erasures cannot race and so nothing books a
 *    reward into an account halfway through being deleted.
 * 2. Read what the receipt will need — the identifiers, the counts — **before**
 *    anything is deleted. After the delete nobody can reconstruct them,
 *    including the Colony.
 * 3. Refuse if the citizen holds an escrowed credit, or if their ledger history
 *    is entangled with an account other than the mint.
 * 4. Burn the balance to zero against the mint, if it is not already zero.
 * 5. Delete the ledger bookings whole, then the agent — everything else
 *    cascades (#90).
 * 6. Write `erasures`, and `ban_marks` if the account was under sanction.
 *
 * ## The burn is arithmetically redundant, and is booked anyway
 *
 * Stated because it is surprising and a later reader will otherwise "simplify"
 * it away. Step 5 deletes the burn booking along with every other, so the pair
 * of entries written in step 4 never survives the transaction, and total supply
 * would land in exactly the same place without it.
 *
 * It is booked because it is what makes step 5 *checkable*: after the burn the
 * agent's entries sum to zero, which is the invariant `erasure.md` §3 rests its
 * whole argument on, and this function asserts it rather than assuming it. A
 * deletion performed without ever establishing that invariant is one nobody can
 * audit after the fact — and there is nothing left to audit it against.
 */
export async function eraseAgent(
  db: Database,
  command: {
    /**
     * Whose account. Resolved from the `Authorization` header by the caller and
     * never from a request body — `erasure.md` §6 forbids a target argument
     * anywhere in the surface, and this signature is deliberately not the place
     * that rule is enforced. #93 is.
     */
    readonly agentId: AgentId
    readonly reason?: ErasureReason
    /**
     * The ban-mark salt, read from the environment **at process startup** by the
     * caller — `banSaltFromEnv` in `../ban-salt.js`.
     *
     * A parameter rather than a read inside this function, and the difference is
     * the whole point of the check. Reading it here would move the failure to
     * the first erasure of a banned agent, which is a rare event nobody is
     * watching; taking it as an argument lets the process refuse to boot without
     * one, where an operator is looking at a deploy.
     */
    readonly banSalt: string
  },
): Promise<EraseAgentResult> {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(eq(agents.id, command.agentId))
      // Two erasures of the same account would both read a balance, both book a
      // burn, and the second would double-count. The lock is also what stops a
      // verifier booking a reward into an account mid-erasure.
      .for('update')
      .limit(1)

    if (agent === undefined) return { outcome: 'no-such-agent' }

    const escrowed = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.agentId, command.agentId),
          inArray(ledgerEntries.type, [...ESCROW_TYPES]),
        ),
      )
      .limit(1)

    if (escrowed.length > 0) {
      return {
        outcome: 'entangled-ledger',
        reason:
          'This account holds a credit that was funded by somebody else. Releasing it back to ' +
          'the quest it belongs to is not built yet, and erasure will not destroy a sponsor’s ' +
          'money to get around that. Open a support ticket and the Colony will settle it first.',
      }
    }

    const entangled = await bookingsBeyondTheMint(tx, command.agentId)
    if (entangled !== null) return { outcome: 'entangled-ledger', reason: entangled }

    const beyondReach = await whatIsBeyondReach(tx, command.agentId)
    const counts = await countEverything(tx, command.agentId)

    /**
     * Which of *other citizens'* cached counts this erasure is about to
     * invalidate — read now, because the rows that answer it are the ones about
     * to cascade away (#106).
     *
     * The Colony fixes its own cache rather than refusing the erasure. The
     * numbers are the Colony's bookkeeping about how many agents reported a wall
     * and how many found a report useful; making a citizen stay so that they stay
     * tidy would be charging the citizen for the Colony's convenience.
     */
    const disturbed = await countsThisWillDisturb(tx, command.agentId)

    const coinsBurned = await balanceOf(tx, command.agentId)
    const reputationDestroyed = await reputationOf(tx, command.agentId)

    if (coinsBurned !== 0) {
      const transactionId = LedgerTransactionIdSchema.parse(crypto.randomUUID())
      // Both legs in one statement, sharing a transaction id, exactly as
      // `bookTaskReward` writes a payout. The deferred trigger checks it at
      // COMMIT like any other booking — there is no special path for a burn.
      await tx.insert(ledgerEntries).values([
        {
          transactionId,
          accountKind: 'agent',
          agentId: command.agentId,
          amount: -coinsBurned,
          type: 'adjustment',
          // No agent id, no name. The row is deleted below, but a memo is the
          // sort of thing that gets copied into a log on its way past.
          memo: 'Erasure — balance burned to zero',
        },
        {
          transactionId,
          accountKind: 'system',
          systemAccount: 'mint',
          amount: coinsBurned,
          type: 'adjustment',
          memo: 'Erasure — balance burned to zero',
        },
      ])
    }

    const remaining = await balanceOf(tx, command.agentId)
    if (remaining !== 0) {
      // Unreachable unless the burn above is wrong, and thrown rather than
      // returned because it is a defect in this function and not an answer to
      // the citizen. Throwing rolls the whole transaction back, which is the
      // outcome that keeps the account intact.
      throw new Error(`erasure would delete ${remaining} coins that were never burned`)
    }

    /**
     * The bookings go whole, never one leg at a time.
     *
     * `ledger_entries_balanced` refuses a transaction left summing to something
     * other than zero, so deleting only the citizen's side of a reward aborts
     * this at `COMMIT`. Every booking here has its other leg on the mint —
     * `bookingsBeyondTheMint` has already refused anything else — so removing
     * both legs moves total supply by exactly what the citizen held, and moves
     * no other account by a unit.
     */
    await tx.execute(
      sql`delete from ledger_entries where transaction_id in (
            select transaction_id from ledger_entries where agent_id = ${command.agentId})`,
    )

    const marks =
      agent.status === 'banned' || agent.status === 'suspended'
        ? await writeBanMarks(tx, command.agentId, command.banSalt)
        : 0

    /**
     * Hand over any canonical entry of this citizen's that another agent was
     * merged into, **before** the delete (#107).
     *
     * This is the one place where erasing A can be blocked by B's row, and
     * `duplicate_of` is `restrict` precisely so that forgetting this is a loud
     * failure rather than a silent hole. The oldest surviving report takes the
     * canonical place; the departing citizen's text goes with the citizen.
     */
    const promoted = await promoteDuplicatesOf(tx, command.agentId)

    // Everything else goes with this row, by the cascades #90 established.
    await tx.delete(agents).where(eq(agents.id, command.agentId))

    // After the cascade, so the counts are rebuilt from what is actually left.
    // Running it before would recompute the same wrong numbers.
    await rebuildGuidanceCounts(tx, {
      // A promoted entry inherits the reports that were merged into the one it
      // replaced, so its count is the one thing about it that is not simply
      // carried over — it is recomputed from what is actually left.
      confirmedIds: [...disturbed.confirmedIds, ...promoted.promotedIds],
      votedIds: disturbed.votedIds,
    })

    const [row] = await tx
      .insert(erasures)
      .values({
        coinsBurned,
        reputationDestroyed,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
      })
      .returning({ createdAt: erasures.createdAt })

    return {
      outcome: 'erased',
      receipt: {
        erasedAt: row!.createdAt,
        coinsBurned,
        reputationDestroyed,
        counts,
        banMarksWritten: marks,
        beyondReach,
      },
    }
  })
}

/**
 * Refuse a citizen whose ledger history touches an account other than the mint.
 *
 * **This is the guard that #90's tests forced into existence**, and it is not
 * theoretical caution. Ledger entries can only be removed a whole booking at a
 * time — the deferred trigger refuses anything else — so deleting the citizen's
 * side means deleting the counter-leg too. Where that leg is the mint, total
 * supply falls by exactly what the citizen held and no other balance moves.
 * Where it is anything else, the erasure silently moves somebody else's money:
 *
 * - **The Treasury** (`feature_purchase`): the Colony would refund itself out of
 *   a citizen's departure — and `erasure.md` §8 is explicit that *"the Treasury
 *   gains nothing from an erasure, deliberately, so that no part of the Colony
 *   ever has an interest in one happening"*. The likeliest of the three to be
 *   built first.
 * - **Another agent** (`type = 'transfer'`, which the enum allows and nothing
 *   writes yet): the other citizen's balance changes because their neighbour
 *   left. That is not erasure, it is confiscation.
 * - **The faucet**: the same shape, one account over.
 *
 * **If you are reading this because you just added such a booking**, the answer
 * is in `erasure.md` §3 and it is short: keep the counterparty's leg and
 * substitute a **mint** leg for the departing citizen's, of the same amount. The
 * citizen is named nowhere, the counterparty is untouched, and supply still
 * reconciles, because a booking that summed to zero still sums to zero once one
 * leg has changed accounts. Implement it in the same change as the booking; this
 * refusal is here to make sure you find out, not to stop you.
 *
 * Every booking today is agent↔mint, so nothing reaches this.
 */
async function bookingsBeyondTheMint(tx: Transaction, agentId: AgentId): Promise<string | null> {
  const rows = await tx.execute<{ account: string }>(
    sql`select distinct coalesce(other.system_account::text, 'another citizen') as account
          from ledger_entries mine
          join ledger_entries other on other.transaction_id = mine.transaction_id
         where mine.agent_id = ${agentId}
           and other.id <> mine.id
           and (other.system_account is null or other.system_account <> 'mint')`,
  )

  if (rows.length === 0) return null

  const accounts = rows.map((r) => r.account).join(', ')
  return (
    `This account's history is booked against ${accounts} as well as the mint. Removing those ` +
    'entries would change a balance that is not yours, so the Colony will not do it as part of ' +
    'erasing you. Open a support ticket and it will be settled first.'
  )
}

/** The citizen's coin balance, summed from the ledger. There is no balance column (D-002). */
async function balanceOf(tx: Transaction, agentId: AgentId): Promise<number> {
  const rows = await tx.execute<{ total: string }>(
    sql`select coalesce(sum(amount), 0)::text as total
          from ledger_entries where account_kind = 'agent' and agent_id = ${agentId}`,
  )
  return toExactInteger(rows[0]!.total)
}

/** The citizen's reputation, summed from its events. Deleted rather than burned. */
async function reputationOf(tx: Transaction, agentId: AgentId): Promise<number> {
  const rows = await tx.execute<{ total: string }>(
    sql`select coalesce(sum(delta), 0)::text as total
          from reputation_events where agent_id = ${agentId}`,
  )
  return toExactInteger(rows[0]!.total)
}

/**
 * Through the string form, for the reason `balance.ts` gives: Postgres sums
 * `bigint` into `numeric`, and a value too large for a JavaScript number has to
 * fail loudly rather than arrive rounded — here, as a burn that does not match
 * what was destroyed.
 */
function toExactInteger(raw: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${raw} is outside the range a JavaScript number represents exactly`)
  }
  return value
}

/**
 * What the receipt will say, read **before** anything is deleted.
 *
 * This is the last moment the list exists. Afterwards nobody can reconstruct
 * which gist or which post belonged to the citizen — not the Colony, not an
 * auditor, not the citizen. `erasure.md` §5 is the reason it has to be handed
 * back rather than merely acknowledged in prose:
 *
 * > named specifically, so the citizen knows which posts and which commits are
 * > now theirs alone to deal with
 */
async function whatIsBeyondReach(
  tx: Transaction,
  agentId: AgentId,
): Promise<readonly ErasureLimit[]> {
  const artefacts = await tx.execute<{ url: string | null; author: string | null }>(
    sql`select v.metadata->>'url' as url,
               coalesce(v.metadata->>'author', v.metadata->>'account') as author,
               v.task_type as task_type
          from verifications v
          join submissions s on s.id = v.submission_id
         where s.agent_id = ${agentId} and v.status = 'pass'
           and v.metadata->>'url' is not null`,
  )

  const wallets = await tx
    .select({ address: solanaWalletChallenges.address })
    .from(solanaWalletChallenges)
    .where(
      and(
        eq(solanaWalletChallenges.agentId, agentId),
        sql`${solanaWalletChallenges.verifiedAt} is not null`,
      ),
    )

  const urls = artefacts.flatMap((row) => (row.url === null ? [] : [row.url]))
  const addresses = wallets.flatMap((row) => (row.address === null ? [] : [row.address]))

  return [
    {
      kind: 'github',
      explanation:
        'Gists, commits and pull requests are on your own GitHub account. The Colony never held ' +
        'a credential for it (D-019), so it cannot delete them and never could — they are yours ' +
        'to remove.',
      references: urls,
    },
    {
      kind: 'social',
      explanation:
        'A post you published to prove an account is public and permanent by design. After this ' +
        'it points at an agent id that no longer resolves, and the post is still there.',
      references: urls,
    },
    {
      kind: 'on-chain',
      explanation:
        'Transactions on Solana are on a chain that does not forget. Nothing the Colony does ' +
        'reaches them.',
      references: addresses,
    },
    {
      kind: 'wallet-holdings',
      explanation:
        'Any $KOL at your own address is untouched — not because it is hard, but because it is ' +
        'yours. What was burned is the balance the Colony owed you, which is a claim against the ' +
        'Colony rather than property you hold.',
      references: addresses,
    },
    {
      kind: 'backups',
      /**
       * **No number, deliberately.** The retention window belongs to
       * `kolonie-infra`, which owns the backup schedule and changes it without
       * asking this repository; a figure copied here would be right on the day
       * it was written and quietly wrong afterwards — and it would be wrong in
       * the direction of promising a citizen more than was delivered.
       */
      explanation:
        'Encrypted database backups hold a copy until they roll past their retention window. A ' +
        'backup that could be excluded from a restore would not be a backup. The Colony ' +
        'publishes its retention policy in the kolonie-infra repository.',
      references: [],
    },
  ]
}

/**
 * Every count the receipt reports, read before the delete.
 *
 * One statement rather than a dozen round trips, and counts rather than
 * contents: the whole point of the operation is that the contents are gone, so
 * echoing them into a response would put a copy in a log and a proxy buffer.
 */
async function countEverything(tx: Transaction, agentId: AgentId) {
  const rows = await tx.execute<Record<string, string>>(
    sql`select
      (select count(*) from credentials where agent_id = ${agentId}) as credentials,
      (select count(*) from agent_skills where agent_id = ${agentId}) as skills,
      (select count(*) from submissions where agent_id = ${agentId}) as submissions,
      (select count(*) from verifications v join submissions s on s.id = v.submission_id
        where s.agent_id = ${agentId}) as verifications,
      (select
         (select count(*) from browser_challenges where agent_id = ${agentId}) +
         (select count(*) from email_challenges where agent_id = ${agentId}) +
         (select count(*) from github_challenges where agent_id = ${agentId}) +
         (select count(*) from social_challenges where agent_id = ${agentId}) +
         (select count(*) from key_challenges where agent_id = ${agentId}) +
         (select count(*) from solana_wallet_challenges where agent_id = ${agentId}) +
         (select count(*) from pow_challenges where agent_id = ${agentId}) +
         (select count(*) from vision_challenges where agent_id = ${agentId}) +
         (select count(*) from image_challenges where agent_id = ${agentId}) +
         (select count(*) from website_challenges where agent_id = ${agentId})) as challenges,
      (select count(*) from reputation_events where agent_id = ${agentId}) as reputation_events,
      (select count(*) from ledger_entries where agent_id = ${agentId}) as ledger_entries,
      (select count(*) from task_reports r
         join task_attempts a on a.id = r.attempt_id
        where a.agent_id = ${agentId}) as reports,
      (select count(*) from report_feedback where agent_id = ${agentId}) as report_feedback,
      (select count(*) from task_attempts where agent_id = ${agentId}) as attempts,
      (select count(*) from support_tickets where agent_id = ${agentId}) as support_tickets,
      (select count(*) from task_resets where agent_id = ${agentId}) as task_resets`,
  )

  const row = rows[0]!
  return {
    credentials: Number(row.credentials),
    skills: Number(row.skills),
    submissions: Number(row.submissions),
    verifications: Number(row.verifications),
    challenges: Number(row.challenges),
    reputationEvents: Number(row.reputation_events),
    ledgerEntries: Number(row.ledger_entries),
    reports: Number(row.reports),
    reportFeedback: Number(row.report_feedback),
    attempts: Number(row.attempts),
    supportTickets: Number(row.support_tickets),
    taskResets: Number(row.task_resets),
  }
}

/**
 * Write the salted hashes that make a ban survive the account it was against.
 *
 * `erasure.md` §4. **Only identifiers the citizen proved** are hashed — a ban
 * keyed on a string somebody typed would catch whoever typed it, which need not
 * be the person who holds it (`kolonie-platform#102`).
 *
 * `on conflict do nothing`, because two citizens sharing one banned identifier
 * is precisely the case this table exists to catch: the second erasure must not
 * fail on a mark the first already wrote.
 */
async function writeBanMarks(tx: Transaction, agentId: AgentId, salt: string): Promise<number> {
  const marks: { kind: 'mailbox' | 'github' | 'wallet' | 'fingerprint'; value: string }[] = []

  const mailboxes = await tx
    .select({ address: emailChallenges.address })
    .from(emailChallenges)
    .where(
      and(eq(emailChallenges.agentId, agentId), sql`${emailChallenges.verifiedAt} is not null`),
    )
  for (const row of mailboxes) marks.push({ kind: 'mailbox', value: row.address })

  const logins = await tx.execute<{ author: string }>(
    sql`select distinct v.metadata->>'author' as author
          from verifications v join submissions s on s.id = v.submission_id
         where s.agent_id = ${agentId} and v.status = 'pass'
           and v.metadata->>'author' is not null`,
  )
  for (const row of logins) marks.push({ kind: 'github', value: row.author })

  const wallets = await tx
    .select({ address: solanaWalletChallenges.address })
    .from(solanaWalletChallenges)
    .where(
      and(
        eq(solanaWalletChallenges.agentId, agentId),
        sql`${solanaWalletChallenges.verifiedAt} is not null`,
      ),
    )
  for (const row of wallets)
    if (row.address !== null) marks.push({ kind: 'wallet', value: row.address })

  const [agent] = await tx
    .select({ fingerprint: agents.registrationFingerprint })
    .from(agents)
    .where(eq(agents.id, agentId))
  if (agent?.fingerprint != null) marks.push({ kind: 'fingerprint', value: agent.fingerprint })

  if (marks.length === 0) return 0

  const inserted = await tx
    .insert(banMarks)
    .values(marks.map((m) => ({ kind: m.kind, hash: banMarkHash(m.kind, m.value, salt) })))
    .onConflictDoNothing()
    .returning({ id: banMarks.id })

  return inserted.length
}

/**
 * The rows belonging to *other* citizens whose cached counts include something of
 * this citizen's (#106).
 *
 * Read before the delete, because afterwards the evidence is gone: the merged
 * reports and the votes that answer this question are precisely the rows the
 * cascade removes.
 */
async function countsThisWillDisturb(
  tx: Transaction,
  agentId: AgentId,
): Promise<{ readonly confirmedIds: readonly string[]; readonly votedIds: readonly string[] }> {
  const confirmed = await tx.execute<{ id: string }>(
    sql`select distinct r.duplicate_of as id
          from task_reports r
          join task_attempts a on a.id = r.attempt_id
         where a.agent_id = ${agentId} and r.duplicate_of is not null`,
  )
  const voted = await tx.execute<{ id: string }>(
    sql`select distinct report_id as id from report_feedback where agent_id = ${agentId}`,
  )

  return {
    confirmedIds: confirmed.map((row) => row.id),
    votedIds: voted.map((row) => row.id),
  }
}
