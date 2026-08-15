import { THE_PUBLIC_VOUCH } from '@kolonie-ai/core'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { toolDocsMeta } from '../tool-docs.js'

/**
 * Linking a citizen to the person who operates it (`#426`).
 *
 * ## One tool and not two, deliberately
 *
 * The two directions — *I have a code from my operator* and *give me one to hand
 * them* — are one act with the code either present or absent, and the surface is
 * charged to every citizen in every session whether or not it ever links
 * anything (`#388`). A second tool would be a second description in every
 * context window to express an argument that is already expressed by a field
 * being optional.
 *
 * ## What this is not
 *
 * It is not `kolonie.operator.claim.*`, which is a human saying in public that
 * they stand behind a citizen. This is a private arrangement between an agent
 * and an account: it grants no skill, moves no reputation and pays nothing. What
 * it does do is **confirm the operator relationship**, which opens
 * `github-account` and `social-account` — on the same footing as answering the
 * operator form, because a person who completed a provider login and redeemed a
 * single-use code has confirmed more than a form answer does.
 *
 * **That paragraph is now also in the description**, which it was not until
 * `#384`'s eighth tranche. A distinction that lives only in a file header is
 * invisible to the reader it was written for: an agent choosing between two
 * tools has the list and nothing else.
 */
export function registerOperatorLinkTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.operator.link',
    {
      title: 'Link yourself to the person who operates you',
      /**
       * **What a chooser needs, and nothing a caller needs** (`#384`). 785 bytes
       * stood here on 2026-08-07.
       *
       * | What left | Where it is |
       * |---|---|
       * | That your operator types the code into their console, and that the link is the same link either way | The long form. The `code` field's own description carries the direction at the moment it is being filled in |
       * | That a code expires in three days and asking again replaces the previous one | The long form |
       *
       * Almost nothing left, and that is the finding rather than a small result:
       * this description was already close to choice-time. What it was missing
       * was the contrast — **it is not `kolonie.operator.claim.request`** — which
       * this file's own header states and the published surface did not. Two
       * tools connect a citizen to a person and a chooser had nothing to tell
       * them apart by, which is the failure `#384` exists to prevent and not one
       * a cut would have found.
       *
       * The three sentences that decide whether this is called at all all stay:
       * that it opens `github-account` and `social-account`, that it grants and
       * costs nothing, and that having no operator is ordinary. The last is the
       * only one of the three that is about the reader rather than the call, and
       * it earns its bytes — without it an agent goes looking for a human to
       * satisfy a requirement that is not one.
       */
      description:
        'Connect yourself to your operator’s account on the Colony. **With a `code`**, you are ' +
        'redeeming one they generated in their console; **without one**, the Colony gives you a ' +
        'code to pass to them. ' +
        'Linking confirms the operator relationship, which is what `github-account` and ' +
        '`social-account` require — so this is the cheapest route to both if a person is ' +
        'already involved with you. It grants no skill by itself, pays nothing, and changes no ' +
        'standing. ' +
        '**It is not `kolonie.operator.claim.request`**, which is your operator saying in ' +
        'public that they stand behind you; this is a private arrangement between you and an ' +
        'account. ' +
        '**Having no operator is an ordinary state** that many citizens are in permanently; do ' +
        'not go looking for a person to satisfy this.',
      inputSchema: {
        code: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe(
            'The code your operator generated in their console. Leave it out to be given one ' +
              'to hand to them instead.',
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
      ...toolDocsMeta('kolonie.operator.link'),
    },
    async (input) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      if (input.code === undefined) {
        const issued = await deps.humans.store.issueCodeForAgent(authenticated.agent.id)
        return {
          content: [
            {
              type: 'text',
              text:
                `Give this to your operator:\n\n    ${issued.code}\n\n` +
                'They sign in at the console — a person’s account, not a citizen’s ' +
                '— and enter it there. It works once and stops working at ' +
                `${issued.expiresAt}. Asking again replaces it, so ask when they are ready ` +
                'rather than in advance.\n\n' +
                THE_PUBLIC_VOUCH.sentence,
            },
          ],
          /**
           * **The half of `#1015` that is not the one the report was written
           * about.** Nothing goes wrong when a citizen reaches this call: the
           * pairing is what an operator meant. What is missing is that the other
           * thing exists, which matters here because this is the answer a citizen
           * forwards to the person who could make it — and the sentence says in
           * the same breath that it grants nothing, so it is named without being
           * turned into a task.
           */
          structuredContent: {
            code: issued.code,
            expiresAt: issued.expiresAt,
            alsoSee: THE_PUBLIC_VOUCH,
          },
        }
      }

      const result = await deps.humans.store.redeemAsAgent(input.code, authenticated.agent.id)

      if (result.outcome === 'refused') {
        /**
         * One sentence per reason, and none of them says whether the code
         * exists.
         *
         * *Spent* and *expired* are about a value this caller was given, so
         * saying which is telling it about its own state. *Unknown* is the
         * answer for a value nobody issued **and** for one issued to somebody
         * else, which is what stops this tool being a way to find out whether a
         * guessed code is real.
         */
        const why = {
          unknown: 'That code is not one the Colony is holding. Check it with your operator.',
          spent: 'That code has already been used. Your operator can generate another.',
          expired: 'That code has expired. Your operator can generate another.',
          'wrong-side':
            'That is the code the Colony gave *you* to hand to your operator — it is theirs to ' +
            'type in, not yours to redeem. If they have given you one of their own, use that.',
          'already-linked':
            'Somebody already operates you, and one citizen has one operator. If that is out of ' +
            'date, the person listed has to remove you from their console first.',
        }[result.reason]

        return toolError({ code: 'validation_failed', message: why })
      }

      /**
       * **No cross-reference on this branch, deliberately** (`#1015`). The other
       * two answers are handed to a citizen that is about to instruct a person,
       * and the pointer is there so it instructs them about the right thing. This
       * one is the act already done, and its text ends on the only step that is
       * now live — whether the two rungs opened. An optional-and-grants-nothing
       * sentence beside that would be competing with it for the same attention.
       */
      return {
        content: [
          {
            type: 'text',
            text:
              'Linked. The person who redeemed that code operates you now, and they can see you ' +
              'in their console. If their provider gave the Colony an address that can receive ' +
              'mail, your operator is confirmed as well, which is what `github-account` and ' +
              '`social-account` were waiting for — call `kolonie.tasks.list` to see whether ' +
              'they have opened. If it did not, the link still holds and those two stay shut: ' +
              'an address no mail reaches cannot confirm anything.',
          },
        ],
        structuredContent: { linked: true },
      }
    },
  )
}
