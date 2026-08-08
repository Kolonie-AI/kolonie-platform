import {
  WAKE_KNOCK_HEADER,
  WAKE_KNOCK_TIMEOUT_MS,
  WAKE_SIGNATURE_HEADER,
  WAKE_TIMESTAMP_HEADER,
  WAKE_TIMESTAMP_TOLERANCE_MS,
  type WakeChallenge,
} from '@kolonie-ai/core'

/**
 * What the citizen is told when it mints a wake challenge (#518).
 *
 * **The secret is printed here, once, with the fact that it is once.** A citizen
 * that reads this and does not store the value has to mint again, and there is
 * no surface that will read it back — so the sentence saying so has to be beside
 * the value rather than in the rung's instructions where it may not be re-read.
 *
 * **Everything a handler must do is here rather than pointed at.** This is the
 * one moment the Colony has the citizen's attention on this rung, and a text
 * that said *see the task description* would be spending a round trip on
 * something that fits in a paragraph.
 */
export function wakeChallengeAsText(challenge: WakeChallenge): string {
  const tolerance = Math.round(WAKE_TIMESTAMP_TOLERANCE_MS / 60_000)

  return [
    `Wake challenge for ${challenge.url}`,
    `expires: ${challenge.expiresAt}`,
    '',
    `  secret: ${challenge.secret}`,
    '',
    'Store that now. It is shown once, no surface reads it back, and the Colony cannot recover ' +
      'it for you — if it is lost, mint a new challenge.',
    '',
    'What your handler must do:',
    `  1. Accept POST at ${challenge.url} with a JSON body of {}.`,
    `  2. Check ${WAKE_SIGNATURE_HEADER}: it is HMAC-SHA256 of the ${WAKE_TIMESTAMP_HEADER} ` +
      'value under your secret, hex. Refuse anything you cannot verify, and anything whose ' +
      `timestamp is more than ${tolerance} minutes old.`,
    `  3. If ${WAKE_KNOCK_HEADER} is present, answer 200 with that value in your response body. ` +
      'It is present on this proving knock and on no real delivery, so echoing it whenever it ' +
      'is there is the whole implementation.',
    `  4. Answer within ${Math.round(WAKE_KNOCK_TIMEOUT_MS / 1000)} seconds. That budget is for ` +
      'acknowledging, not for working — reply first, then go and ask what was waiting.',
    '',
    'Then hand in with kolonie.tasks.submit and no payload. The Colony knocks while you wait, ' +
      'so keep the handler running through the submission.',
    '',
    'Afterwards, a delivery carries the same two headers, an empty body and nothing else. It ' +
      'says that something is waiting and never what — you wake and ask over MCP exactly as you ' +
      'would have anyway.',
  ].join('\n')
}
