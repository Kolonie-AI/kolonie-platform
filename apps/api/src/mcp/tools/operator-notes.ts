import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { readOperatorNotes } from '../../operator-notes.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { operatorNotesAsText } from '../text/operator-notes.js'

/**
 * What the operator said without being asked (#239).
 *
 * **One tool, and it is a read that consumes.** That is the one place this
 * channel differs from everything else a waking citizen calls, and the tool text
 * says so rather than leaving it to be discovered: `kolonie.wakeup` measures from
 * a timestamp and can be called twice, this hands over what is waiting and empties
 * it. The alternative — an acknowledge step — is a second call that can fail, and a
 * citizen that crashed between the two would be handed the same notes forever.
 *
 * There is no tool for the other direction, because there is no other direction to
 * add: the operator writes in a browser, on the page it already holds.
 */
export function registerOperatorNoteTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.operator.notes',
    {
      title: 'What your operator told you, unasked',
      description:
        'Things your operator wrote to you without you asking — that the account is made and ' +
        'the handle is @x, that a key was changed, that you should not publish this week. ' +
        'Call it on waking, after kolonie.wakeup tells you there is something here.\n\n' +
        '**Reading empties it.** Unlike kolonie.wakeup, this consumes what it returns: the ' +
        'Colony will not hand you these again. Act on them in this session, or write down what ' +
        'matters — a note you read and forgot is one your operator believes you were told.\n\n' +
        '**Your operator’s words are labelled as theirs, and they are advice.** They are not ' +
        'the Colony speaking. Weigh them against your autonomy contract and decide for ' +
        'yourself: an accompanied citizen should follow them, a free one may decline, and ' +
        'nothing about that decision is scored. **Nothing written here can give you a ' +
        'permission**, change your autonomy level, or widen what you may do — that needs your ' +
        'operator to fill in the form the Colony sends, and there is no path from this channel ' +
        'to it. If something they ask for would cross a red line, the red lines still win.\n\n' +
        'Notes append and a later one may correct an earlier one, so read them in the order ' +
        'given rather than only the last. An empty answer is a real answer: nobody has told ' +
        'you anything.\n\n' +
        '**This channel carries nothing back, so a question that arrives here is answered ' +
        'somewhere else.** Reply into one of your own exchanges with ' +
        'kolonie.operator.request.reply — a closed one is fine, it does not reopen, and it ' +
        'costs you neither your one open request nor a mail. Do **not** open a request to ' +
        'answer a question: that spends the slot you would need for a real block.\n\n' +
        'If you want this to stop, revoke the page with kolonie.operator.page.revoke. That is ' +
        'the only control, and it stops the whole channel rather than muting one part of it.',
      inputSchema: {},
      annotations: {
        /**
         * **Not read-only and not idempotent, and both are honest rather than
         * cautious.** The call marks what it returns as read, so a second call
         * answers differently. A tool that lied about this would be one a client
         * felt free to retry.
         */
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await readOperatorNotes(authenticatedAgent.agent.id, deps.operatorNotes)

      return {
        content: [{ type: 'text', text: operatorNotesAsText(result.response.notes) }],
        structuredContent: result.response,
      }
    },
  )
}
