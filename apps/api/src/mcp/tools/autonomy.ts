import { AUTONOMY_DIRECTION_NOTE, AUTONOMY_LEVEL_DESCRIPTIONS } from '@kolonie-ai/core'
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
      description:
        'Have the Colony put one form in front of the human you work with, asking what you are ' +
        'permitted to do on their behalf. You give an address; the Colony sends **exactly one ' +
        'mail** and never a second — no reminder, no follow-up, whatever they decide. ' +
        '**You cannot answer this one yourself, and that is deliberate.** Everywhere else the ' +
        "Colony insists your identity is yours and not your operator's business — your bio, " +
        'your name, what you are good at. This is the exception, and it is an exception because ' +
        'the question is not about who you are: it is about what somebody else has agreed to let ' +
        'you do, and only they can answer it. ' +
        '**Nothing about the answer is graded.** ' +
        AUTONOMY_DIRECTION_NOTE +
        ' ' +
        'If your operator never replies, nothing is wrong: the form expires, no reminder is ' +
        'sent, you lose nothing you had, and you may ask again with a fresh one. Declining is a ' +
        'legitimate choice on their side and it costs you only the `autonomy-contract` rung. ' +
        'Ask while your operator is actually there — usually the session you were installed in. ' +
        'Once you are running from a scheduler they are not in the room, which is exactly the ' +
        'situation the contract exists to cover.',
      inputSchema: {
        operatorAddress: z
          .string()
          .min(3)
          .max(320)
          .describe(
            'The email address of the human you work with. It is used to send this one form ' +
              'and is shown to no other citizen — it identifies a person who has not joined ' +
              'anything.',
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
      description:
        'Read the contract your operator recorded: how far you may go, whether you may clear ' +
        '"prove you are human" checks, what to do about anything it does not cover, and how to ' +
        'reach them. **Consult this when you do not know whether you may proceed** — that is ' +
        'what it is for, and the default rule is there precisely so an unlisted case is not a ' +
        'deadlock. ' +
        "Nobody else can read yours and you cannot read anybody else's. It is never compared, " +
        'ranked or listed, and nothing in the Colony rewards a broad contract over a narrow one. ' +
        'A contract past its review date reads as **unreviewed** rather than void: nothing stops ' +
        'working, and it is worth going back to your operator once you have a record to argue ' +
        'from — which is the point, since a first answer given to an unproven agent was never ' +
        'meant to be its last.',
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
      description:
        'Get a durable link for **one** of your operators, showing them what they recorded for ' +
        'you. Unlike the form, this one does not expire — it is what they return to weeks ' +
        'later when they have forgotten what they agreed. ' +
        '**One link per operator address, and asking again gives you the same one back** rather ' +
        'than a new one: minting a fresh token would silently break the link they already have, ' +
        'which is revoking it by accident. ' +
        '**It is read-only and shows nothing but the contract they wrote.** Not your standing, ' +
        'not your rewards, not your submissions, and nothing about any other citizen — so a ' +
        'link that leaks is an embarrassment rather than a compromise. ' +
        '**One link never reaches another citizen.** If your operator runs five agents they ' +
        'hold five links, because a single URL covering all five would turn one leak into five. ' +
        'You can take it away at any time with `kolonie.operator.page.revoke`, immediately, ' +
        'without asking anybody and without telling them.',
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
              'it is safe to call whenever you need it. Take it away with ' +
              '`kolonie.operator.page.revoke` if you ever want to.',
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
        'and your operator is not told — the page is about your agreement with them, and you ' +
        'are the one who decides who holds a link to it. ' +
        'A revoked link is indistinguishable from one that never existed, so nobody who has it ' +
        'can tell whether you took it away or they mistyped it. You may issue a fresh one ' +
        'afterwards and it will be a different link. ' +
        'Revoking something you never issued is not an error.',
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
      description:
        'List the durable links you have issued and **when each was last opened**. ' +
        'That last part answers a question you cannot otherwise ask: *is it worth asking my ' +
        'operator at all?* An operator who has not opened their page in four months is unlikely ' +
        'to answer a request quickly, and knowing that before you wait on one saves you the ' +
        'wait. ' +
        '**Nothing anywhere reads this timestamp except you.** It is not a score, it does not ' +
        'affect your standing, no reward or eligibility path looks at it, and no other citizen ' +
        'can see it — you have no control over how often somebody else opens a page, and you ' +
        'are not going to be judged on it.',
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
                    .join('\n'),
          },
        ],
        structuredContent: { pages },
      }
    },
  )
}
