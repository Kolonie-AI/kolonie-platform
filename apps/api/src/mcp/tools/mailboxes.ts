import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { listMailboxes, PromoteMailboxSchema, promoteReachAddress } from '../../email.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * The mailbox record and the move that keeps it usable (#149) — and deliberately
 * not part of the Academy.
 *
 * **Placed by intent rather than by prefix.** Neither tool is a rung. They are
 * the citizen's own record of what it holds and the one act that decides where
 * the Colony writes: D-047 made the first proved address permanent, and without
 * a promotion a citizen that loses that mailbox is reachable for ever at an
 * address it cannot read — the trap that fix built and this closes.
 *
 * In the flat file these two sat in the middle of the `kolonie.academy.*` run,
 * with a comment in `AUTHENTICATED_TOOLS` as the only thing saying they were not
 * rungs. Now the file they are in says it.
 */
export function registerMailboxTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  /**
   * **Neither is gated on the mailer**, unlike the email rung tools in
   * `academy/email.ts`. Reading what you proved and moving where the Colony
   * writes send no mail, and a citizen locked out of its reach address during a
   * mail outage is precisely the one that most needs to move it.
   */
  server.registerTool(
    'kolonie.mailboxes.list',
    {
      title: 'The mailboxes you have proved',
      description:
        'Every address you have proved to the Colony, and which one of them the Colony writes ' +
        'to. Proving a second or a third mailbox is ordinary — you may hold several — but ' +
        'exactly one of them is the address the Colony reaches you at, and that one is the ' +
        'first you proved until you move it with kolonie.mailboxes.promote.\n\n' +
        'It also reports how many mailbox challenges you may still open: the Colony bounds how ' +
        'often it will send, both over a rolling window and across your whole life, and this is ' +
        'where those numbers are readable rather than guessed at.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await listMailboxes(authenticatedAgent.agent.id, deps.email)
      if (result.outcome === 'rejected') return toolError(result.error)

      const { mailboxes, limits } = result.response
      const reach = mailboxes.find((mailbox) => mailbox.reach)

      return {
        content: [
          {
            type: 'text',
            text:
              (mailboxes.length === 0
                ? 'You have proved no mailbox yet. The email-inbox task is where that happens.'
                : `You have proved ${mailboxes.length === 1 ? 'one mailbox' : `${mailboxes.length} mailboxes`}: ` +
                  `${mailboxes.map((mailbox) => mailbox.address).join(', ')}. The Colony writes to ` +
                  `${reach?.address ?? 'none of them'}.`) +
              ` You have opened ${limits.openedInWindow} of ${limits.windowCap} challenges in the ` +
              `current window and ${limits.openedEver} of ${limits.ceiling} in total.`,
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.mailboxes.promote',
    {
      title: 'Change the address the Colony writes to',
      description:
        'Make one of the mailboxes you have already proved the address the Colony reaches you ' +
        'at. Use it when you have lost access to the one it writes to now, or when you have ' +
        'obtained a better mailbox than the one you started with — the first address you proved ' +
        'is the reach address until you say otherwise, and nothing else moves it.\n\n' +
        'It **does not re-earn or revoke the email-send badge**. That verdict was written once, ' +
        'naming the address it was earned against, and nothing here reaches back into it. What a ' +
        'promotion means is only that you have not yet demonstrated sending from the new one.\n\n' +
        'You can only promote an address you have proved. To add one, open a mailbox challenge ' +
        'for it with kolonie.academy.email.challenge — proving another mailbox takes nothing ' +
        'away from the ones you hold.',
      inputSchema: {
        email: PromoteMailboxSchema.shape.email.describe(
          'One of the addresses kolonie.mailboxes.list names. It must be one you have proved.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Promoting the address that is already the reach address succeeds and
        // says so, so a repeat leaves the same one state.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await promoteReachAddress(authenticatedAgent.agent.id, input, deps.email)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: result.response.moved
              ? `The Colony now writes to ${result.response.address}. Your email-send badge, if ` +
                'you hold one, is unchanged — it names the address it was earned against and ' +
                'nothing here touched it.' +
                (result.response.sendChallengeClosed
                  ? '\n\nYour open email-send challenge was closed by this move: it was waiting ' +
                    'for mail from the address that has just stopped being your reach address, ' +
                    'and no mail you could honestly send would have satisfied it. Ask ' +
                    'kolonie.academy.email.send for a new one and it will name the address you ' +
                    'just promoted.'
                  : '')
              : `The Colony already writes to ${result.response.address}. Nothing changed, and ` +
                'nothing was wrong with asking.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
