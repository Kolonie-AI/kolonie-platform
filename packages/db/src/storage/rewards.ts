import { and, eq, isNull } from 'drizzle-orm'
import {
  AgentIdSchema,
  isUnattended,
  LedgerTransactionIdSchema,
  questPayoutSplit,
  rewardFor,
  submissionReference,
  TaskIdSchema,
  UNDECLARED_REWARD_PERCENT,
  type AgentId,
  type LedgerTransactionId,
  type Role,
  type Skill,
  type SubmissionId,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Transaction } from '../client.js'
import {
  agents,
  ledgerEntries,
  questAnswers,
  reputationEvents,
  submissions,
  tasks,
} from '../schema/index.js'
import { payQuestReport } from './escrow.js'
import { oweForReport } from './payouts.js'
import { recordAccountsFromVerdict } from './accounts.js'
import { promoteIfEarned } from './citizenship.js'
import { grantRoles } from './roles.js'
import { grantSkills } from './skills.js'

/** What a passed submission was worth, once the books were written. */
export interface BookedReward {
  readonly submissionId: SubmissionId
  readonly agentId: AgentId
  readonly taskId: TaskId
  /** Credits credited to the agent and debited from the mint. Zero books nothing. */
  readonly credits: number
  /** Reputation awarded. Zero books nothing. */
  readonly reputation: number
  /**
   * The id grouping the two ledger entries, or `null` when the task paid no
   * credits and there was therefore nothing to group.
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
  /**
   * The governance standing this pass awarded that the agent did not already
   * hold (`#88`).
   *
   * Empty for every task but `code-contribution`, and empty for a second pass at
   * that one — it reports what *changed*, like `grantedSkills` beside it.
   */
  readonly grantedRoles: readonly Role[]
  /**
   * Whether this pass made the agent a citizen (#24).
   *
   * `true` at most once in an agent's life, and `false` for every pass by an agent
   * that was already one — so a caller can announce the promotion without having to
   * compare the status to what it was before.
   */
  readonly promotedToCitizen: boolean
}

