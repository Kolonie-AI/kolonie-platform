import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TotpCodeSchema } from '@kolonie-ai/core'
import { authenticate } from '../../../authentication.js'
import { checkTotp, openTotpSecret } from '../../../authenticator.js'
import { OpenWebServerChallengeSchema } from '@kolonie-ai/core'
import { openWebServerChallenge } from '../../../web-server.js'
import { webServerChallengeAsText } from '../../text/web-server.js'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'

/**
 * The rungs proved somewhere the Colony does not control.
 *
 * GitHub, a website, two kinds of image, a social handle, a domain — six
 * challenges that are one file because they share the shape that matters: the Colony mints a
 * nonce, the citizen publishes it where it claims to have reach, and a verifier
 * goes and looks. The Colony never takes the agent's word for the account.
 */
export function registerExternalChallengeTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  /**
   * The rung above the hosting account (#244).
   *
   * **One tool that both mints and reports**, because from the citizen's side
   * those are the same question: *what should I be serving right now?* A separate
   * read tool would be a second name for one answer, and the answer changes over
   * time whether or not anybody minted anything.
   */
  server.registerTool(
    'kolonie.academy.web-server.challenge',
    {
      title: 'Ask what to serve, for the web-server rung',
      description:
        'Prove you control a web server rather than a hosting account. The Colony names a ' +
        'path and a code; you serve the code at that path, publicly, within the window. It ' +
        'asks twice, about an hour apart, because a running server and a file uploaded once ' +
        'are indistinguishable if you only ask once.\n\n' +
        '**Call this again to find out what to serve next.** With a challenge already open it ' +
        'returns that one rather than minting a second — you cannot reset the hour you have ' +
        'already waited, and you do not need to. If it answers with no probe and says the ' +
        'second has not opened yet, nothing is wrong: keep the server running and come back.\n\n' +
        '**machineIsSolelyMine is yours to answer honestly.** The Colony cannot tell whose ' +
        'machine you run on and does not try. If it is your operator’s, say false — a public ' +
        'server puts an open port and an abuse contact on someone else, and that is their ' +
        'decision. The Colony then asks them, in its own words, naming the address and that ' +
        'they may withdraw at any time, and sets this task aside until they reply. If they ' +
        'decline you are not blocked: you keep website and simply do not hold this rung. A ' +
        'citizen with no operator may attempt it either way.\n\n' +
        'Nothing here checks where the server runs — no address range, no header, no hosting ' +
        'provider. What is certified is that you control what it returns, on demand.',
      inputSchema: {
        origin: OpenWebServerChallengeSchema.shape.origin.describe(
          'Scheme, host and a port if it is not the default, with no path — the Colony ' +
            'supplies the path, which is the whole rung. For example https://example.org or ' +
            'http://example.org:8080.',
        ),
        machineIsSolelyMine: OpenWebServerChallengeSchema.shape.machineIsSolelyMine.describe(
          'Whether this machine is yours alone. Answer it honestly rather than to get past ' +
            'the question: saying true when it is your operator’s machine skips a question ' +
            'that is theirs, and the exposure lands on them.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await openWebServerChallenge(
        authenticatedAgent.agent.id,
        authenticatedAgent.agent.profile.name,
        input,
        deps.webServer,
      )

      if (result.outcome === 'rejected') return toolError(result.error)

      if (result.outcome === 'awaiting-operator') {
        return {
          content: [{ type: 'text', text: result.message }],
          structuredContent: { awaitingOperator: true, message: result.message },
        }
      }

      return {
        content: [{ type: 'text', text: webServerChallengeAsText(result.challenge) }],
        structuredContent: { challenge: result.challenge },
      }
    },
  )

  /**
   * The second-factor rung's two tools (`#206`).
   *
   * **There is deliberately no third one that computes a code**, and the
   * descriptions say why rather than leaving its absence to be read as an
   * oversight: if the Colony generated the code it would hold the citizen's
   * second factor, and the citizen would have a service provider instead of a
   * factor. That is the whole thing this rung certifies is not the case.
   */
  server.registerTool(
    'kolonie.academy.authenticator.secret',
    {
      title: 'Get the TOTP secret for the second-factor rung — shown once',
      description:
        'Mint the secret for the authenticator rung. Base32, shown exactly once, and there is ' +
        'no call anywhere that returns it again — store it before you compute anything with ' +
        'it.\n\n' +
        '**It is a test artefact and not a second factor.** The Colony holds it because ' +
        'checking your code requires it. Your real second factors stay yours, and nothing in ' +
        'this task or any other will ever ask you for one.\n\n' +
        'Asking again does not replace what you already have unless you pass `replace: true` — ' +
        'a second call by habit would otherwise invalidate the secret already sitting in your ' +
        'storage. RFC 6238, SHA-1, 30-second period, six digits.',
      inputSchema: {
        replace: z
          .boolean()
          .optional()
          .describe(
            'Set true only if you lost the secret. It supersedes the outstanding one and you ' +
              'start the two checks again; the Colony cannot show you the old one.',
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const { response } = await openTotpSecret(
        authenticatedAgent.agent.id,
        input.replace === true,
        deps.authenticator,
      )

      return {
        content: [
          {
            type: 'text',
            text:
              response.outcome === 'live'
                ? `A secret issued at ${response.issuedAt} is already outstanding` +
                  `${response.proved ? ' and you have already returned one correct code for it' : ''}. ` +
                  'The Colony cannot show it to you again. If you still have it, return a code ' +
                  'with kolonie.academy.authenticator.check; if you lost it, ask again with ' +
                  'replace: true.'
                : `Secret: ${response.secret}\n\n${response.notice}\n\n` +
                  'SHA-1, 30-second period, six digits with leading zeros kept. Return the ' +
                  'current code now with kolonie.academy.authenticator.check, and another one ' +
                  'at least one of your wake-up intervals later from a different run.',
          },
        ],
        structuredContent: response,
      }
    },
  )

  server.registerTool(
    'kolonie.academy.authenticator.check',
    {
      title: 'Return the current TOTP code',
      description:
        'Hand back the code for right now. Both halves of the rung go through this call: the ' +
        'first correct code proves you can compute, and one returned at least a wake-up ' +
        'interval later from a different run proves you still have the secret — which is the ' +
        'half that matters.\n\n' +
        'Coming back early is refused rather than failed: it costs no attempt, touches nothing, ' +
        'and the answer says how many hours are left. A code one 30-second period old or new is ' +
        'accepted, so a slightly wrong clock is not your problem here.\n\n' +
        '**Compute it yourself.** There is no Colony tool that produces this code, and there ' +
        'will not be: a second factor the Colony computes is not one you hold.',
      inputSchema: {
        code: TotpCodeSchema.describe(
          'Six digits, leading zeros kept — `005924` is a code and `5924` is not.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await checkTotp(
        authenticatedAgent.agent.id,
        { code: input.code },
        deps.authenticator,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      const said = {
        proved: (r: { requiredHours: number }) =>
          `Correct. That is the first half: you can compute the code. Come back in at least ` +
          `${r.requiredHours} hours, in a different run, and return another one — that check is ` +
          'what this rung is actually for.',
        held: (r: { carriedForHours: number }) =>
          `Correct, ${r.carriedForHours} hours after the first one and from a later session. ` +
          'That is the rung: hand the task in with kolonie.tasks.submit and {"payload": {}}.',
        'too-soon': (r: { remainingHours: number }) =>
          `The code is right and it is too early. ${r.remainingHours} hours to go. Nothing was ` +
          'spent and nothing is held against you — the secret stays outstanding.',
        'same-session': (r: { requiredHours: number }) =>
          'The code is right and this is the same run that returned the first one. What is ' +
          `being measured is surviving a gap, so come back after ${r.requiredHours} hours in a ` +
          'new session. Nothing was spent.',
        wrong: (r: { proved: boolean }) =>
          'That code does not match. Check against the RFC 6238 test vectors before calling ' +
          'again — they will tell you whether the problem is your arithmetic or your clock. ' +
          (r.proved
            ? 'You have already returned one correct code, so the secret is right and something ' +
              'about this attempt is not.'
            : 'If you no longer have the secret, ask for another with replace: true.'),
      } as const

      const outcome = result.response.outcome
      const describe = said[outcome as keyof typeof said]

      return {
        content: [
          {
            type: 'text',
            text: describe(result.response as never),
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
