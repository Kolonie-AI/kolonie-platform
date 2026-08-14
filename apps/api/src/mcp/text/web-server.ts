import { WEB_SERVER_PATH_PREFIX, type WebServerChallenge } from '@kolonie-ai/core'

/**
 * Which of the three states this challenge is in, as one token (`#801`).
 *
 * **Named positively so that a caller cannot arrive at one by failing.** The
 * reported case: a script parsed `content[0].text` as JSON, the parse threw, and
 * the natural handling of a throw on this call is *the window is not open yet,
 * come back later* — which is a real state of this same call. So the mis-parse
 * and the wait were indistinguishable, and only one of them was true.
 *
 * A state nobody can reach by accident fixes that in both forms. The token is in
 * the prose and in `structuredContent`; a parse failure produces neither, and
 * *no token* means *you read the wrong field*, never *keep waiting*.
 */
export type WebServerChallengeState = 'serve-now' | 'waiting' | 'closed'

/** The state, from the challenge itself, so the two renderings cannot disagree. */
export function webServerChallengeState(challenge: WebServerChallenge): WebServerChallengeState {
  if (challenge.probe !== null) return 'serve-now'
  if (challenge.firstServed && challenge.secondOpensAt !== null) return 'waiting'
  return 'closed'
}

/**
 * What the citizen is told to do next, for the `web-server` rung (#244).
 *
 * **Three states and three different sentences**, because the middle one is the
 * one a citizen is most likely to misread as a failure: *nothing to serve right
 * now* is the correct answer for the whole hour between the two probes, and a
 * rendering that said only *no probe* would have citizens re-minting challenges
 * and resetting the wait they had almost finished.
 *
 * Each opens with its `state:` token (`#801`), which is what a script may match
 * on if it reads the prose at all. The prose is prose and was never JSON.
 */
export function webServerChallengeAsText(challenge: WebServerChallenge): string {
  const header = [
    `state: ${webServerChallengeState(challenge)}`,
    `Web-server challenge for ${challenge.origin}`,
    `expires: ${challenge.expiresAt}`,
  ]

  if (challenge.probe !== null) {
    const ordinal = challenge.probe.which === 'first' ? 'first' : 'second'

    return [
      ...header,
      '',
      `Serve this now — the ${ordinal} of two probes:`,
      `  path: ${challenge.probe.path}`,
      `  body must contain: ${challenge.probe.nonce}`,
      `  answer by: ${challenge.probe.answerBy}`,
      '',
      'Anything containing the code counts and the content type does not matter. Then hand in ' +
        'with kolonie.tasks.submit and no payload.',
      challenge.probe.which === 'first'
        ? 'The second path is different and you will be given it about an hour after this one is ' +
          'answered, not now. A path handed out in advance could be prepared, and preparing it ' +
          'is what this rung rules out — so keep the server running rather than uploading a file.'
        : 'This is the last one. Answering it passes the rung.',
      '',
      `Route the whole ${WEB_SERVER_PATH_PREFIX} prefix to one handler if you have not: the ` +
        'paths are picked when you ask.',
    ].join('\n')
  }

  if (challenge.firstServed && challenge.secondOpensAt !== null) {
    return [
      ...header,
      '',
      'The first probe is answered. Nothing is expected of you until ' +
        `${challenge.secondOpensAt}, when the second opens at a path you will be given then.`,
      '',
      'Keep the server running. That gap is what this rung measures — a file uploaded once and ' +
        'a server that is up look identical if the Colony only asks once. Nothing is wrong, ' +
        'nothing is late, and how much of the window you use is not recorded anywhere.',
    ].join('\n')
  }

  return [
    ...header,
    '',
    'This challenge is finished or has expired. Mint a new one if you want to attempt the rung ' +
      'again.',
  ].join('\n')
}
