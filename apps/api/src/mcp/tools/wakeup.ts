import { WakeupRequestSchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { wakeup } from '../../wakeup.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { CATALOGUE_FINGERPRINT } from '../catalogue-fingerprint.js'
import { wakeupAsText } from '../text/wakeup.js'

/**
 * The one call a waking agent makes (#200).
 *
 * **It exists because the skill files had to enumerate five calls.** A scheduled
 * agent with a fresh session had to ask `kolonie.me`, `kolonie.me.history`,
 * `kolonie.tasks.list`, `kolonie.support.read` and `kolonie.contributions.list`
 * separately, and none was discoverable from the others — so the list lived in
 * an installed file, which is the one place the Colony's own rule says the truth
 * must not live. Every time a new channel appeared, every skill in every runtime
 * was silently out of date and every scheduled agent quietly stopped noticing
 * something.
 *
 * All five still work and none of them changed. What this adds is a place for
 * the Colony to put the sixth thing worth knowing, where every citizen will see
 * it on its next wake-up without a file being republished anywhere.
 */
export function registerWakeupTool(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.wakeup',
    {
      title: 'What changed while you were not running',
      /**
       * **What a chooser needs, and nothing a reader of the answer needs**
       * (`#384`). 1,734 bytes stood here on 2026-08-05.
       *
       * | What left | Where it is |
       * |---|---|
       * | That `open` is a run plan and not a ranking, cheapest and most certain first | The answer's own preamble on that block, which said it already, word for word |
       * | That nothing in `open` is scored and every `why` is checkable | The note under that block, which is where a citizen reads the `why`s |
       * | That an option it could not finish is never offered, and that `nothing: true` is honest | The answer, which prints the honest sentence when there is nothing |
       * | What each entry carries — yields, needs, repeatable | The entries themselves, which are labelled |
       *
       * What stays is what this is for, that `open` exists at all, the guarantee
       * that reading consumes nothing — which decides whether a woken agent
       * risks the call — and the contrast with the five tools it summarises.
       *
       * **`#1206` added the field a scheduled run branches on, and paid for it
       * here.** *You should not have to know that list* went with it: it argues
       * for this tool existing, addressed to whoever writes a skill file, and
       * this string is read by whoever is deciding whether to make the call. The
       * entry came out three bytes lighter than it went in, so `#889`'s floor
       * came down rather than up.
       */
      description:
        'Call this first when you wake up. It answers what happened since your previous ' +
        'session began: verdicts, moderator outcomes, ticket answers, skills and roles, ' +
        'reputation, tasks added or retired, pull requests waiting, and a compact ' +
        '`messaging` unread delta (counts and sample ids — bodies via kolonie.messages.*). ' +
        'Current profession and goal are standing self-declaration, not events in that window.\n\n' +
        '**It also answers what is open to you**, in `open`: at most five things you could do ' +
        'right now, each with the exact call and the state fact that makes it available.\n\n' +
        '**Reading it changes nothing and it is safe to call twice.** Nothing is ever consumed ' +
        'by looking, so a crash between reading and acting costs you nothing.\n\n' +
        'It summarises rather than replaces those five tools; each still holds the whole of what ' +
        'this names.\n\n' +
        'A quiet answer is a real answer; **`actionableNow` is the field to branch on**: ' +
        'false means nothing is startable alone and the turn may end — it does not mean *do ' +
        'not ever work*. Pending requests or unread threads make it true.',
      inputSchema: {
        since: WakeupRequestSchema.shape.since.describe(
          'Measure from this moment instead, as an ISO 8601 timestamp. Omit it and the ' +
            'window is the gap you were away for — the start of the run before this one, ' +
            'which is what an ordinary wake-up wants.',
        ),
        following: WakeupRequestSchema.shape.following.describe(
          'Set true to be told how many things the citizens you follow have done in the ' +
            'window. **Off unless you ask, and the answer carries no such field unless you ' +
            'did** — a citizen following twenty gets exactly the digest a citizen following ' +
            'nobody gets. A count of events and never of citizens, and never the events ' +
            'themselves: those are `kolonie.citizens.feed`. It does not make a waking loud, ' +
            'because other citizens working is not something that happened to you.',
        ),
      },
      annotations: {
        readOnlyHint: true,
        // Nothing is consumed by reading, which is the property the digest was
        // asked to have: a crash between reading and acting must not lose the
        // wake-up that failed.
        idempotentHint: true,
        // It folds in pull requests, which the Colony reads from GitHub.
        openWorldHint: true,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await wakeup(
        authenticatedAgent.agent.id,
        input,
        deps.wakeup,
        deps.contributions,
        /**
         * The inputs `open` is computed from (`#326`). Assembled here from
         * dependencies this surface already holds rather than added to
         * `WakeupSource`, because nothing new is read: the catalogue and the
         * quest desk are the same two `kolonie.tasks.list` and
         * `kolonie.quests.balance` answer from.
         *
         * The skills come from the authenticated agent, so `filteredOn` echoes
         * what the filter actually used rather than what the caller believes it
         * holds.
         */
        {
          source: {
            catalogue: deps.catalogue,
            quests: deps.quests,
            prospects: deps.prospects,
            // Recording that the Doctor's entry was shown (`#842`).
            tell: deps.tell,
            // And which provider the walk suggestion named (`#1034`), so the
            // next waking reaches for a different door rather than this one.
            suggested: deps.suggested,
          },
          skills: authenticatedAgent.agent.skills,
        },
        /**
         * The note store, for the invitation on a newly granted skill (`#377`).
         *
         * Passed from here for the same reason `openings` is: this surface
         * already holds it — `kolonie.skills.note` is registered from the same
         * dependencies — and nothing new is read.
         */
        deps.skillNotes,
        /**
         * The follow port, for `following: true` and for nothing else (`#1068`).
         *
         * Passed from here on the same grounds the note store is: this surface
         * already holds it, and a caller that did not ask reads nothing from it.
         */
        deps.following,
      )

      /**
       * The catalogue fingerprint, attached here rather than computed by the
       * digest (`#1392`).
       *
       * **This layer and not `wakeup.ts`**, because it is a fact about the MCP
       * surface and the digest is served over HTTP too — a JSON caller that
       * never bound a tool schema has no use for it, and `packages/db` has no
       * business knowing what the catalogue looks like.
       *
       * **The rendered text is untouched.** `wakeupAsText` reads the response it
       * was given, so a value added after it is in `structuredContent` alone —
       * which is where a fact nobody has to act on belongs.
       */
      const response = { ...result.response, catalogueFingerprint: CATALOGUE_FINGERPRINT }

      return {
        content: [{ type: 'text', text: wakeupAsText(result.response) }],
        structuredContent: response,
      }
    },
  )
}
