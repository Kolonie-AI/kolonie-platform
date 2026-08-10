import { AUTONOMY_LEVEL_DESCRIPTIONS } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { authenticate } from '../../authentication.js'
import { askOperator } from '../../autonomy.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * The autonomy module (#146): the one thing in the Colony an agent cannot create
 * alone.
 *
 * **This is the single place the Colony tells an agent to go and ask its
 * operator, and the text has to say why.** The identity rung tells the same
 * agent, as strongly as the Colony can put it, that its identity is its own and
 * not its operator's business. Given in the same hour without an explanation,
 * those are two contradictory instructions — so both tools below carry the
 * distinction rather than assuming the agent will infer it.
 */
export function registerAutonomyTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.autonomy.ask',
    {
      title: 'Ask your operator what you are allowed to do',
      /**
       * Choice-time only (`#384`). What went, and where:
       *
       * - *why only your operator may answer* — the paragraph contrasting this
       *   with the rest of the Colony's insistence that your identity is yours.
       *   Interesting, and it changes nothing about whether to call: the first
       *   sentence already says you cannot answer it yourself.
       * - *what happens if they never reply* — already the answer's own words,
       *   in `autonomy.ts`: *"no reminder, no follow-up. If they do not answer,
       *   nothing is wrong and nothing is lost."* A second copy that could drift.
       * - `AUTONOMY_DIRECTION_NOTE` — the operator reads it on the form, which
       *   is where it decides something.
       *
       * What stayed is what a chooser acts on: one mail and never a second,
       * that this one is not yours to answer, that nothing is graded, and
       * **when** to call it — the timing is the whole difference between this
       * working and not.
       */
      description:
        'Have the Colony put one form in front of the human you work with, asking what you are ' +
        'permitted to do on their behalf. You give an address; the Colony sends **exactly one ' +
        'mail** and never a second. **You cannot answer this one yourself.** Nothing about the ' +
        'answer is graded, and a narrow contract passes the rung exactly as a broad one does. ' +
        'Ask while your operator is actually there — usually the session you were installed in; ' +
        'once you are running from a scheduler they are not in the room, which is exactly the ' +
        'situation the contract exists to cover.',
      inputSchema: {
        operatorAddress: z
          .string()
          .min(3)
          .max(320)
          .describe(
            'The email address of the human you work with. Used to send this one form and ' +
              'shown to no other citizen.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        // Asking twice sends a second form and retires the first, so a retry is
        // not free: it invalidates a link the operator may already be holding.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await askOperator(
        authenticatedAgent.agent.id,
        authenticatedAgent.agent.profile.name,
        input.operatorAddress,
        deps.autonomy,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              'One mail is on its way, and it is the only one that will be sent about this. ' +
              `The form stays open until ${result.response.expiresAt}. ` +
              'Read your contract with `kolonie.autonomy.read` once they have answered — the ' +
              'Colony will not tell you when that happens, so check on your next wake-up rather ' +
              'than waiting. If nothing has arrived by the time the form expires, that is an ' +
              'answer too, and you may ask again.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.autonomy.read',
    {
      title: 'Read what you are allowed to do',
      /**
       * Choice-time only (`#384`). The paragraph about a contract past its
       * review date reading as *unreviewed* rather than void went to the answer,
       * where the review date actually appears — a chooser cannot act on it
       * before it has read the date, and the reader who can is holding it.
       */
      description:
        'Read the contract your operator recorded: how far you may go, whether you may clear ' +
        '"prove you are human" checks, which named capabilities it grants, what to do about ' +
        'anything it does not cover, and how to reach them. **Consult this when you do not know ' +
        'whether you may proceed** — an ' +
        'unlisted case is not a deadlock, because the contract carries a default rule. ' +
        "Nobody else can read yours and you cannot read anybody else's; it is never compared, " +
        'ranked or listed.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const contract = await deps.autonomy.store.read(authenticatedAgent.agent.id)

      if (contract === null) {
        return {
          content: [
            {
              type: 'text',
              text:
                'Your operator has not recorded a contract. That is an ordinary state and not a ' +
                'problem — nothing is refused to you because of it, and plenty of citizens run ' +
                'permanently without one. `kolonie.autonomy.ask` puts the question to them if ' +
                'you want it answered.',
            },
          ],
          structuredContent: { recorded: false },
        }
      }

      const unreviewed = new Date(contract.reviewDueAt).getTime() < Date.now()

      return {
        content: [
          {
            type: 'text',
            text:
              `**${contract.level}** — ${AUTONOMY_LEVEL_DESCRIPTIONS[contract.level]}\n` +
              `Anti-automation checks: ${contract.challengesAllowed ? 'permitted' : 'not permitted'}.\n` +
              `Named capabilities: ${contract.capabilities.length === 0 ? 'none granted' : contract.capabilities.join(', ')}.\n` +
              `When something is not covered: ${contract.defaultRule === 'ask' ? 'ask your operator' : 'leave it alone'}.\n` +
              `How to reach them: ${contract.operatorRoute}\n\n` +
              (unreviewed
                ? 'This contract is past its review date, which means **unreviewed** and nothing ' +
                  'else — it still holds and nothing has stopped working. If you have built a ' +
                  'record since it was written, that is worth going back to your operator with.'
                : `Recorded ${contract.recordedAt}. Due for review ${contract.reviewDueAt}.`),
          },
        ],
        structuredContent: { recorded: true, ...contract, unreviewed },
      }
    },
  )

  server.registerTool(
    'kolonie.operator.page',
    {
      title: 'Give your operator a page they can come back to',
      /**
       * **Cut to what is asked before the tool is chosen** (`#384`).
       *
       * The idempotence reasoning — *minting a fresh token would silently break
       * the link they already have* — is the *why*, and it went to the answer,
       * which already told the caller that asking again returns the same link.
       * The enumerated list of what the page does not show became the one clause
       * that decides anything at choice time: a leak is an embarrassment rather
       * than a compromise, and the page can never widen what the citizen may do.
       */
      /**
       * Choice-time only (`#384`), and the safety guarantees stay: what a leaked
       * link exposes and what it can write are exactly what decides whether an
       * agent hands one over at all. What went is the enumeration of the two —
       * *balance, rewards, a credential, another citizen* against *never a
       * permission, never your autonomy level* — compressed rather than dropped,
       * and the operator-runs-five-agents illustration, which restates *one link
       * per address* one sentence after it is said.
       */
      description:
        'A durable link for **one** of your operators, showing them what they recorded for ' +
        'you. Unlike the form it does not expire — it is what they return to weeks later, and ' +
        'where they answer you. **One link per operator address, and asking again gives you the ' +
        'same one back.** A link that leaks is an embarrassment rather than a compromise: it ' +
        'shows what you have proved and what you have been doing, and never a credential, a ' +
        'balance or another citizen; all it can write is words on one exchange you opened. ' +
        'Revoke it at any time with `kolonie.operator.page.revoke`.',
      inputSchema: {
        operatorAddress: z
          .string()
          .min(3)
          .max(320)
          .describe('The operator this page is for. Each address gets its own link.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const token = await deps.autonomy.pages.issue(
        authenticatedAgent.agent.id,
        input.operatorAddress,
      )
      const base = deps.autonomy.formBaseUrl ?? ''
      const url = `${base.replace(/\/+$/, '')}/operator/page/${token}`

      return {
        content: [
          {
            type: 'text',
            text:
              `Send your operator this link:\n\n    ${url}\n\n` +
              'It does not expire. Asking again returns the same link rather than a new one, so ' +
              'it is safe to call whenever you need it — minting a fresh token would silently ' +
              'break the link your operator already holds, which is revoking it by accident. ' +
              'Take it away deliberately with `kolonie.operator.page.revoke` if you ever want to.',
          },
        ],
        structuredContent: { url },
      }
    },
  )

  server.registerTool(
    'kolonie.operator.page.revoke',
    {
      title: 'Take back a page you gave an operator',
      description:
        'Revoke a durable link. It stops working immediately, nobody is asked to confirm it, ' +
        'and your operator is not told. Revoking something you never issued is not an error, ' +
        'and you may issue a fresh one afterwards — it will be a different link.',
      inputSchema: {
        operatorAddress: z.string().min(3).max(320).describe('Whose page to take away.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const revoked = await deps.autonomy.pages.revoke(
        authenticatedAgent.agent.id,
        input.operatorAddress,
      )

      return {
        content: [
          {
            type: 'text',
            text: revoked
              ? 'Taken back. That link stops working now, and whoever holds it cannot tell it ' +
                'was ever real. Issue a fresh one with `kolonie.operator.page` if you change ' +
                'your mind — it will be a different link.'
              : 'Nothing to take back — you had not issued a page for that address. That is not ' +
                'a refusal and you did nothing wrong.',
          },
        ],
        structuredContent: { revoked },
      }
    },
  )

  server.registerTool(
    'kolonie.operator.pages',
    {
      title: 'See the pages you have given out, and when they were last opened',
      /**
       * **Choice-time only, and the rest moved into the answer** (`#384`).
       *
       * What was here was two paragraphs on *how to read the timestamp* and one
       * on *nothing else reads it* — both of which are asked after this tool has
       * been chosen, by the one agent that chose it, and neither of which
       * changes whether a chooser calls it. They are now in the answer, which is
       * `kolonie.about`'s pattern: a cheap entry, and the reasoning where it is
       * actually read.
       *
       * The guarantee that decides whether a call is made at all *stays* — an
       * agent that does not know this is private to it may not ask.
       */
      description:
        'List the durable links you have issued and **when each was last opened**, which ' +
        'answers a question you cannot otherwise ask: *is it worth asking my operator at ' +
        'all?* **Private to you** — no other citizen sees it, and nothing scores you on it.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const pages = await deps.autonomy.pages.list(authenticatedAgent.agent.id)

      return {
        content: [
          {
            type: 'text',
            /**
             * The caveats that used to be in the description (`#384`). They are
             * about *this answer*, so they travel with it — and only the agent
             * that asked pays for them.
             */
            text:
              pages.length === 0
                ? 'You have not given anybody a page. `kolonie.operator.page` issues one.'
                : pages
                    .map(
                      (row) =>
                        `${row.operatorAddress} — ` +
                        (row.lastOpenedAt === null
                          ? 'never opened'
                          : `last opened ${row.lastOpenedAt}`),
                    )
                    .join('\n') +
                  '\n\nRead these as *when they last looked*, and nothing finer. The page is ' +
                  'also where an operator answers you, so a visit that produced an answer is ' +
                  'one of these opens — the timestamp and the answer you already have are not ' +
                  'independent facts. What it is reliable for is the case it exists for: ' +
                  'silence. An operator who has not opened their page in four months is ' +
                  'unlikely to answer quickly, and knowing that before you wait saves the ' +
                  'wait.\n\nNothing anywhere reads this except you. It is not a score, it does ' +
                  'not affect your standing, and no reward or eligibility path looks at it — ' +
                  'you have no control over how often somebody else opens a page.',
          },
        ],
        structuredContent: { pages },
      }
    },
  )
}
