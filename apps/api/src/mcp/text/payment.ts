import { solFromLamports } from '@kolonie-ai/core'
import type { SponsorPaymentView } from '../../payments.js'

/**
 * What became of one transfer, as the sponsor that sent it reads it (`#760`).
 *
 * **Every branch says what to do next**, because the three outcomes are read by
 * an agent deciding whether to send more money. *Not seen* has to say how long
 * seeing takes before it means anything is wrong, or a sponsor asking thirty
 * seconds after paying will conclude the payment is lost and pay twice.
 *
 * **Held names the address and not the machinery.** The issue's own wording is
 * that the sponsor *"needs to know its money is held; it does not need the
 * quarantine machinery"* — so what is printed is the sending address and the
 * two routes out of it, rather than the enum, the resolution note, or anything
 * about how a maintainer settles one.
 */
export function paymentAsText(view: SponsorPaymentView): string {
  if (view.outcome === 'unseen') {
    return [
      `The Colony has no record of ${view.signature}.`,
      '',
      'That is the ordinary answer for a transfer that is minutes old: only a finalized ' +
        'transaction is recognised, which the cluster reaches about thirteen seconds after it ' +
        'lands, and the pass that re-reads the wallet runs hourly. Ask again before you ' +
        'conclude anything.',
      '',
      'If it is hours old and still unknown, check that it went to the address the invoice ' +
        'names — a transfer to any other address is not a payment to the Colony and nothing ' +
        'here will ever see it.',
    ].join('\n')
  }

  if (view.outcome === 'held') {
    return [
      `${solFromLamports(view.lamports)} SOL arrived on ${view.observedAt} and is being held, ` +
        'not credited.',
      '',
      `It came from ${view.sender}, and that is the whole of the problem: no citizen has ` +
        'proved it controls that address, so the Colony can see the money and cannot see who ' +
        'sent it. The commonest cause is an exchange withdrawal, which arrives from the ' +
        'exchange’s own wallet rather than from yours.',
      '',
      'Two ways on. Prove that address at the solana-wallet rung, which makes it yours for ' +
        'every payment after this one; or pay the invoice again from an address you have ' +
        'already proved. Held money is not credited retroactively by either.',
      '',
      view.settled
        ? 'A maintainer has already dealt with this one. Open a ticket with kolonie.support.open ' +
          'if you were not told what was decided.'
        : 'Nobody has dealt with it yet. kolonie.support.open is how you ask about it, and this ' +
          'signature is what to quote.',
    ].join('\n')
  }

  return [
    `${solFromLamports(view.lamports)} SOL arrived on ${view.observedAt} and was credited to ` +
      `you on ${view.attributedAt}.`,
    '',
    // What it was credited *to* is the quest's own row rather than this one, and
    // saying so is cheaper than a join that would be right only while a sponsor
    // has one quest waiting.
    'What it paid for is on the quest: kolonie.quests.read shows what remains outstanding, or ' +
      'shows no invoice at all once the quest is live.',
  ].join('\n')
}
