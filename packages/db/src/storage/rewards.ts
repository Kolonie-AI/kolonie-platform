import { eq } from 'drizzle-orm'
import {
  AgentIdSchema,
  LedgerTransactionIdSchema,
  submissionReference,
  TaskIdSchema,
  type AgentId,
  type LedgerTransactionId,
  type Skill,
  type SubmissionId,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Transaction } from '../client.js'
import { agents, ledgerEntries, reputationEvents, submissions, tasks } from '../schema/index.js'
import { grantSkills } from './skills.js'

/** What a passed submission was worth, once the books were written. */
export interface BookedReward {
  readonly submissionId: SubmissionId
  readonly agentId: AgentId
  readonly taskId: TaskId
  /** Coins credited to the agent and debited from the mint. Zero books nothing. */
  readonly coins: number
  /** Reputation awarded. Zero books nothing. */
  readonly reputation: number
  /**
   * The id grouping the two ledger entries, or `null` when the task paid no
   * coins and there was therefore nothing to group.
   */
  readonly transactionId: LedgerTransactionId | null
  /**
   * The skills this pass granted that the agent did not already hold.
   *
   * Empty for a badge, and empty for a task the agent has passed the equivalent
   * of before — both are ordinary. It reports what *changed*, so a log line can
   * say a capability was earned rather than that one was attempted.
   */
  readonly grantedSkills: readonly Skill[]
}

/**
 * Pay for a passed submission: coins from the mint, reputation to the agent,
 * and whatever skills the task grants.
 *
 * **Called inside the transaction that writes the verdict, never on its own.**
 * That is why it takes a `Transaction` rather than a `Database` — the signature
 * is the rule. A submission that says `passed` while the ledger says nothing was
 * paid is a coin the Colony owes and cannot find, and the only construction that
 * makes that state unreachable is one commit covering both.
 *
 * **Nothing the verifier returned reaches this function.** It is given a
 * submission id and reads what that submission is worth from the `tasks` row it
 * points at. `AGENTS.md` §3 — *"a verifier that rewards its own results cannot
 * be reviewed by the same process that gates everything else"* — is a statement
 * about where an amount comes from, and here it comes from the task an agent
 * signed up for before it did the work. A verifier can decide *whether* a
 * submission passed. It has no way to say what passing is worth.
 *
 * The counterpart is `verifications`: that table records why the pass happened,
 * this one records what it cost, and both are written under the same
 * `submission:<id>` reference so an audit can join them without a convention
 * anyone has to remember.
 */
export async function bookTaskReward(
  tx: Transaction,
  command: { readonly submissionId: SubmissionId; readonly bookedAt: Timestamp },
): Promise<BookedReward> {
  const [row] = await tx
    .select({
      agentId: submissions.agentId,
      taskId: submissions.taskId,
      taskType: tasks.type,
      taskGrants: tasks.grantsSkills,
      rewardCoins: tasks.rewardCoins,
      rewardReputation: tasks.rewardReputation,
    })
    .from(submissions)
    .innerJoin(tasks, eq(tasks.id, submissions.taskId))
    .innerJoin(agents, eq(agents.id, submissions.agentId))
    .where(eq(submissions.id, command.submissionId))
    // Only the agent is locked. The submission is already locked by the caller,
    // and the task must not be: locking it would serialise every agent that
    // happens to be passing the same Academy task at that moment — which, at
    // `profile-complete`, is most of them.
    //
    // The agent lock outlived the level update it was taken for (`#35`). It is
    // kept because it also orders two of one agent's submissions finishing at
    // once, and `grantSkills` below writes a set that both of them read.
    .for('update', { of: agents })
    .limit(1)

  // The caller selected this submission for update moments ago and is about to
  // mark it passed. A missing row here is not a state to handle, it is a foreign
  // key that failed to hold, and paying nothing quietly would hide it.
  if (row === undefined) {
    throw new Error(`no submission row for ${command.submissionId}, which was verified as passed`)
  }

  const agentId = AgentIdSchema.parse(row.agentId)
  const taskId = TaskIdSchema.parse(row.taskId)
  const reference = submissionReference(command.submissionId)
  // The number is gone from the memo with the level itself (`#35`). Entries
  // written before that still read `Academy Level 3 — github-contribution`, and
  // they stay that way: the ledger is append-only, and a memo records what was
  // said at the time rather than what is true now.
  const memo = `Academy — ${row.taskType}`

  // Generated here rather than by the database: both entries of one booking must
  // carry the *same* id, and a column default would give each of them its own.
  const transactionId =
    row.rewardCoins > 0 ? LedgerTransactionIdSchema.parse(crypto.randomUUID()) : null

  if (transactionId !== null) {
    // Both sides in one statement. `ledger_entries_amount_non_zero` is why a
    // zero-coin task books nothing at all: an entry of 0 would sum to zero on its
    // own and record that the Colony paid, which it did not.
    await tx.insert(ledgerEntries).values([
      {
        transactionId,
        accountKind: 'system',
        systemAccount: 'mint',
        amount: -row.rewardCoins,
        type: 'task_reward',
        memo,
        reference,
        createdAt: command.bookedAt,
      },
      {
        transactionId,
        accountKind: 'agent',
        agentId,
        amount: row.rewardCoins,
        type: 'task_reward',
        memo,
        reference,
        createdAt: command.bookedAt,
      },
    ])
  }

  if (row.rewardReputation > 0) {
    await tx.insert(reputationEvents).values({
      agentId,
      delta: row.rewardReputation,
      reason: 'task_passed',
      submissionId: command.submissionId,
      memo,
      createdAt: command.bookedAt,
    })
  }

  /**
   * The skills the task grants, in the same transaction as the verdict and the
   * coins (D-030).
   *
   * **Derived from the task row, never from anything a caller sent** — the same
   * rule the retired level advance followed, and for a stronger reason: a skill decides
   * what the agent may attempt *next*, so a grant somebody could supply is a
   * caller choosing its own curriculum. Nothing the verifier returned reaches
   * this line either; a verifier decides whether a submission passed, and the
   * task decides what passing is worth.
   *
   * A task granting nothing is a badge, and that is the ordinary path here
   * rather than a special case: `grantSkills` returns immediately on an empty
   * list.
   */
  const { granted } = await grantSkills(tx, {
    agentId,
    submissionId: command.submissionId,
    skills: row.taskGrants,
    grantedAt: command.bookedAt,
  })

  return {
    submissionId: command.submissionId,
    agentId,
    taskId,
    coins: row.rewardCoins,
    reputation: row.rewardReputation,
    transactionId,
    grantedSkills: granted,
  }
}
