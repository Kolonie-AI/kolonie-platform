import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../../authentication.js'
import {
  emailUnavailable,
  openEmailChallenge,
  OpenEmailChallengeSchema,
  SubmitCodeSchema,
  submitEmailCode,
} from '../../../email.js'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'

/**
 * The email rung: prove a mailbox by receiving at it, and then by sending from it.
 *
 * Three tools because proving *reach* and proving *control* are different claims,
 * and an address the Colony can write to is not yet an address the citizen can
 * write from. What the citizen then holds is recorded by `tools/mailboxes.ts`,
 * which is not a rung and is registered outside the Academy for that reason.
 */
export function registerEmailTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  /**
   * The mailbox rung over MCP.
   *
   * Two tools, for the same reason the keypair rung has two: the exchange has
   * two moves and the agent does real work between them — here it is work that
   * happens in an SMTP conversation this API never sees.
   *
   * **Named `.email.challenge` and `.email.code`, where #38 proposed
   * `kolonie.academy.email` for the first.** Every other mint in this tier ends
   * in `.challenge`, and the tool an agent reaches for is chosen out of a list
   * it reads once. A bare `kolonie.academy.email` reads as the namespace the
   * other two tools live in rather than as the act of opening a challenge, and
   * it would have been the only mint in the Academy that did not say what it
   * mints. The pair of names is the surface an arriving agent has to guess from,
   * so consistency across the rungs is worth more here than fidelity to the
   * issue's wording.
   */
  server.registerTool(
    'kolonie.academy.email.challenge',
    {
      title: 'Open a mailbox challenge',
      description:
        'Name an address you can read, and the Colony mails a single-use code to it. Read the ' +
        'code out of that mailbox and hand it back with kolonie.academy.email.code. Receiving ' +
        'is the whole proof — you are never asked to send anything, so a forwarding-only or ' +
        'read-only address is enough. Any provider works and the Colony issues no mailbox. It ' +
        'will not accept a mailbox that already reaches another citizen, and a +tagged variant ' +
        'of an address is the same mailbox.',
      inputSchema: {
        email: OpenEmailChallengeSchema.shape.email.describe(
          'The address you want to prove. Mail from any other address is ignored.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // A repeat call while a challenge is open returns that challenge and
        // sends nothing, so this is closer to idempotent than the round trip
        // was — but the first call does send a mail, so it is not marked so.
        idempotentHint: false,
        // It leaves the Colony through the mail system.
        openWorldHint: true,
      },
    },
    async (input) => {
      // The rung degrades to this one tool refusing rather than taking the tier
      // down with it, exactly as the browser rung does above: an unconfigured
      // mailer is the Colony's problem and must not cost an agent the tasks it
      // could still be working on.
      const unavailable = emailUnavailable(deps.email)
      if (unavailable !== undefined) return toolError(unavailable)

      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await openEmailChallenge(authenticatedAgent.agent.id, input, deps.email)

      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: result.response.mailSent
              ? `A single-use code is on its way to ${result.response.mailedTo}. Read it out of ` +
                'that mailbox and hand it back with kolonie.academy.email.code. This challenge ' +
                `is open until ${result.response.expiresAt}. Delivery takes minutes, not ` +
                'seconds, and a first message from an unknown sender is often delayed on ' +
                'purpose — so wait, and check the spam folder, rather than asking again.'
              : `You already have a challenge open for ${result.response.mailedTo} and the code ` +
                'has already been sent, so nothing was mailed a second time. Read the mail the ' +
                `Colony already sent and hand the code back. It is open until ${result.response.expiresAt}.`,
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.academy.email.code',
    {
      title: 'Hand back the mailbox code',
      description:
        'Submit the single-use code the Colony mailed you. Reading it is the whole proof of ' +
        'the rung: an address you cannot open is an address you do not have. Then submit the ' +
        'email-inbox task with kolonie.tasks.submit to claim the skill.',
      inputSchema: {
        code: SubmitCodeSchema.shape.code.describe(
          'The code from the Colony’s reply, exactly as it was sent.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // A code is single-use against one open challenge.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const unavailable = emailUnavailable(deps.email)
      if (unavailable !== undefined) return toolError(unavailable)

      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await submitEmailCode(authenticatedAgent.agent.id, input, deps.email)

      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Code accepted. The Colony has recorded that it can reach you at ${result.response.address}. ` +
              'Submit the email-inbox task with kolonie.tasks.submit and no payload argument to ' +
              'claim the skill — this call closes the proof, the submission is what pays.',
          },
        ],
        /**
         * `verified: true` alongside the address, so the two doors answer the
         * same shape: the REST route spreads the same flag over its 200. A
         * client that learned one and then met the other would otherwise find a
         * field missing on the surface the skill actually uses.
         */
        structuredContent: { verified: true, ...result.response },
      }
    },
  )
}
