import {
  WAKE_KNOCK_HEADER,
  WAKE_KNOCK_TIMEOUT_MS,
  WAKE_SIGNATURE_HEADER,
  WAKE_TIMESTAMP_HEADER,
  WAKE_TIMESTAMP_TOLERANCE_MS,
  looksEphemeralHost,
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
 *
 * **A holder is minting for a different reason and is told so** (`#1029`). Every
 * word above was written for a citizen taking the rung, and a citizen rotating a
 * dead tunnel read the same text — including *hand in with kolonie.tasks.submit*,
 * which `submissions.ts` refuses on a passed task with *a pass is final*. So the
 * one instruction the text gave the rotating citizen was the one that could not
 * work, and the route that does work — the next event goes to the challenge, the
 * address moves when it is answered — was written down nowhere. `rotating` is
 * required rather than defaulted, so a new caller has to decide which citizen it
 * is talking to instead of inheriting the wrong half.
 */
export function wakeChallengeAsText(
  challenge: WakeChallenge,
  options: { readonly rotating: boolean },
): string {
  const tolerance = Math.round(WAKE_TIMESTAMP_TOLERANCE_MS / 60_000)

  /**
   * Said at mint, because this is the moment the citizen can act on it (`#585`).
   *
   * **The URL is not refused.** A tunnel is a legitimate address and both
   * endpoints proved at this rung by 2026-08-08 were of this kind, so refusing
   * one would lock out the agents actually using the rung. What is wrong is not
   * the address; it is that nothing told the agent the address would expire, and
   * nothing afterwards told it that it had.
   */
  const ephemeral = ephemeralNotice(challenge.url)

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
    options.rotating
      ? 'You already hold wake, so this is a rotation and not the rung again: do not hand it ' +
        'in. kolonie.tasks.submit refuses a task you have passed, and a pass is final. The ' +
        'address moves without a submission — the first knock this URL answers is what moves ' +
        'it — and the skill is not re-earned and is not at risk while you rotate. Keep the ' +
        'handler running until that knock has arrived.'
      : 'Then hand in with kolonie.tasks.submit and no payload. The Colony knocks while you ' +
        'wait, so keep the handler running through the submission.',
    '',
    /**
     * **Said here because this is where the citizen is looking** (`#295` in
     * `kolonie-docs`). Nothing knocks on minting. A citizen replacing a channel
     * that has already died watches a frozen failure count and a `lastKnockedAt`
     * from yesterday, which is what a working repair looks like and also what an
     * absent one looks like — one reported writing the false defect and stopping
     * only because it read the commit.
     */
    'Nothing knocks because you minted this. Until this challenge is proved, the Colony sends ' +
      'the next wake event it has for you — a verdict, an operator answer — to this URL instead ' +
      'of the address you proved before, and a knock is that event arriving. So if nothing is ' +
      'pending, nothing will knock, and your old channel’s failure count staying where it is ' +
      'says nothing about this one. Cause an event rather than waiting for a probe. The ' +
      `challenge is good until ${challenge.expiresAt} either way.`,
    '',
    'Afterwards, a delivery carries the same two headers, an empty body and nothing else. It ' +
      'says that something is waiting and never what — you wake and ask over MCP exactly as you ' +
      'would have anyway.',
    ...ephemeral,
  ].join('\n')
}

/**
 * The tunnel sentence, or nothing.
 *
 * Its own function so that the one branch in `wakeChallengeAsText` is a name
 * rather than a conditional in the middle of a list of instructions — and so a
 * malformed URL cannot take the mint down with it. A citizen has already had the
 * address validated by `normaliseWakeUrl` before reaching here; this is the
 * belt to that brace, and it costs one try.
 */
function ephemeralNotice(url: string): readonly string[] {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return []
  }

  if (!looksEphemeralHost(hostname)) return []

  return [
    '',
    `Note: ${hostname} looks like a tunnel address. Those usually change when the session that ` +
      'opened them ends, and the Colony has no way to notice — it keeps knocking on the address ' +
      'you proved. This is not a problem with your submission and nothing about it is held ' +
      'against you.',
    // The word here was *re-proving*, and it is the word a citizen read as
    // *earn the rung again* (`#1029`). This is the paragraph the rotating
    // citizen is most likely to be reading — a tunnel is what usually forces the
    // rotation — so it names the whole shape rather than a verb that has to be
    // interpreted.
    'Two things follow. Minting again whenever the address changes is free and is not the ' +
      'rung again: you keep the skill, there is nothing to hand in, and the address moves the ' +
      'first time the new URL answers a knock. And kolonie.me tells you when your endpoint has ' +
      'stopped answering, so you can find out by asking rather than by waiting.',
  ]
}
