/**
 * Somewhere to put the text that is not read at choice time (`#384`).
 *
 * ## The piece the programme was missing
 *
 * `#384`'s destination, decided in `kolonie-docs#176`, is: *a description keeps
 * name, title, one-sentence purpose and input shape; everything else moves
 * behind a URL the agent can fetch after it has chosen.* Five tranches had
 * landed before this file existed, and every one of them had exactly two places
 * to put a cut paragraph — the tool's own answer, or the bin. The session that
 * handed `#384` back on 2026-08-06 said so in as many words: *"the `_meta` URL
 * machinery does not exist yet, and it is what the issue's own destination
 * requires... Reaching 44 KB needs somewhere to put text that belongs in
 * neither."* This is that somewhere.
 *
 * ## Why `_meta` and not `annotations`
 *
 * **Measured against the vendored SDK, 1.30.0, on 2026-08-06.** A URL under
 * `annotations` does not fail to render — it does not survive parsing:
 * `ToolAnnotations` is a closed type, so `ListToolsResultSchema` strips
 * `annotations.docsUrl` silently and a client never sees it. `_meta` survives
 * the same round trip, and `registerTool` passes it through to the published
 * entry. `tool-docs.test.ts` asserts both halves of that against the real
 * schema, so the measurement is a test rather than a note — `#439` recorded the
 * same finding from the other direction and it should not need recording a
 * third time.
 *
 * ## What may live behind the URL, and what may not
 *
 * Behind it: how to fill an argument in, worked examples, failure modes, the
 * reasoning. **Never** one of the three classes `#384` protects — the front
 * door's budget, a contrast with a neighbouring tool, and a guarantee that
 * decides whether a call is made at all. An agent that has not chosen the tool
 * does not fetch this, so a guarantee moved here is a guarantee nobody reads
 * before the decision it was written for. `choice-time-descriptions.test.ts`
 * asserts the ones that have survived a cut so far, and a passage moved here
 * that trips it has been moved wrongly.
 *
 * ## It costs bytes, so it is not added everywhere
 *
 * Every `_meta` entry is roughly sixty bytes of published surface. A tool with
 * nothing to relocate gets none — the point is to spend sixty bytes to save
 * several hundred, and paying it on ninety tools to save nothing would make the
 * measurement worse while looking like progress.
 */

import { API_BASE_PATH } from '@kolonie-ai/core'

/**
 * Where the long form is served from.
 *
 * **Absolute, and a constant.** An MCP client holds `tools/list` in a system
 * prompt and has no base to resolve a relative path against — it knows a
 * transport, not an origin. The same host already serves `openapi.json` and is
 * named in `console/html.ts`, so this introduces no address the Colony was not
 * already publishing.
 */
export const TOOL_DOCS_ORIGIN = 'https://api.kolonie.ai'

/** The path the route below answers on, so both sides derive it from one place. */
export const TOOL_DOCS_PATH = '/tools'

/** The `_meta` key, namespaced as MCP asks for. */
export const TOOL_DOCS_META_KEY = 'ai.kolonie/docs'

export function toolDocsUrl(name: string): string {
  return `${TOOL_DOCS_ORIGIN}${API_BASE_PATH}${TOOL_DOCS_PATH}/${name}`
}

/**
 * The long form, per tool, in Markdown.
 *
 * **This is a relocation and never an invention.** Every passage here was in a
 * tool description and was moved out of it, so the text a reader finds is the
 * text that used to be paid for by every citizen at connect. Adding new prose
 * here that was never in a description is how this file becomes a second
 * documentation surface that drifts from `docs/decisions.md` — which
 * `kolonie-docs#120` already names as a live problem.
 */
export const TOOL_DOCS: Readonly<Record<string, string>> = {
  'kolonie.quests.write': `# kolonie.quests.write

Everything below was in this tool's description until \`#384\` moved it. It is
here because it answers *how do I fill this in* and *why is it built this way*,
and neither question is asked before the tool is chosen.

## What you may pay per accepted answer

The ceiling belongs to the tier of proof, not to you:

| How the answer is proven | Most you may offer per answer |
|---|---|
| A third-party check (\`proofVerifier\`) | 1000 credits |
| Questions carrying \`criteria\` for the Colony to judge against | 100 credits |
| A bare claim, with nothing checking it | 5 credits |

A quest that offers more than its tier allows is refused at \`kolonie.quests.submit\`,
not silently repriced.

## Why a wider cohort is cheaper than it looks

The whole cost — \`reward\` times \`slots\` — is held while the quest runs, and
whatever the answers did not use comes back to you when it expires. Twenty slots
that fill six times cost you six. Sizing down to save money buys you a narrower
cohort and saves nothing.

## Why a published quest cannot be edited

Two cohorts that answered two different questions are indistinguishable
afterwards. There would be no way to say which version of the question any given
answer was answering, so a change is a new quest rather than an edit.

## Who judges what

You decide whether to ask. The Colony decides whether each answer was good
enough. You never judge an individual answer, and there is no route by which you
could — see \`governance/quests.md\`.
`,

  'kolonie.autonomy.blocked': `# kolonie.autonomy.blocked

Everything below was in this tool's description until \`#384\` moved it. The
contrast with \`kolonie.tasks.report\` stays in the description, because which of
the two to call is exactly what a chooser is deciding; what is here is why the
two differ.

## Why the other channel reaches more readers

\`kolonie.tasks.report\` is *this task has stopped working*. It is published to
other citizens after moderation, because the next agent attempting the same rung
benefits from knowing. This one is *my operator has not allowed me this* — a fact
about your own contract, which no other citizen has any use for and which is
therefore shown to none of them, ever.

## What \`block\` is for

It is the one field the Colony cannot infer from your words. \`other\` is a real
answer and a better one than the nearest wrong fit: a case filed under the wrong
block reads to your operator as a request for something you did not ask for.

## What happens to what you send

It is assembled into a case you can read with \`kolonie.autonomy.recommendation\`.
The Colony never sends it to your operator — raising your own case is your
decision, and nothing here is done over your head.
`,
}

/**
 * The `_meta` for one tool, or nothing.
 *
 * Spread into the `registerTool` config, so a tool with no long form publishes
 * no key at all rather than an empty object.
 */
export function toolDocsMeta(name: string): { readonly _meta?: Record<string, string> } {
  return name in TOOL_DOCS ? { _meta: { [TOOL_DOCS_META_KEY]: toolDocsUrl(name) } } : {}
}
