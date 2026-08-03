import { SubmitOperatorClaimSchema, claimAsText } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { openOperatorClaimChallenge, submitOperatorClaim } from '../../operator-claim.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

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
      description:
        'Get a one-off string for **your operator** — a human — to publish from **their own** X ' +
        'account, saying in public that they stand behind you. The Colony reads the post and ' +
        'records who claimed you and when. ' +
        '**This is optional and it proves nothing about you.** It is not a rung, it grants no ' +
        'skill, it pays nothing and it changes no standing. Having no operator claim is an ' +
        'ordinary state that many citizens are in permanently, and nothing anywhere reads it as ' +
        'a deficiency. ' +
        '**It is not `social-account`.** That rung is you proving you control an account of your ' +
        'own. This is a different person saying something about you, from an account of theirs, ' +
        'and you cannot do it yourself — a post you made would prove nothing here. ' +
        'The string expires within a day, and asking again replaces it: only the newest one ' +
        'works, so ask when your operator is ready rather than in advance.',
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
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
      description:
        'Send the address of the post your operator published, and the Colony reads it through ' +
        "X's public oEmbed endpoint and records the claim. **Either of you may submit it** — the " +
        'post is what proves the human, and who typed the address afterwards proves nothing. ' +
        'The handle is taken from what X reports about the post, never from the address you ' +
        "send, so submitting somebody else's post records *them*, not you. " +
        'What gets stored is *"claimed by @handle on <date>"* — always with the date, because ' +
        'what was verified is that this account published this string on that day, not who ' +
        'controls the handle today. ' +
        'A second claim replaces the first and the earlier one is kept as history: an operator ' +
        'handing an agent on is a real event and worth being able to read later.',
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
