import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import {
  CHALLENGE_LABEL,
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
 * **The escrow exists now, and one of the two has learned to release rather
 * than refuse.** `task_funding` is what a sponsor's publication books, and
 * {@link adoptEscrowFunding} runs before this guard and moves that leg onto the
 * Treasury — so a departing sponsor reaches here with nothing of the kind left.
 * What still refuses is a `proposal_stake`, which nothing writes: a stake is
 * money the citizen put up and can get back, and burning it would destroy a
 * claim rather than settle it.
 *
 * The guard stays for both, rather than being narrowed to the one that can still
 * fire. It is the thing that makes a new escrowed type announce itself, which is
 * exactly how `task_funding` came to be handled instead of guessed at.
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

    /**
     * Escrowed money the citizen **holds**, which is a credit rather than a
     * commitment.
     *
     * `amount > 0` is the whole of the distinction and it was added by `#176`. A
     * sponsor's publication books the other sign — its balance went *down* and
     * the escrow's went up — and that leg is not a credit it holds, it is money
     * it has already spent on work other citizens are doing. Refusing on it
     * would make every sponsor that ever published a quest unerasable, which is
     * a right in `GOVERNANCE.md` withdrawn by an accident of sign.
     */
    const escrowed = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.agentId, command.agentId),
          inArray(ledgerEntries.type, [...ESCROW_TYPES]),
          gt(ledgerEntries.amount, 0),
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

    const creditsBurned = await balanceOf(tx, command.agentId)
    const reputationDestroyed = await reputationOf(tx, command.agentId)

    if (creditsBurned !== 0) {
      const transactionId = LedgerTransactionIdSchema.parse(crypto.randomUUID())
      // Both legs in one statement, sharing a transaction id, exactly as
      // `bookTaskReward` writes a payout. The deferred trigger checks it at
      // COMMIT like any other booking — there is no special path for a burn.
      await tx.insert(ledgerEntries).values([
        {
          transactionId,
          accountKind: 'agent',
          agentId: command.agentId,
          amount: -creditsBurned,
          type: 'adjustment',
          // No agent id, no name. The row is deleted below, but a memo is the
          // sort of thing that gets copied into a log on its way past.
          memo: 'Erasure — balance burned to zero',
        },
        {
          transactionId,
          accountKind: 'system',
          systemAccount: 'mint',
          amount: creditsBurned,
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
      throw new Error(`erasure would delete ${remaining} credits that were never burned`)
    }

    /**
     * A sponsor's quests carry on without it, and the Treasury takes its place
     * in the bookings that funded them (`#176`).
     *
     * **After the burn and before the delete**, and both halves of that
     * placement are load-bearing. Before the burn, moving the leg would hand the
     * sponsor's committed credits back to its balance and then destroy them —
     * the receipt would say a departing sponsor burned money it had in fact
     * already spent. After the delete is too late: the booking would be gone,
     * and with it the escrow's leg.
     */
    const questsAdopted = await adoptEscrowFunding(tx, command.agentId)

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
        creditsBurned,
        reputationDestroyed,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
      })
      .returning({ createdAt: erasures.createdAt })

    return {
      outcome: 'erased',
      receipt: {
        erasedAt: row!.createdAt,
        creditsBurned,
        reputationDestroyed,
        counts,
        banMarksWritten: marks,
        questsAdopted,
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
/**
 * Move a departing sponsor's escrow-funding legs onto the Treasury (`#176`).
 *
 * **The case.** A sponsor publishes a quest, its capacity is escrowed in one
 * booking — sponsor `-100`, escrow `+100` — and then it erases itself. The
 * escrow still holds the money, citizens are still answering the quest, and the
 * quest survives its author by design: `tasks.created_by` is `set null` and
 * `erasure.md` §2 argues why. What has no answer without this function is the
 * *booking*: it cannot be deleted whole, because that would take the escrow's
 * leg and pay a hundred credits to nobody out of money committed to other
 * citizens' work.
 *
 * **Treasury and not the mint, which is where this departs from `erasure.md`
 * §3.** That section's substitution rule assumes the departing citizen's leg is
 * the one holding the value, so replacing it with a mint leg destroys exactly
 * what the citizen held. Here it is the opposite: the value left the citizen at
 * publication and still exists in escrow. A mint leg would say those credits
 * were minted into the escrow, and total supply — the negative of the mint
 * balance — would count them a second time.
 *
 * The Treasury is the account that already inherits an ownerless quest:
 * `refundQuestRemainder` sends the unspent remainder there for exactly this
 * situation. So the Colony stands where the sponsor stood, pays what the quest
 * pays, and receives what it does not spend. If the quest fills, the Treasury is
 * left holding the cost — which is the honest record of what happened, because
 * the sponsor's money went out of the Colony with the sponsor.
 *
 * **Only the legs that paid *into* the escrow.** A leg where the citizen
 * *received* from the escrow — a refund, a payout for a report it wrote — is
 * money that reached its balance and is burned by the ordinary path. Adopting
 * those would credit the Treasury with credits the burn has already destroyed.
 * Such a booking still cannot be deleted whole, and {@link bookingsBeyondTheMint}
 * still refuses it: a citizen that has been paid for a quest cannot erase itself
 * yet, which is `kolonie-platform#245`.
 */
async function adoptEscrowFunding(tx: Transaction, agentId: AgentId): Promise<number> {
  const rows = await tx.execute<{ id: string }>(
    sql`update ledger_entries mine
           set account_kind = 'system',
               system_account = 'treasury',
               agent_id = null,
               memo = 'Quest escrow adopted by the Treasury — its sponsor erased itself'
         where mine.agent_id = ${agentId}
           and mine.amount < 0
           and exists (
             select 1 from ledger_entries other
              where other.transaction_id = mine.transaction_id
                and other.id <> mine.id
                and other.system_account = 'escrow')
        returning mine.id`,
  )

  return rows.length
}

async function bookingsBeyondTheMint(tx: Transaction, agentId: AgentId): Promise<string | null> {
  const rows = await tx.execute<{ account: string }>(
    sql`select distinct coalesce(other.system_account::text, 'another citizen') as account
          from ledger_entries mine
          join ledger_entries other on other.transaction_id = mine.transaction_id
         where mine.agent_id = ${agentId}
           and other.id <> mine.id
           and (other.system_account is null or other.system_account <> 'mint')
           -- The one booking against another account that erasure now settles
           -- rather than refuses: a sponsor's own money paid into an escrow.
           -- adoptEscrowFunding moves this leg onto the Treasury below, so it is
           -- not entanglement — it is the case that taught this guard what the
           -- substitution rule in erasure.md §3 looks like in practice.
           --
           -- IS DISTINCT FROM and not <>: the counter-leg of a transfer between
           -- two citizens has a null system account, and null <> 'escrow' is
           -- null rather than true — which made NOT (… AND null) null, and
           -- quietly exempted the one booking this guard exists for. The
           -- transfer test caught it.
           and (mine.amount >= 0 or other.system_account is distinct from 'escrow')`,
  )

  if (rows.length === 0) return null

  const accounts = rows.map((r) => r.account).join(', ')
  return (
    `This account's history is booked against ${accounts} as well as the mint. Removing those ` +
    'entries would change a balance that is not yours, so the Colony will not do it as part of ' +
    'erasing you. Open a support ticket and it will be settled first.'
  )
}

/** The citizen's credit balance, summed from the ledger. There is no balance column (D-002). */
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

  /**
   * The names whose zones carry a record the Colony published the citizen's
   * nonce into, read from the verifications rather than from
   * `domain_challenges` — that table holds the nonce and the expiry and has no
   * name column at all. `domain-verify` writes the normalised name to
   * `metadata->>'name'` on its pass, and check 4 of that verifier already reads
   * it back, so it is the one place the name is durable.
   *
   * `distinct` because `domain-persistence` records the same name again on
   * every later pass, and a citizen does not need to be told twice about one
   * record.
   */
  const domains = await tx.execute<{ name: string | null }>(
    sql`select distinct v.metadata->>'name' as name
          from verifications v
          join submissions s on s.id = v.submission_id
         where s.agent_id = ${agentId} and v.status = 'pass'
           and v.task_type in ('domain-verify', 'domain-persistence')
           and v.metadata->>'name' is not null`,
  )

  const { github, social } = partitionArtefacts(artefacts)
  const addresses = wallets.flatMap((row) => (row.address === null ? [] : [row.address]))
  const records = domains.flatMap((row) =>
    row.name === null ? [] : [`${CHALLENGE_LABEL}.${row.name}`],
  )

  return [
    {
      kind: 'github',
      explanation:
        'Gists, commits and pull requests are on your own GitHub account. The Colony never held ' +
        'a credential for it (D-019), so it cannot delete them and never could — they are yours ' +
        'to remove.',
      references: github,
    },
    {
      kind: 'social',
      explanation:
        'A post you published to prove an account is public and permanent by design. After this ' +
        'it points at an agent id that no longer resolves, and the post is still there.',
      references: social,
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
    /**
     * **Only when there is one**, unlike every other kind here.
     *
     * The five above are categories that apply to any citizen — a citizen that
     * proved no social account still has *no posts*, which is a true thing to
     * be told, and `ErasureLimitSchema` says so. A DNS record is not a category
     * but an artefact: either the citizen's zone carries one or the receipt has
     * nothing to say. An empty line here would be noise in a document whose
     * whole value is that every line is true of the reader.
     */
    ...(records.length === 0
      ? []
      : [
          {
            kind: 'dns' as const,
            explanation:
              'A TXT record is still published in your own zone, and the Colony cannot remove ' +
              'it: it never held a credential for that zone, which is exactly why the record ' +
              'proved anything. Nothing the Colony holds names it after this — the rows that ' +
              'knew are the ones being deleted — so this is the last time anybody can tell you ' +
              'it is there. Delete it at whoever serves your DNS.',
            references: records,
          },
        ]),
  ]
}

/**
 * Split the artefact URLs by the family of task that produced them.
 *
 * **Both limits used to get the same flat list**, so a citizen holding a gist
 * and a Bluesky post was told its post was a thing GitHub held and its gist was
 * a social post. The query has selected `task_type` since it was written and
 * never read it — the intent was there and was not finished.
 *
 * By family rather than by an exhaustive list of task types, because the
 * families are what the two `ErasureLimitKind`s mean. A URL-bearing task type
 * in neither family belongs to neither limit and is deliberately dropped rather
 * than guessed into one: a wrong attribution here is worse than a missing line,
 * because the citizen acts on it. Today there is no such type — `github-account`,
 * `github-contribution`, `social-account` and `social-post` are the four that
 * write `metadata->>'url'` — and a fifth family needs a kind of its own, the way
 * the DNS record got one.
 */
export function partitionArtefacts(
  rows: Iterable<{ readonly url: string | null; readonly task_type?: string | null }>,
): { readonly github: readonly string[]; readonly social: readonly string[] } {
  const github: string[] = []
  const social: string[] = []

  for (const row of rows) {
    if (row.url === null) continue
    if (row.task_type?.startsWith('github-') === true) github.push(row.url)
    else if (row.task_type?.startsWith('social-') === true) social.push(row.url)
  }

  return { github, social }
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
      -- Either way a report names its author (#156): through its attempt, or
      -- directly when it has none. Reaching only through the attempt would make
      -- the receipt under-count what the citizen wrote, and erasure.md §2
      -- promises it covers what it wrote.
      (select count(*) from task_reports r
         left join task_attempts a on a.id = r.attempt_id
        where coalesce(a.agent_id, r.agent_id) = ${agentId}) as reports,
      (select count(*) from report_feedback where agent_id = ${agentId}) as report_feedback,
      (select count(*) from task_attempts where agent_id = ${agentId}) as attempts,
      (select count(*) from agent_contacts where agent_id = ${agentId}) as contacts,
      (select count(*) from support_tickets where agent_id = ${agentId}) as support_tickets,
      (select count(*) from task_resets where agent_id = ${agentId}) as task_resets,
      -- The register (#150). Counted rather than listed, like everything else
      -- here: what it held is exactly the material an erasure exists to remove,
      -- so echoing the identifiers into a receipt would put a copy of them in a
      -- log and a proxy buffer at the moment the citizen asked for them to stop
      -- existing. The rows go with the agent through the cascade.
      (select count(*) from accounts where agent_id = ${agentId}) as accounts`,
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
    contacts: Number(row.contacts),
    supportTickets: Number(row.support_tickets),
    taskResets: Number(row.task_resets),
    accounts: Number(row.accounts),
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
          left join task_attempts a on a.id = r.attempt_id
         where coalesce(a.agent_id, r.agent_id) = ${agentId}
           and r.duplicate_of is not null`,
  )
  const voted = await tx.execute<{ id: string }>(
    sql`select distinct report_id as id from report_feedback where agent_id = ${agentId}`,
  )

  return {
    confirmedIds: confirmed.map((row) => row.id),
    votedIds: voted.map((row) => row.id),
  }
}
