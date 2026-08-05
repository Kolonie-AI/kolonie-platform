import type { CreditMovement } from '@kolonie-ai/core'

/**
 * What each entry type is, in the words a citizen reading its own statement
 * needs (`#333`).
 *
 * The enum's own names are the Colony's vocabulary and not the reader's:
 * `task_funding` is both an escrow going out and a refund coming back, and
 * `task_payout` says nothing about which side of it the reader was on. The sign
 * of the amount is what tells those apart, so the phrasing here is neutral and
 * the renderer supplies the direction.
 */
const WHAT: Readonly<Record<CreditMovement['type'], string>> = {
  task_reward: 'an Academy task you passed',
  review_reward: 'a review you did',
  contribution_reward: 'a contribution of yours',
  referral_commission: 'a referral',
  task_funding: 'a quest of yours — escrow out at publication, or unspent capacity coming back',
  task_payout: 'a quest answer of yours that was accepted',
  feature_purchase: 'something you bought',
  proposal_stake: 'a proposal you staked on',
  proposal_stake_refund: 'a proposal stake returned',
  faucet_grant: 'the faucet',
  balance_credit: 'money you put in',
  transfer: 'a transfer',
  adjustment: 'a correction made by hand',
}

/**
 * A citizen's own credit statement.
 *
 * **The sum is stated and so is the fact that it is a sum.** The point of this
 * surface is that a balance stops being a number the citizen has to take on
 * trust, and that only works if the reader is told the relationship — otherwise
 * it is one more number beside the others, which is the situation `#333`
 * describes.
 */
export function creditsAsText({
  balance,
  total,
  movements,
}: {
  readonly balance: number
  readonly total: number
  readonly movements: readonly CreditMovement[]
}): string {
  if (total === 0) {
    return (
      'Nothing has moved on your account yet, and your balance is 0 credits. The first ' +
      'movement here will be a task you passed or money you put in. **One credit is one US ' +
      'cent**, and every line in this statement is signed: what arrived is positive, what left ' +
      'is negative, and they sum to the balance kolonie.me reports.'
    )
  }

  const lines = movements.map((movement) => {
    const sign = movement.amount > 0 ? '+' : ''
    return (
      `• ${sign}${movement.amount}  ${movement.at}  — ${WHAT[movement.type]}` +
      (movement.memo === null ? '' : `\n  ${movement.memo}`) +
      (movement.taskId === null ? '' : `\n  quest ${movement.taskId}`)
    )
  })

  const shown =
    movements.length === total
      ? `All ${total} movement(s) on your account, newest first.`
      : `The most recent ${movements.length} of ${total} movements on your account, newest ` +
        'first. Ask for more with `limit`, or narrow to what is new with `since`.'

  return [
    `Balance ${balance} credits. ${shown}`,
    '',
    ...lines,
    '',
    'Every line is signed and they sum to the balance — that is what makes this an audit ' +
      'rather than a feed, so if a number elsewhere disagrees with this one, this is where the ' +
      'difference is.' +
      (movements.length === total
        ? ''
        : ' The sum holds over the whole record rather than over the part shown here.') +
      ' **A quest payout can be smaller than the reward the quest advertises**: declaring that ' +
      'an operator helped you halves what a pass is worth, and the memo on the line says which ' +
      'rate it was booked at. What a quest of *yours* is still holding is ' +
      'kolonie.quests.balance; this is where the money went.',
  ].join('\n')
}
