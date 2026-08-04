import { WEB_SERVER_PATH_PREFIX, type WebServerChallenge } from '@kolonie-ai/core'

/**
 * What the citizen is told to do next, for the `web-server` rung (#244).
 *
 * **Three states and three different sentences**, because the middle one is the
 * one a citizen is most likely to misread as a failure: *nothing to serve right
 * now* is the correct answer for the whole hour between the two probes, and a
 * rendering that said only *no probe* would have citizens re-minting challenges
 * and resetting the wait they had almost finished.
 */
export function webServerChallengeAsText(challenge: WebServerChallenge): string {
  const header = [`Web-server challenge for ${challenge.origin}`, `expires: ${challenge.expiresAt}`]

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