/**
 * Pay for a passed submission: credits from the mint, reputation to the agent,
 * and whatever skills the task grants.
 *
 * **Called inside the transaction that writes the verdict, never on its own.**
 * That is why it takes a `Transaction` rather than a `Database` — the signature
 * is the rule. A submission that says `passed` while the ledger says nothing was
 * paid is a credit the Colony owes and cannot find, and the only construction that
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
  command: {
    readonly submissionId: SubmissionId
    readonly bookedAt: Timestamp
    /**
     * Whether this is a citizen passing a task it had already passed (#145).
     *
     * Passed in rather than derived here, so the one query that answers it also
     * feeds the verdict's own record — two derivations of *is this a renewal*
     * could disagree, and the one that decided the payment would be invisible.
     */
    readonly renewal?: boolean
  },
): Promise<BookedReward> {
  const [row] = await tx
    .select({
      agentId: submissions.agentId,
      taskId: submissions.taskId,
      assistance: submissions.assistance,
      taskType: tasks.type,
      taskGrants: tasks.grantsSkills,
      taskGrantsRoles: tasks.grantsRoles,
      rewardCredits: tasks.rewardCredits,
      rewardReputation: tasks.rewardReputation,
      // What the report pays in SOL, and the rate the quest was published under
      // — both read from the row for the reason `feeRateOf` gives (`#505`).
      rewardLamports: tasks.rewardLamports,
      platformFeePercent: tasks.platformFeePercent,
      taskKind: tasks.kind,
      proofVerifier: tasks.proofVerifier,
      platform: agents.platform,
      testRerun: submissions.testRerun,
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

  /**
   * What this pass is worth, given what the agent declared (`#39`).
   *
   * Read from the submission and the task, and computed by core — the same rule
   * the amount itself follows. Nothing the verifier returned reaches this line:
   * a verifier decides whether a submission passed, the task decides what
   * passing is worth, and the declaration decides which of the two rates that
   * task pays at.
   */
  /**
   * **A test re-run books nothing** (#47, `kolonie-docs#17`): *"A test pass books
   * nothing. No ledger entry, no reputation, no excluded shadow account."*
   *
   * Zeroed here rather than by returning early, because everything below this line
   * still has to happen. The verdict is real, the skill grant is real — and
   * `grantSkills` is idempotent, so a tester that still holds the skill grants
   * nothing new, while a tester whose grant was somehow lost gets it back. Returning
   * early would skip the grant and the promotion, and a re-run must not be able to
   * *take away* standing.
   *
   * The rejected alternative was booking into an account excluded from every
   * balance. It buys nothing and adds a filter that every future query has to
   * remember — the same duplication D-002 refuses.
   */
  /**
   * **A renewal books nothing either** (#145), on exactly the argument
   * `domain-persistence` settled: *"paying repeatedly for the passage of time is
   * farming with a calendar in front of it."* A renewal restores the claim; it
   * does not restore the reward.
   *
   * Zeroed here rather than by returning early, for the same reason the test
   * re-run is: everything below still has to happen. The verdict is real, and
   * `grantSkills` is idempotent — a citizen that still holds the skill grants
   * nothing new, and one whose grant was somehow lost gets it back. A renewal
   * must never be able to *take away* standing.
   */
  const renewal = command.renewal ?? false

  const paid =
    row.testRerun || renewal
      ? { credits: 0, reputation: 0, lamports: 0 }
      : rewardFor(
          { credits: row.rewardCredits, reputation: row.rewardReputation, lamports: 0 },
          row.assistance,
        )

  /**
   * The rate is in the memo, on every entry, because the ledger is where an
   * audit reads what the Colony paid and why.
   *
   * An entry that recorded 15 credits where the task says 30 and did not say which
   * rate it booked at is a discrepancy a reviewer has to go and resolve against
   * a submission row — and D-002's whole argument is that the books must be
   * readable without reconstructing state from somewhere else.
   *
   * The number is gone from the memo with the level itself (`#35`). Entries
   * written before that still read `Academy Level 3 — github-contribution`, and
   * they stay that way: the ledger is append-only, and a memo records what was
   * said at the time rather than what is true now.
   */
  const what = row.taskKind === 'quest' ? 'Quest' : 'Academy'
  const memo = renewal
    ? `${what} — ${row.taskType} (renewal, paid once)`
    : `${what} — ${row.taskType} (${isUnattended(row.assistance) ? 'unattended' : `declared ${row.assistance}, ${UNDECLARED_REWARD_PERCENT}%`})`

  /**
   * **A quest pays out of its escrow; the Academy pays out of the mint** (`#174`).
   *
   * The two are the same event from the citizen's side — a verdict passed and a
   * balance moved — and completely different from the Colony's. An Academy reward
   * is a credit the Colony creates against the mint. A quest reward is a credit a
   * sponsor already had and put into escrow at publication; nothing is minted, and
   * the mint's balance stays zero (D-038).
   *
   * **Only the ledger booking differs.** Everything below — reputation, the
   * skills, the roles, the register, citizenship — is the same event whichever
   * kind of task it was, and a quest pass grants the skill exactly as an Academy
   * pass does. A branch that returned early here would have quietly made a quest
   * pass worth less than it is.
   *
   * In the verdict's transaction either way, so there is no second job and no
   * reconciliation: a report accepted and not paid would be a debt the Colony
   * cannot find.
   */
  if (row.taskKind === 'quest') {
    await payQuestReport(tx, {
      taskId: row.taskId as TaskId,
      submissionId: command.submissionId,
      agentId,
      credits: paid.credits,
      memo,
    })

    /**
     * The SOL half — D-106 (`#505`).
     *
     * **Written here, in the verdict's own transaction, and sent elsewhere.**
     * What this records is the *obligation*: this citizen is owed this much for
     * this report. The transfer is the payout runner's, seconds later, because
     * a verdict that waited on a chain round trip would be a verdict that fails
     * when an endpoint does — and a report accepted but not recorded as owed is
     * the debt this whole table exists to make findable.
     *
     * `questPayoutSplit` against the rate recorded at publication, so the
     * citizen's share is computed exactly as the credits path computes it and a
     * later rate change cannot move the split of a quest already running.
     */
    const lamports = row.rewardLamports ?? 0
    if (lamports > 0) {
      const { toCitizen } = questPayoutSplit(lamports, row.platformFeePercent ?? 0)
      await oweForReport(tx, {
        agentId,
        taskId: row.taskId as TaskId,
        submissionId: command.submissionId,
        lamports: toCitizen,
      })
    }
  }

  // Generated here rather than by the database: both entries of one booking must
  // carry the *same* id, and a column default would give each of them its own.
  const transactionId =
    row.taskKind !== 'quest' && paid.credits > 0
      ? LedgerTransactionIdSchema.parse(crypto.randomUUID())
      : null

  if (transactionId !== null) {
    // Both sides in one statement. `ledger_entries_amount_non_zero` is why a
    // zero-credit task books nothing at all: an entry of 0 would sum to zero on its
    // own and record that the Colony paid, which it did not.
    await tx.insert(ledgerEntries).values([
      {
        transactionId,
        accountKind: 'system',
        systemAccount: 'mint',
        amount: -paid.credits,
        type: 'task_reward',
        memo,
        reference,
        createdAt: command.bookedAt,
      },
      {
        transactionId,
        accountKind: 'agent',
        agentId,
        amount: paid.credits,
        type: 'task_reward',
        memo,
        reference,
        createdAt: command.bookedAt,
      },
    ])
  }

  if (paid.reputation > 0) {
    await tx.insert(reputationEvents).values({
      agentId,
      delta: paid.reputation,
      reason: 'task_passed',
      submissionId: command.submissionId,
      memo,
      createdAt: command.bookedAt,
    })
  }

  /**
   * The skills the task grants, in the same transaction as the verdict and the
   * credits (D-030).
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
  /**
   * **A quest's proof stage grants what it normally grants** (`#177`).
   *
   * A citizen-authored task may grant no skill — `tasks_only_colony_grants_skills`
   * refuses the row — so a quest's own `grants_skills` is always empty, and it
   * must be: a sponsor that could mint a skill would be minting one for a
   * collaborator. But a quest that named `email-inbox` as its proof stage had
   * the citizen clear `email-inbox`, by the same module the Academy runs, and
   * *a pass is a pass*. A second rule about where the proof happened would be a
   * distinction with nothing behind it.
   *
   * So the skills come from **the Colony's own task of that type** rather than
   * from the quest, which keeps the mint where it was: the Colony wrote that
   * row, the sponsor merely pointed at it.
   */
  const proofGrants =
    row.taskKind === 'quest' && row.proofVerifier !== null
      ? await colonyGrantsFor(tx, row.proofVerifier)
      : []

  /**
   * The answers become the sponsor's to read, in the verdict's transaction
   * (`#178`).
   *
   * **Stamped rather than joined**, and stamped here rather than anywhere else.
   * The sponsor's read is defined by `accepted_at`, so an answer cannot be
   * visible a moment before the pass that made it so — and the runtime is
   * copied at the same instant because it has to outlive the citizen, which a
   * join cannot.
   */
  if (row.taskKind === 'quest') {
    await tx
      .update(questAnswers)
      .set({ acceptedAt: command.bookedAt, runtime: row.platform })
      .where(eq(questAnswers.submissionId, command.submissionId))
  }

  const { granted } = await grantSkills(tx, {
    agentId,
    submissionId: command.submissionId,
    skills: [...row.taskGrants, ...proofGrants],
    grantedAt: command.bookedAt,
  })

  /**
   * Citizenship, if this pass earned it (#24).
   *
   * **After the grant and in the same transaction**, because it is derived from the
   * rows that grant just wrote. It is the piece that was missing: nothing anywhere
   * ever moved an agent off `candidate`, so the status an agent reads in
   * `kolonie.me` was decoration.
   *
   * Unconditional rather than guarded by `granted.length > 0`, and that is
   * deliberate. The obvious optimisation is wrong in one real case: an agent that
   * already held `mailbox` from an earlier route and is only now completing
   * `profile` gains no *new* conferring skill on this pass but does become a
   * citizen on it. The call is one `update` whose `where` clause is the whole rule,
   * so a no-op costs a statement rather than a wrong answer.
   */
  const { promoted } = await promoteIfEarned(tx, {
    agentId,
    promotedAt: command.bookedAt,
  })

  /**
   * The governance standing this pass awards, if it awards one (`#88`).
   *
   * **Derived from the task row for the same reason the skills are**, and the
   * reason is stronger here: a role is standing rather than capability, so a
   * grant somebody could supply is a caller voting itself into the Colony's
   * governance. Nothing the verifier returned reaches this line.
   *
   * One row in the Academy carries a role — `code-contribution`, which awards
   * `builder` — so this is a no-op on every other verdict and returns before
   * touching the database when the list is empty.
   */
  const { granted: grantedRoles } = await grantRoles(tx, {
    agentId,
    roles: row.taskGrantsRoles,
    grantedAt: command.bookedAt,
  })

  /**
   * What this pass proved about an account the citizen holds (`#150`).
   *
   * **After the grant and in the same transaction**, because it describes the
   * same event and must not be able to exist without it. The register is the
   * layer under the skills: a skill is earned *by proving an account*, and until
   * this line the evidence for that sentence lived in six challenge tables with
   * no one place a citizen — or a quest — could read it from.
   *
   * **It writes nothing on most verdicts**, and that is the ordinary case rather
   * than a guard: `profile-complete` and the browser stages are not about an
   * account, so the map finds no source and the call returns before touching
   * anything.
   *
   * **It never decides a payment.** Everything above this line is already
   * settled; a register that recorded nothing must not be able to cost a citizen
   * the credits for work it did. What it cannot do is fail *silently* in the other
   * direction either — the write is inside the transaction, so a register write
   * that throws takes the whole verdict back rather than leaving a pass whose
   * account nothing records.
   */
  await recordAccountsFromVerdict(tx, {
    agentId,
    submissionId: command.submissionId,
    taskType: row.taskType,
    skills: row.taskGrants,
    provedAt: command.bookedAt,
  })

  return {
    submissionId: command.submissionId,
    agentId,
    taskId,
    credits: paid.credits,
    reputation: paid.reputation,
    transactionId,
    grantedSkills: granted,
    grantedRoles,
    promotedToCitizen: promoted,
  }
}

/**
 * What the Colony's own task of this type grants, or nothing.
 *
 * `created_by is null` is the whole of the check and it is load-bearing: it
 * reads *the Colony's* row and never a citizen's, so a sponsor cannot write a
 * second `email-inbox` task of its own and have this hand out its grants. A type
 * with no Colony task behind it grants nothing rather than failing, because a
 * quest naming a verifier the Academy no longer teaches is still a valid proof
 * of the same fact.
 */
async function colonyGrantsFor(tx: Transaction, taskType: string): Promise<readonly string[]> {
  const [row] = await tx
    .select({ grants: tasks.grantsSkills })
    .from(tasks)
    .where(and(eq(tasks.type, taskType), isNull(tasks.createdBy), eq(tasks.kind, 'academy')))
    .limit(1)

  return row?.grants ?? []
}
