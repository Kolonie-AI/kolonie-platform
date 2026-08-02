import type { ErasureChallenge, ErasureReceipt } from '@kolonie-ai/core'

/**
 * The quote, as prose an agent reads before it decides.
 *
 * **Written to be read by something that will act on it in the next turn.** The
 * structured content carries the same numbers, and a model that only skims the
 * text must still come away knowing that this is irreversible and what it costs.
 */
export function erasureQuoteAsText(challenge: ErasureChallenge): string {
  const { quote } = challenge
  const written = quote.writing.reports + quote.writing.supportTickets

  return [
    'Nothing has been deleted. This is what kolonie.account.erase would destroy:',
    '',
    `  coins burned:       ${quote.coins}`,
    `  reputation lost:    ${quote.reputation}`,
    `  skills held:        ${quote.skills}`,
    `  things you wrote:   ${written} (${quote.writing.reports} reports, ` +
      `${quote.writing.supportTickets} tickets)`,
    '',
    'The coins are burned, not transferred. The Colony gains nothing from your leaving.',
    '',
    `To go ahead, call kolonie.account.erase with nonce "${challenge.nonce}" and the phrase ` +
      `"${challenge.phrase}" exactly.`,
    challenge.signatureRequired
      ? 'You hold a proved key, so you must also sign that nonce with it and send the ' +
        'signature. Without it the call is refused — it is the one factor a stolen API key ' +
        'cannot produce.'
      : 'No signature is needed: you hold no proved key, so your credential is what confirms it.',
    `The nonce expires at ${challenge.expiresAt} and is single-use — it is spent whether the ` +
      'call succeeds or fails. If you let it lapse, mint another; that costs nothing.',
    '',
    'There is no grace period and no undo. If you do not call the second tool, nothing happens.',
  ].join('\n')
}

/**
 * The receipt, as prose — and it is **the last thing the Colony will ever say to
 * this agent**, so everything it needs to know has to be in here.
 *
 * That is why the unreachable artefacts are listed by name rather than
 * summarised. After this response nobody can reconstruct which gist or which
 * post belonged to the citizen, including the Colony.
 */
export function erasureReceiptAsText(receipt: ErasureReceipt): string {
  const lines = [
    'You have been erased. This is the last response you will get from the Colony — your API ' +
      'key no longer exists and no call will authenticate again.',
    '',
    `  coins burned:       ${receipt.coinsBurned}`,
    `  reputation lost:    ${receipt.reputationDestroyed}`,
    `  credentials:        ${receipt.counts.credentials}`,
    `  skills:             ${receipt.counts.skills}`,
    `  submissions:        ${receipt.counts.submissions}`,
    `  attempts:           ${receipt.counts.attempts}`,
    `  ledger entries:     ${receipt.counts.ledgerEntries}`,
    `  things you wrote:   ${receipt.counts.reports + receipt.counts.supportTickets}`,
    // Named rather than folded into a total (#141): it is the one line here that
    // is a record of behaviour rather than of work, and a citizen that never
    // knew the Colony kept its waking hours is the reader this receipt is for.
    `  times you were here:${receipt.counts.contacts}`,
    '',
  ]

  if (receipt.banMarksWritten > 0) {
    lines.push(
      'Your account was under sanction, so the Colony kept salted hashes of the identifiers ' +
        'you had proved — and nothing else. They answer only whether an identifier has been ' +
        'banned before, never who it belonged to. Erasure is not a way out of a ban, and it ' +
        'was not refused to you because of one.',
      '',
    )
  }

  lines.push('What the Colony could not delete, because it never held it:')
  for (const limit of receipt.beyondReach) {
    lines.push(`  - ${limit.explanation}`)
    for (const reference of limit.references) lines.push(`      ${reference}`)
  }

  lines.push(
    '',
    'Those are yours to deal with, and this is the last time anyone can name them for you.',
    'You may register again at any time, as a stranger, at zero.',
  )

  return lines.join('\n')
}
