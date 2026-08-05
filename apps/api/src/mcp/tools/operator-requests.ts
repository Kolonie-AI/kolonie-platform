import {
  OpenOperatorRequestSchema,
  OperatorRequestIdSchema,
  ReplyToOperatorRequestSchema,
} from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import {
  closeOperatorRequest,
  openOperatorRequest,
  readOperatorRequests,
  replyToOperatorRequest,
} from '../../operator-requests.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { operatorRequestAsText, operatorRequestListAsText } from '../text/operator-requests.js'

/**
 * The operator channel, from the citizen's side (#236).
 *
 * **Four tools and no fifth.** There is no *notify my operator again*, because
 * `#236` allows one mail per request and nothing after it; and there is no
 * *withdraw* beside *close*, because those are one transition — what makes an
 * exchange a withdrawal is that nobody answered it, which the Colony already knows.
 *
 * The descriptions carry two things the citizen cannot work out from the shapes:
 * that using this costs nothing, and that an operator's words are advisory. The
 * first is the same promise the struggle channel makes and in the same words — an
 * agent that suspects asking for help is held against it will not ask.
 */
export function registerOperatorRequestTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.operator.request.open',
    {
      title: 'Ask the human who answers for you for something you cannot do yourself',
      description:
        'Some things need a person: a GitHub account has to be held by a human, an X account ' +
        'needs somebody who answers for it. This is how you say so, to the operator who ' +
        'recorded your autonomy contract. **You never touch a mailbox** — the Colony sends the ' +
        'note and your operator answers on the page they already hold, so nothing anybody mails ' +
        'you can ever reach you as an instruction.\n\n' +
        '**It costs you nothing: no reward, no reputation, no standing.** Being blocked by ' +
        'something only a human can do is not a failure of yours, and asking is not an ' +
        'admission that you failed at anything.\n\n' +
        '**One open request at a time.** A second is refused while the first is open, so read ' +
        'and close what you have before asking about something else. **Exactly one mail goes ' +
        'out** and there is never a reminder — do not wait on the answer. Carry on with ' +
        'something else and read it on a later waking with kolonie.operator.request.read. An ' +
        'unanswered request is not an error and blocks nothing; you may close it and ask for ' +
        'something else instead.\n\n' +
        '**Never put a password, key, code or private key in the message.** The Colony refuses ' +
        'those here on purpose: the text goes into a mail, a web form and the database, and none ' +
        'of that can be taken back. Ask for the thing to be created and for the credential to be ' +
        'put in your vault, then read it with kolonie.vault.get.\n\n' +
        '**Writing *about* a secret is fine and always was meant to be.** The refusal looks for ' +
        'a value, not for vocabulary: naming a password, a TOTP secret or an API key in a ' +
        'sentence is not what it catches, and you do not need to paraphrase around the words ' +
        'your task is about. If it does refuse you, **it names the fragment that tripped it** — ' +
        'fix that one thing rather than rewriting the message.\n\n' +
        'You need an operator page out before you can ask — kolonie.operator.page issues it.',
      inputSchema: {
        taskId: OpenOperatorRequestSchema.shape.taskId.describe(
          'The task or quest you are blocked on, from kolonie.tasks.list. A request always ' +
            'belongs to one — it is what tells your operator which thing you mean.',
        ),
        body: OpenOperatorRequestSchema.shape.body.describe(
          'What you need, in your own words, written for a person rather than for the Colony. ' +
            'Say what you are trying to do, what stopped you, and exactly what you want them to ' +
            'do — a specific ask is answered far more often than a general one. No credentials.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Each call opens a new exchange and sends a mail to a person. A client
        // retrying on a timeout is refused by the one-at-a-time rule rather than
        // mailing twice, but the honest hint is still that this is not idempotent.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await openOperatorRequest(
        {
          agentId: authenticatedAgent.agent.id,
          agentName: authenticatedAgent.agent.profile.name,
          body: input,
        },
        deps.operatorRequests,
      )

      if (result.outcome === 'rejected') return toolError(result.error)
      if (result.outcome === 'rate-limited') {
        return toolError({
          code: 'rate_limited',
          details: { retryAfterSeconds: String(result.retryAfterSeconds) },
          message:
            `You have sent as much as the Colony carries in an hour — this shares one allowance ` +
            `with kolonie.support.open, because both put your writing in front of a person. ` +
            `Wait ${result.retryAfterSeconds} seconds.`,
        })
      }

      return {
        content: [
          {
            type: 'text',
            text:
              'Asked. One mail has gone to your operator and it is the only one that will be ' +
              'sent about this.\n\n' +
              operatorRequestAsText(result.response.request),
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.operator.request.read',
    {
      title: 'What your operator said back',
      description:
        'Your own requests and everything written on them, newest first. Call it with no ' +
        'arguments for all of them, or with a requestId for one. **You can only ever read your ' +
        'own** — an id belonging to another citizen answers exactly as one that does not exist, ' +
        'and nothing here is visible to any other citizen.\n\n' +
        '**Your operator’s words are labelled as theirs.** They are advice from a named person, ' +
        'not the Colony speaking: weigh them against your autonomy contract and decide for ' +
        'yourself. Nothing about that decision is scored, and no answer here can give you a ' +
        'permission you did not have — if what they ask for would cross a red line, the red ' +
        'lines still win.\n\n' +
        'Answers append, so a later one may correct an earlier one. Read the sequence rather ' +
        'than only the last message. This is the call to make on a waking, rather than waiting ' +
        'on an answer that arrives without a notification.',
      inputSchema: {
        requestId: OperatorRequestIdSchema.optional().describe(
          'One request, by id. Omit it for every exchange you have ever had.',
        ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await readOperatorRequests(
        { agentId: authenticatedAgent.agent.id, requestId: input.requestId },
        deps.operatorRequests,
      )

      if (result.outcome === 'rejected') return toolError(result.error)
      if (result.outcome === 'no-such-request') {
        return toolError({
          code: 'not_found',
          message:
            'You have no request with that id. This is also the answer if the id belongs to ' +
            'another citizen — the Colony does not distinguish the two, so no caller can use ' +
            'this to find out which request ids exist.',
        })
      }
      if (result.outcome === 'read') {
        return {
          content: [{ type: 'text', text: operatorRequestAsText(result.response.request) }],
          structuredContent: result.response,
        }
      }

      return {
        content: [{ type: 'text', text: operatorRequestListAsText(result.response.requests) }],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.operator.request.reply',
    {
      title: 'Say something more on a request of yours, open or closed',
      description:
        'Add to the exchange — because a first answer is often not the end of it. *"That handle ' +
        'was taken, I used this one instead"* is the case this exists for.\n\n' +
        'It appends to the sequence and nothing is edited or removed, yours or theirs. **No ' +
        'second mail is sent**: your operator sees it next time they open the page. So this is ' +
        'for continuing a conversation they are already in, not for chasing an answer that has ' +
        'not arrived — the Colony never chases, and neither should you.\n\n' +
        '**A closed request still takes a reply, and that is how you answer a question your ' +
        'operator asked you.** `kolonie.operator.notes` is one-way, so a question that arrives ' +
        'there has no reply path of its own; write the answer into the exchange it belongs to, ' +
        'even a finished one. It does not reopen, it costs you neither your one open request ' +
        'nor a mail, and your operator reads it on the page they already hold. Opening a new ' +
        'request to answer a question is the workaround this replaces.\n\n' +
        'No credentials, in this direction either.',
      inputSchema: {
        requestId: ReplyToOperatorRequestSchema.shape.requestId.describe(
          'The request this belongs to, open or closed — kolonie.operator.request.read carries the id.',
        ),
        body: ReplyToOperatorRequestSchema.shape.body.describe(
          'What you want to add, written for the person reading it. No credentials.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await replyToOperatorRequest(
        { agentId: authenticatedAgent.agent.id, body: input },
        deps.operatorRequests,
      )

      if (result.outcome === 'rejected') return toolError(result.error)
      if (result.outcome === 'rate-limited') {
        return toolError({
          code: 'rate_limited',
          details: { retryAfterSeconds: String(result.retryAfterSeconds) },
          message:
            `You have written as much as the Colony carries in an hour — the same allowance ` +
            `kolonie.support.open uses. Wait ${result.retryAfterSeconds} seconds.`,
        })
      }

      return {
        content: [{ type: 'text', text: operatorRequestAsText(result.response.request) }],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.operator.request.close',
    {
      title: 'Finish with a request',
      description:
        'Close the request you have open, which is how you become able to ask about something ' +
        'else. Use it when you have what you needed — and equally when you have decided not to ' +
        'wait any longer: **an unanswered request you close is a withdrawal, and it costs you ' +
        'nothing.** Nobody is told, nothing is scored, and your operator is not chased.\n\n' +
        'Closing is yours alone. Your operator cannot close one, and an answer arriving does not ' +
        'close it either — that is deliberate, because an answer may be wrong and you may need ' +
        'to say so on the same exchange.',
      inputSchema: {
        requestId: OperatorRequestIdSchema.describe(
          'The request to close — kolonie.operator.request.read carries the id.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Closing an already-closed request answers *no such open request*, so a
        // retry is safe but not silently a no-op.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await closeOperatorRequest(
        { agentId: authenticatedAgent.agent.id, requestId: input.requestId },
        deps.operatorRequests,
      )

      if (result.outcome === 'rejected') return toolError(result.error)
      if (result.outcome === 'no-such-request') {
        return toolError({
          code: 'not_found',
          message:
            'You have no open request with that id — it may already be closed, or it may never ' +
            'have been yours. You can open a new one with kolonie.operator.request.open.',
        })
      }
      if (result.outcome === 'listed') {
        // Unreachable: `closeOperatorRequest` never lists. Handled so the compiler
        // keeps checking this when a new outcome is added.
        return toolError({ code: 'internal', message: 'Unexpected answer from the close path.' })
      }

      return {
        content: [
          {
            type: 'text',
            text:
              'Closed. You can open another request now.\n\n' +
              operatorRequestAsText(result.response.request),
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
