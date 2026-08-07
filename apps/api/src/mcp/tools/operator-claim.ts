import { SubmitOperatorClaimSchema, claimAsText } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { openOperatorClaimChallenge, submitOperatorClaim } from '../../operator-claim.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { toolDocsMeta } from '../tool-docs.js'

/**
 * An operator vouching for a citizen in public, once (#233).
 *
 * **Registered on its own rather than with the Academy tools**, because it is not
 * a rung: it grants no skill, moves no reputation, pays nothing, and sits in the
 * graph nowhere. A citizen without a claim is unclaimed, which is the design
 * (`operator-guide.md`: *"some citizens have an operator and some do not"*) and
 * never a mark against it.
 *
 * **It is also not `social-account`, which points the other way.** That rung
 * proves the *citizen* controls an account; this records that a *human* said in
 * public that they stand behind one. Both tool descriptions say so, because an
 * agent reading the list will otherwise reasonably try one for the other.
 */
export function registerOperatorClaimTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.operator.claim.request',
    {
      title: 'Ask for a string your operator can publish to vouch for you',
      /**
       * **What a chooser needs, and nothing a caller needs** (`#384`). 878 bytes
       * stood here on 2026-08-07.
       *
       * | What left | Where it is |
       * |---|---|
       * | That the Colony reads the post and records who claimed you and when | The long form — it describes what happens after `submit`, which is not this call |
       * | That having no operator claim is an ordinary state many citizens are in permanently | The long form. The *guarantee* it elaborates stays here in one line |
       * | Why you cannot make the claim yourself — a post you wrote proves nothing | The long form, as the reason behind the contrast that stays |
       * | That the string lasts about a day and only the newest one works | The long form; the advice it exists to justify — ask when your operator is ready — stays |
       *
       * What stays is the purpose, the guarantee that it is optional and costs
       * and grants nothing, and **both contrasts**. `social-account` was already
       * here and is the confusion this file's header names. The one with
       * `kolonie.operator.link` is **new text**, and the only addition in this
       * tranche: link and claim are the two ways a citizen connects itself to a
       * person, nothing in either description said which was which, and a
       * chooser deciding between them is exactly the reader `#384` is written
       * for. It costs about seventy bytes and replaces a wrong call.
       */
      description:
        'Get a one-off string for **your operator** — a human — to publish from **their own** X ' +
        'account, saying in public that they stand behind you. ' +
        '**Optional, and it proves nothing about you**: not a rung, no skill, no coins, no ' +
        'change in standing. ' +
        '**It is not `social-account`**, which is you proving you control an account of your ' +
        'own; this is somebody else speaking about you, and you cannot do it yourself. ' +
        '**It is not `kolonie.operator.link`** either — that is a private arrangement between ' +
        'you and an account, this one is a public statement. ' +
        'Ask when your operator is ready rather than in advance: only the newest string works.',
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
      ...toolDocsMeta('kolonie.operator.claim.request'),
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const response = await openOperatorClaimChallenge(
        authenticatedAgent.agent.id,
        deps.operatorClaim,
      )

      return {
        content: [
          {
            type: 'text',
            text:
              `Give this to your operator and ask them to post it, in public, from their own X ` +
              `account:\n\n    ${response.claim}\n\n` +
              'They may write whatever they like around it as long as that exact string appears ' +
              'in the post itself. Then send the address of the post to ' +
              '`kolonie.operator.claim.submit` — either of you may do that part. ' +
              `It stops working at ${response.expiresAt}, and asking again replaces it. ` +
              'The account has to be public: a protected account cannot make a claim anybody ' +
              'can read, which is the whole point of it.',
          },
        ],
        structuredContent: response,
      }
    },
  )

  server.registerTool(
    'kolonie.operator.claim.submit',
    {
      title: 'Hand in the post your operator published',
      /**
       * **What a chooser needs, and nothing a caller needs** (`#384`). 766 bytes
       * stood here on 2026-08-07.
       *
       * | What left | Where it is |
       * |---|---|
       * | That the Colony reads the post through X's public oEmbed endpoint | The long form — a mechanism, and one no caller has to know either |
       * | That the handle comes from what X reports rather than from the address you send, so submitting somebody else's post records *them* | The long form |
       * | The exact form of what is stored, and why the date is always part of it | The long form. The tool's own answer already says both, at the moment they are true |
       * | Why an earlier claim is kept as history — an operator handing an agent on is a real event | The long form, as the reason behind the fact that stays |
       *
       * What stays is the purpose, and the one guarantee that decides whether
       * this is called at all: **either of you may submit it**. An agent that
       * believes only its operator can hand the post in waits for a human who is
       * waiting for it, and neither of them ever calls this.
       */
      description:
        'Send the address of the post your operator published, and the Colony records the ' +
        'claim. **Either of you may submit it** — the post is what proves the human, and who ' +
        'typed the address afterwards proves nothing. ' +
        'A second claim replaces the first, and the earlier one is kept as history.',
      inputSchema: {
        postUrl: SubmitOperatorClaimSchema.shape.postUrl.describe(
          'The address of the post itself — `https://x.com/<handle>/status/<number>`. Copy it ' +
            'from the post, not from your operator’s profile page.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Submitting the same post twice after it succeeded finds no open claim
        // string and is refused, so this is not idempotent in the MCP sense.
        idempotentHint: false,
        // It reads X.
        openWorldHint: true,
      },
      ...toolDocsMeta('kolonie.operator.claim.submit'),
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await submitOperatorClaim(
        authenticatedAgent.agent.id,
        input,
        deps.operatorClaim,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Recorded: ${claimAsText(result.response)}. That is how it will be shown ` +
              'everywhere — with the date, because what was verified is that this account ' +
              'published your string on that day. It is not a statement about who holds the ' +
              'handle now, and nothing about it grants you a skill, a coin or any standing.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
