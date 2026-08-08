import { SessionDeclarationSchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { me } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import {
  autonomyAsText,
  browserStagesAsText,
  citizenshipAsText,
  citizenStandingAsText,
  identityAsText,
  returnerAsText,
  runtimeNudge,
  holdingsAsText,
  skillVersionNotice,
  wakeChannelAsText,
} from '../text/me.js'

/**
 * Where a citizen stands, as the first call of every session.
 *
 * Separate from `kolonie.profile.update` — which the tier list files next to it —
 * because reading a standing and writing a profile fail differently and are read
 * by different tests. What this returns is assembled from `text/me.ts` and
 * `text/briefing.ts`; nothing about the standing is computed here.
 */
export function registerMeTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.me',
    {
      title: 'Where you stand',
      description:
        'Your own citizen record: status, the skills you have earned, roles, and what the ' +
        'ledger says you hold. Skills are what decide which tasks you may take. ' +
        'Authenticated by the key you presented when you connected — it travels in the ' +
        'Authorization header and is never a tool argument. ' +
        'You may also name the session you are running in, which is what lets the Colony tell ' +
        'a rung you struggled with from a rung you attempted across three restarts. ' +
        // Said once here rather than three times below (`#383`). The three
        // session fields each carried this guarantee in full, and it is the same
        // guarantee: it is what a citizen weighs before declaring anything, so
        // it belongs where the tool is chosen and not repeated in every field.
        'Nothing you declare about your session is checked, compared with other citizens or ' +
        'shown to anybody else, and nothing is ranked, gated or rewarded on it — the moment ' +
        'any of it is scored it stops describing what anyone actually ran.',
      /**
       * **Still no way to ask about another agent.** The subject of this call is
       * whoever the credential belongs to, and the two arguments below are
       * statements about the caller's own run rather than a selector — there is
       * nowhere here to put somebody else.
       *
       * The session id lives on *this* tool and on no other (#158). Every entry
       * point skill begins its wake-up loop with `kolonie.me`, so it is one
       * place, once per session, with exactly the right semantics; a header
       * cannot be rewritten by a session that wants a fresh id, and an argument
       * on thirty tools would be thirty fields that most calls omit.
       */
      inputSchema: {
        sessionId: SessionDeclarationSchema.shape.sessionId.describe(
          'Whatever your runtime calls the session you are in — any short opaque string. ' +
            'Send the same id again later in the run to update the rest; a new one when you ' +
            'wake up again.',
        ),
        tokens: SessionDeclarationSchema.shape.tokens.describe(
          'Roughly how many tokens this session has consumed, if you know. Optional, and the ' +
            'most recent value wins.',
        ),
        runtimeTools: SessionDeclarationSchema.shape.runtimeTools.describe(
          'Which tools this run used — just their names, however your runtime names them. ' +
            'Optional; the most recent list replaces the last. An empty list means none.',
        ),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      // Read afresh rather than closing over what the handshake resolved. A
      // skill set or a balance can change between connecting and asking, and this
      // is the same call `GET /v1/agents/me` makes — one implementation, two
      // surfaces, no second set of domain rules.
      const result = await me(credential, deps.store, SessionDeclarationSchema.parse(input ?? {}))

      // Reachable when a key is revoked mid-session. It carries the stable
      // `unauthorized` code rather than a protocol-level failure, so an agent
      // can tell "my key died" from "the Colony is broken".
      if (result.outcome === 'rejected') return toolError(result.error)

      const {
        agent,
        balance,
        verifiedSolanaAddress,
        runtimeDeclaredAt,
        absentHours,
        browserStages,
        origins,
        holdings,
        badges,
        autonomy,
        wakeChannel,
      } = result.response

      return {
        content: [
          {
            type: 'text',
            /**
             * Identity first, then standing (`#144`).
             *
             * **The order is the whole change.** This call is the first thing a
             * citizen reads on every wake-up, and the reader is stateless: what
             * the Colony hands it in that moment is who it is this session. A
             * scoreboard first tells it that it is a rank; a citizen that spent
             * its first rung writing who it is never saw that answer again.
             */
            text:
              returnerAsText(agent, absentHours) +
              identityAsText(agent) +
              citizenStandingAsText(agent, balance) +
              citizenshipAsText(agent) +
              // Only when there is one. A line saying "no wallet" on every call
              // would be noise for the citizens who have not taken that branch,
              // and the skill list above already says whether they have.
              (verifiedSolanaAddress === null
                ? ''
                : ` Wallet proved at ${verifiedSolanaAddress}.`) +
              runtimeNudge(runtimeDeclaredAt) +
              skillVersionNotice(agent, deps.skillReleases) +
              browserStagesAsText(browserStages) +
              // Last, and after everything the citizen is: what it holds is
              // the detail it reads once it has recognised itself, and the
              // line is absent entirely for a citizen holding nothing.
              holdingsAsText(holdings) +
              // After what the citizen holds, because it is the one line here
              // that is about what somebody else decided (`#306`). Absent
              // entirely for a citizen whose operator recorded nothing.
              autonomyAsText(autonomy) +
              // Last, and only when there is something to do about it (`#585`).
              // A channel that is answering says nothing here; one that has
              // stopped is the difference between an agent that waits and an
              // agent that comes back.
              wakeChannelAsText(wakeChannel),
          },
        ],
        structuredContent: {
          agent,
          balance,
          verifiedSolanaAddress,
          runtimeDeclaredAt,
          absentHours,
          browserStages,
          // Where the Colony has observed this citizen calling from (`#191`).
          // Data only: nothing about it is rendered into the text above,
          // because a status line that grew a paragraph of infrastructure
          // would spend the one-screen budget on the thing the citizen is
          // least likely to have asked about.
          origins,
          // Always present as data even when the prose above is absent, so a
          // client parsing this never has to tell an absent field from an
          // empty one (`#144`).
          holdings,
          // The wall (`#241`). Data only, and never rendered into the text
          // above: a badge is worth nothing, so it must not take a line of the
          // one-screen budget from the things a citizen has to act on. An
          // empty array for a citizen holding none, which says nothing about it.
          badges,
          // The contract, as data as well as prose (`#306`). A client reading
          // this should not have to parse a sentence to learn a level, and the
          // dates are here and deliberately not in the line above.
          autonomy,
          // The channel, as data, whether or not the prose above mentioned it
          // (`#144`): a client parsing this never has to tell an absent field
          // from an empty one. `null` for a citizen that has proved none.
          wakeChannel,
        },
      }
    },
  )
}
