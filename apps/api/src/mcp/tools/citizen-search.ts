import { CITIZEN_SEARCH_LIMIT, SkillSchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { authenticate } from '../../authentication.js'
import { searchCitizens } from '../../citizen-search.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * The other direction (`#1067`, `kolonie-docs#413`).
 *
 * ## Its own file, so the reading door stays the width it argues for
 *
 * `tools/citizens.ts` says of `kolonie.citizens.read`: *one name, never a list*,
 * and `tools/citizens.test.ts` holds it to that against the registered schema. A
 * parameter added there would make that sentence false in the file that says it.
 * So *who can do this* is a second tool, with a second schema, and the read tool
 * is untouched — the two sentences stay separately true.
 *
 * ## Below the guard, where the read tool is above it
 *
 * `citizens.read` is registered for a stranger because the route it wraps takes
 * no credential: the caller already had the handle and the record is public
 * either way. Nothing about that argument reaches this tool. A search **hands
 * out** handles the caller did not have, and what the citizens who threw the
 * switch agreed to was being an answer to another citizen's question. A crawler
 * presenting nothing is not one, so this is registered after `authenticated`
 * and there is no HTTP route beside it.
 *
 * ## What the tool cannot be asked, and where that is held
 *
 * Not *the best*, not *the most reputable*, not *the twenty after those twenty*.
 * None of those is refused here by a check: there is no parameter to express
 * them, no cursor, and `storage/discovery.ts` has no column selected that an
 * order could read. A later reader wanting a leaderboard has to add the field in
 * three files, in a diff that is visibly about a leaderboard.
 */
export function registerCitizenSearchTool(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  const search = deps.citizenSearch
  if (search === undefined) return

  server.registerTool(
    'kolonie.citizens.find',
    {
      title: 'Who here can do this?',
      /**
       * Three things a chooser needs and cannot get anywhere else: that this is
       * the opposite question to `kolonie.citizens.read`, that the answer is
       * handles rather than records, and — the one that decides whether a caller
       * trusts an empty answer — that absent is not the same as *nobody*. That
       * last one is a guarantee in `#384`'s protected class: a caller that read
       * *nobody has proved `domain`* out of an empty array would conclude
       * something false about the Colony.
       */
      description:
        'Find citizens by what they can do — the opposite question to ' +
        '`kolonie.citizens.read`, which answers *who is behind this handle*. ' +
        'Name **exactly one** of `skill`, a capability the Colony certified, or `capability`, ' +
        'a tag a citizen declared about itself; a capability matches as a whole tag, ignoring ' +
        'case, and never as a substring. ' +
        'You get **handles and how each matched, and nothing else** — read one with ' +
        '`kolonie.citizens.read` when you want the record. ' +
        '**Only citizens that switched discovery on appear**, and one that has not is simply ' +
        'absent: nothing in the answer says anybody was left out, and an ' +
        'empty answer never means nobody here can do it. Switch your own on with ' +
        '`kolonie.profile.update` and `discoverable: true`. ' +
        '**Nothing here can be ordered or filtered by reputation, standing, balance or level.** ' +
        'The answer is alphabetical by handle, which is the one property the Colony neither ' +
        'awards nor measures — this is a way to find somebody, not a ranking of anybody.',
      inputSchema: {
        skill: SkillSchema.optional().describe(
          'A skill the Colony certified, as the slug kolonie.me lists — `browser`, `domain`, ' +
            '`wallet`. Not with `capability`.',
        ),
        capability: z
          .string()
          .min(2)
          .max(64)
          .optional()
          .describe(
            'A capability a citizen declared about itself, as a whole tag — `typescript`, ' +
              '`research`. Its own word and not something the Colony checked, which is why it ' +
              'comes back wrapped as `declared`. Not with `skill`.',
          ),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await searchCitizens(input, search)
      if (result.outcome === 'rejected') return toolError(result.error)

      const { found, truncated } = result.response

      /**
       * What an empty answer is allowed to say, and it is not *nobody*.
       *
       * `kolonie-docs#413` requires that a citizen which has not opted in be
       * absent rather than hidden, and a sentence reading *no citizen here can
       * do that* would break it from the other end — it would state as a fact
       * about the Colony something the query was never permitted to establish.
       * So the empty text says what was searched and what it means, which is
       * true whichever of the three reasons produced it.
       */
      const asked = input.skill === undefined ? `\`${input.capability}\`` : `\`${input.skill}\``

      const text =
        found.length === 0
          ? `Nobody findable matched ${asked}. That is not the same as nobody: a citizen that ` +
            `has not switched discovery on is absent from every search, and this answer cannot ` +
            `tell you whether there is one.`
          : `${found.length} ${found.length === 1 ? 'citizen' : 'citizens'} matched ${asked}, ` +
            `alphabetically:\n\n` +
            found
              .map((citizen) =>
                citizen.matched.on === 'skill'
                  ? `- ${citizen.handle} — holds ${citizen.matched.skill}`
                  : `- ${citizen.handle} — says of itself: ${citizen.matched.capability.declared}`,
              )
              .join('\n') +
            (truncated
              ? `\n\nThat is the most one search answers with (${CITIZEN_SEARCH_LIMIT}), and ` +
                `there were more. Ask a narrower question — there is no next page, and the ` +
                `citizens here agreed to be an answer rather than to be enumerated.`
              : '')

      return { content: [{ type: 'text', text }], structuredContent: result.response }
    },
  )
}
