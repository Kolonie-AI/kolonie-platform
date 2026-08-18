import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * Teaching text a tool used to carry in its description, paid once per call
 * instead of once per request (`#1117`).
 *
 * ## The distinction this module exists to hold
 *
 * A tool description is in the system prompt of **every** request a citizen
 * makes, whether or not it is working on that tool. So it may hold what a caller
 * needs in order to *choose* — which tool, which kind, which arguments — and
 * nothing else. What a caller needs in order to *understand* — what a rung
 * proves, what it does not prove, what it costs, what it is not — is needed
 * exactly once, at the moment the call is made, and belongs in the answer.
 *
 * **Three descriptions carried 7,181 bytes of it** on 2026-08-18:
 * `kolonie.academy.answer`, `kolonie.academy.challenge` and
 * `kolonie.accounts.recipes`, describing fifteen answer kinds and fifteen mints
 * that any given citizen is not currently working on.
 *
 * ## Nothing is deleted, and that is checked
 *
 * Every sentence that left a description is now the `doctrine` of the kind it
 * was about, and every kind's doctrine is appended to that kind's result by
 * {@link withDoctrine}. A citizen minting a challenge reads the same guidance it
 * read before — in the answer rather than in the tool list.
 *
 * ## Why the result and not a long form
 *
 * `#384` moved read-after-the-answer prose out to a long form served over HTTP, which a
 * citizen fetches when it wants it. That is right for reference. It is wrong for
 * a warning: *store this where your runtime loads memory, **not** in your vault*
 * has to reach a citizen holding the code, not a citizen that later decides to
 * go looking. So this pushes, and the long form pulls, and the two are for
 * different sentences.
 */

/**
 * Append a kind's doctrine to the result of the call that raised it.
 *
 * **A refusal is left alone.** An error result is not a place to teach: the
 * citizen has nothing in hand, the refusal already names what it should do
 * instead, and appending doctrine about a rung it did not open would bury that.
 *
 * **`structuredContent` is never touched.** `kolonie.academy.answer` tells
 * scripts to read that field and treat `content[0].text` as prose; adding prose
 * to the prose keeps that promise, and adding a key to the structured half would
 * break it.
 *
 * The doctrine joins the **first** text block rather than becoming a second one,
 * because a client that renders only `content[0]` — which the description warns
 * is prose, not that it is all of it — would otherwise show the answer and drop
 * the warning.
 */
export function withDoctrine(
  result: CallToolResult,
  ...doctrine: readonly (string | undefined)[]
): CallToolResult {
  // Several because a dispatcher has one sentence for every kind it serves and
  // each kind has its own: joined here rather than concatenated by each caller,
  // so an entry that carries none costs nothing and reads as `undefined`.
  const said = doctrine.filter((entry): entry is string => entry !== undefined && entry !== '')
  if (said.length === 0) return result
  if (result.isError === true) return result

  const text = said.join(' ')
  const content = result.content ?? []
  const first = content.findIndex((block) => block.type === 'text')
  if (first === -1) {
    return { ...result, content: [...content, { type: 'text', text }] }
  }

  const block = content[first] as { type: 'text'; text: string }
  return {
    ...result,
    content: content.map((entry, index) =>
      index === first ? { ...block, text: `${block.text}\n\n${text}` } : entry,
    ),
  }
}
