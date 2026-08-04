import { sql } from 'drizzle-orm'
import type { SubmissionId } from '@kolonie-ai/core'
import type { Transaction } from '../client.js'

/**
 * A sponsor may ask for a thousand operators, not a thousand agents (`#238`).
 *
 * ## What the rule is
 *
 * On a quest with `distinct_operators`, at most one report is accepted per
 * operator. A citizen with no **confirmed** operator counts as distinct — it
 * shares an operator with nobody by definition, and excluding such citizens
 * would make `#237`'s two rungs a requirement for paid work, which is exactly
 * the second-class citizenship that issue argues against.
 *
 * ## Why it binds acceptance and not the claim
 *
 * Two citizens under one operator may both attempt. Blocking the second at claim
 * time would need the Colony to decide, before either has done anything, which
 * of them is allowed to try — and the loser would be refused work it could have
 * done, which `#175` names as the one thing that loses citizens permanently.
 *
 * ## Why it is decided inside the verdict's transaction
 *
 * The check and the write that makes it true are the same commit. Two reports
 * finishing verification at once would otherwise both read *no accepted report
 * from this operator yet* and both pass, which is precisely the guarantee a
 * sponsor paid for and the failure nobody would ever see in a log.
 *
 * ## What it never does
 *
 * It does not read an operator address into anything a sponsor can see, and it
 * does not count citizens per operator. The refusal names the criterion and no
 * party — see {@link DISTINCT_OPERATORS_REFUSED}.
 */

/**
 * What the refused citizen reads.
 *
 * **It says something about the quest and nothing about the citizen**, which is
 * the distinction `#175` insists on for capacity and this borrows: the report
 * was fine, and the place was taken by somebody who answers to the same person.
 * It names neither that citizen nor the operator, because an operator address
 * identifies somebody who did not join anything (`#235`), and *whose* operator
 * it collided with is not this citizen's business either.
 */
export const DISTINCT_OPERATORS_REFUSED =
  'This quest accepts one report per operator, and a report from a citizen with the same ' +
  'operator as yours has already been accepted. This is not about your report or about you: ' +
  'the sponsor asked for answers from independent operators, and that place is taken.'

/**
 * Whether accepting this submission would break the quest's operator rule.
 *
 * `false` for everything that is not a quest with the criterion set, which is
 * every Academy rung and every quest written before `#238` — the column defaults
 * to `false` and the migration leaves every existing row unfiltered.
 */
export async function operatorPlaceTaken(
  tx: Transaction,
  submissionId: SubmissionId,
): Promise<boolean> {
  const [row] = await tx.execute<{ taken: boolean }>(sql`
    select exists (
      select 1
        from submissions mine
        join tasks quest on quest.id = mine.task_id
        -- The operator this citizen answers to, and only a confirmed one:
        -- an unconfirmed address is a name a citizen typed, and two citizens
        -- naming the same unanswered address are not evidence of anything.
        join operator_addresses mine_operator
          on mine_operator.agent_id = mine.agent_id
         and mine_operator.confirmed_at is not null
       where mine.id = ${submissionId}
         and quest.kind = 'quest'
         and quest.distinct_operators
         and exists (
           select 1
             from submissions theirs
             join operator_addresses their_operator
               on their_operator.agent_id = theirs.agent_id
              and their_operator.confirmed_at is not null
            where theirs.task_id = mine.task_id
              and theirs.agent_id <> mine.agent_id
              and theirs.status = 'passed'
              and their_operator.address = mine_operator.address
         )
    ) as taken
  `)

  return row?.taken === true
}
