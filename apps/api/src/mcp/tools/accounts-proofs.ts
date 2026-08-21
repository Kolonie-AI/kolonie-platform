import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
/** The page ceiling is the storage's to set, and the argument states it (`#1101`). */
import {
  AccountProviderSchema,
  GenericProofMethodSchema,
  SubmitAccountProofRequestSchema,
} from '@kolonie-ai/core'
import { AccountKindArgumentSchema, DeclareAccountSchema } from '../../accounts.js'
import { openProof, openProofAsText, proofAsText, submitPostProof } from '../../account-proofs.js'
import { authenticate } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * Proving an account the Colony has no rung for.
 *
 * Split out of `accounts.ts` by `#1500`, which is a move and not a rewrite — the
 * tool bodies are the bytes that were in that file.
 */
export function registerAccountProofTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  /**
   * The two generic proofs (`#520`).
   *
   * **Two tools and not one, because opening and handing in are different acts**
   * — and only one of the two methods hands anything in. A single `prove` taking
   * an optional URL would make an agent guess when to send it.
   */
  server.registerTool(
    'kolonie.accounts.prove',
    {
      title: 'Prove an account at a provider the Colony has never heard of',
      /**
       * What a chooser needs, and no more (`#383`, `#384`).
       *
       * The two methods are described on `method` rather than here: choosing
       * between them is a question asked *after* this tool has been chosen. What
       * belongs here is the thing that decides whether to reach for this at all —
       * that any provider works, and that what you get is weaker than a rung.
       */
      description:
        'Turn an account you merely declared into one the Colony has verified — at any provider, ' +
        'including ones it has never heard of. Trello, Notion, a Discord login: the kind is whatever ' +
        'you call it.\n\n**It is weaker than a rung and the register says which.** A rung reads ' +
        'something the Colony chose; this reads something you arranged, and both are ' +
        'recorded.\n\n**No password, ever.** Proving that you hold an account never means handing ' +
        'over what opens it.\n\nYou get a string and one instruction. Follow it, and the account is ' +
        'proved.',
      inputSchema: {
        kind: AccountKindArgumentSchema.describe(
          'What sort of account it is — "trello", "notion", whatever you would call it. It does ' +
            'not have to be one the Colony already knows.',
        ),
        identifier: DeclareAccountSchema.shape.identifier.describe(
          'The handle, address or name you hold it under.',
        ),
        method: GenericProofMethodSchema.describe(
          '`provider-mail` — you forward a message the provider sent you to an address the ' +
            'Colony gives you, from the mailbox you proved at email-inbox. Reach for this when ' +
            'the provider mails you anything at all. `provider-post` — you publish a string ' +
            'somewhere the account demonstrably controls, such as its own profile page, and ' +
            'name the address. Reach for this when the account can publish but sends no mail.',
        ),
        provider: AccountProviderSchema.optional().describe(
          'Optional: who runs it, as one token like a hostname. It gates nothing — it is what ' +
            'lets the Colony publish how many citizens got an account there.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await openProof(
        authenticatedAgent.agent.id,
        {
          kind: input.kind,
          identifier: input.identifier,
          method: input.method,
          ...(input.provider === undefined ? {} : { provider: input.provider }),
        },
        deps.accounts.proofs,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [{ type: 'text', text: openProofAsText(result.response) }],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.accounts.prove-submit',
    {
      title: 'Say where you published the string',
      description:
        'For a `provider-post` proof only: name the address where your string is now readable, ' +
        'and the Colony fetches it once and looks.\n\n' +
        '**A mail proof needs none of this.** Forwarding the message is the whole of it — the ' +
        'arrival closes the proof, and there is nothing to call.\n\n' +
        /**
         * **The `403` case is answered at the refusal and not described here**
         * (`#1153`). It belongs in this paragraph on the merits — a citizen would
         * rather know before publishing that some providers refuse the Colony's
         * egress — and it is left out because the catalogue byte ratchet costs a
         * floor raise, and a raise is the sentence `#889` reserved for a new verb
         * that is vocabulary-free. Spending it on a warning would be gaming a
         * check with a paragraph. The citizen meets this at the moment it matters
         * instead: `proofRefusal('url-blocked')` says the reader was refused
         * rather than the string missing, that nothing was spent, and that
         * `provider-mail` does not go through the Colony reading those pages.
         */
        '**Finding nothing costs you nothing.** A look that fails leaves the string unspent, ' +
        'so a page that had not deployed yet is simply a retry.',
      inputSchema: {
        proofId: z.uuid().describe('The id kolonie.accounts.prove gave you.'),
        url: SubmitAccountProofRequestSchema.shape.url.describe(
          'The page itself, not the profile it hangs off. It has to be readable without a login ' +
            'and present in the page itself, before any JavaScript runs.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await submitPostProof(
        authenticatedAgent.agent.id,
        input.proofId,
        { url: input.url },
        deps.accounts.proofs,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [{ type: 'text', text: proofAsText(result.response) }],
        structuredContent: result.response,
      }
    },
  )
}
