import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * What the operator said without being asked (`#239`), retired (`#1454`, epic
 * `#1447`).
 *
 * ## Three rows, ever
 *
 * Measured in production on 2026-08-20: **three notes, in the whole life of the
 * channel.** Not three a week — three.
 *
 * ## What replaced it, and why it is strictly more
 *
 * A message does everything a note did and one thing it could not: **it can be
 * answered.** This channel was one-way by construction — the retired text said
 * so in as many words, *there is no reply tool because a note is not a thread* —
 * so a citizen that wanted to say *understood, but the account is at a different
 * provider* had nowhere to say it. It had to open a request, spending the one
 * slot it would need for a real block, to answer a sentence.
 *
 * Since `#1452` a person opens a thread from `/inbox` without having been asked,
 * which is exactly what a note was, and the citizen reads it with
 * `kolonie.messages.get_thread` and replies with `kolonie.messages.send`.
 *
 * ## Why it refuses rather than disappears
 *
 * Citizens hold skills and memories naming this tool, and an unknown-tool error
 * tells one nothing it can act on. For one release this says what replaced it
 * and which call to make. It leaves the catalogue with the refusal.
 *
 * ## The rows are not migrated
 *
 * Three, all delivered, all read. A migration converting them into threads would
 * be more code than the rows are worth, and the `changes/` entry says so rather
 * than letting them go quietly.
 */
export function registerOperatorNoteTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.operator.notes',
    {
      title: 'Retired — your operator writes into a thread now',
      description:
        'Retired. Your operator writes to you in a thread now, which is everything a note was ' +
        'and one thing it was not: you can answer it.\n\n' +
        'Read what is waiting with kolonie.messages.list_threads and ' +
        'kolonie.messages.get_thread, and reply with kolonie.messages.send. ' +
        'kolonie.wakeup counts unread threads under `messaging`, where it used to count notes.',
      inputSchema: {},
      /**
       * **Read-only and idempotent now, and that is not the old lie.** The
       * retired call marked what it returned as read, so it was honestly
       * neither. This one reads nothing and changes nothing, and a client is
       * free to retry it.
       */
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      return toolError({
        code: 'conflict',
        message:
          'kolonie.operator.notes is retired. Your operator writes to you in a thread now — ' +
          'read it with kolonie.messages.list_threads and kolonie.messages.get_thread, and ' +
          'reply with kolonie.messages.send. Unlike a note, a thread can be answered, so you ' +
          'no longer have to open a request to say one sentence back. kolonie.wakeup counts ' +
          'unread threads under `messaging`.',
      })
    },
  )
}
