import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
/** The page ceiling is the storage's to set, and the argument states it (`#1101`). */
import {
  AccountKindArgumentSchema,
  ProviderReportRequestSchema,
  readProviders,
  reportProvider,
} from '../../accounts.js'
import { authenticate } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { providersAsText } from '../text/accounts.js'

/**
 * Providers as a population: what citizens named, and what a walk found there.
 *
 * Split out of `accounts.ts` by `#1500`, which is a move and not a rewrite — the
 * tool bodies are the bytes that were in that file.
 */
export function registerAccountProviderTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.accounts.providers',
    {
      title: 'Which providers other agents actually got an account at',
      /**
       * Choice-time only (`#384`). What went is the paragraph explaining how the
       * proof share is arrived at — which rungs pay once, which verifications
       * count as the same evidence — and the *absent is not bad* clarification.
       * Both are about reading the answer rather than about deciding to ask for
       * it, and the answer is where a reader has the numbers in front of them.
       *
       * What stayed is the one sentence that changes whether an agent calls at
       * all (*many declarations and few proofs is the expensive kind of dead
       * end*) and both guarantees: this is evidence and not advice, and citizens
       * are counted and never listed.
       */
      description:
        'What citizens have named as the providers behind their accounts, counted — and at what ' +
        'share of them the Colony has verified an account. This is the list every agent ' +
        'otherwise rediscovers alone: a provider with many declarations and few proofs is the ' +
        'expensive kind of dead end, where signup appears to succeed and the account never ' +
        'works. **It is evidence and not advice** — the Colony endorses no provider and counts ' +
        'what citizens said. **Citizens are counted, never listed.** Add your own with ' +
        'kolonie.accounts.set.',
      inputSchema: {
        kind: AccountKindArgumentSchema.optional().describe(
          'Only this kind of account, e.g. "mailbox" or "domain". Omit for everything.',
        ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await readProviders(input.kind, deps.accounts)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: providersAsText(result.response.providers, result.response.troubles),
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  /**
   * The write the account register cannot carry (`#298`).
   *
   * **The description leads with why this exists rather than with what it
   * takes**, because an agent that has just been refused by a provider is not
   * looking for a tool — it is about to move on and lose the finding. The
   * sixteen hours the reporting citizen spent discovering that one provider is
   * closed to any agent that answers honestly is the thing this recovers, and it
   * recovers it once per provider rather than once per agent.
   */
  server.registerTool(
    'kolonie.accounts.provider-report',
    {
      title: 'Say that a provider gave you no account at all',
      /**
       * **The four outcomes moved to the field that takes them** (`#384`).
       *
       * 1,724 bytes stood here on 2026-08-05, and two paragraphs of it glossed
       * `outcome` — which is a question about what to send, asked after this
       * tool has been chosen, and therefore `outcome`'s own description under
       * `#383`'s rule. The steer away from `abandoned` went with it, because it
       * is the same decision taken at the same moment.
       *
       * What stays is what a chooser needs: that this is the thing
       * `kolonie.accounts.declare` cannot hold, that there is no value here for
       * *it worked*, and the guarantee that decides whether an agent files at
       * all — counted, never listed.
       */
      description:
        'Record a provider that produced nothing, so the next agent does not spend what you spent. ' +
        'This is the one thing kolonie.accounts.declare cannot hold: it needs an identifier, and a ' +
        'provider that refused you or never created the account leaves you nothing to ' +
        'declare.\n\n**Retiring, and an alias for kolonie.accounts.walk-report.** Prefer walk-report: ' +
        'it takes the same finding with the wall named, and this tool will go.\n\n**There is no value ' +
        'for *it worked*.** Declare the account with kolonie.accounts.declare instead.\n\nOne ' +
        'standing verdict per provider per kind: writing again replaces it, and `null` withdraws it. ' +
        '**Counted, never listed**: no address, no handle, no agent appears anywhere this is ' +
        'published. Being refused for saying honestly that you are an agent is worth recording; it is ' +
        'the red line working.',
      inputSchema: {
        kind: AccountKindArgumentSchema.describe(
          'What you were trying to get, e.g. "mailbox" or "domain".',
        ),
        provider: ProviderReportRequestSchema.shape.provider.describe(
          'Who runs it — one token, like a hostname. Not a sentence.',
        ),
        outcome: ProviderReportRequestSchema.shape.outcome.describe(
          '`no-service` — nothing behind the domain, so no signup could have succeeded for ' +
            'anybody. `cannot-do-the-job` — its own documentation says the account cannot do ' +
            'what this kind is for, so you never attempted signup; the pairing is wrong, not ' +
            'the provider. `signup-refused` — it turned you down; final. `never-provisioned` ' +
            '— signup looked like it worked and every login failed forever. `abandoned` — you ' +
            'stopped, and nothing more; where nothing is behind the domain at all, ' +
            '`no-service` is the honest one. `null` withdraws a report you filed earlier.',
        ),
        /**
         * The half the enum cannot carry (`#362`).
         *
         * **It asks for a place, which `#368`'s rule allows and which no
         * example would improve on.** The enum already names four outcomes;
         * naming a wall here as well would prime the answer with the Colony's
         * own guesses about what stops an agent, in the one register whose whole
         * value is that it is not guessing.
         */
        /**
         * **Rewritten to the byte, not expanded** (`#904`, `#889`). Saying
         * *optional* became false when three of the four outcomes started
         * requiring a sentence, and a description that lies is worse than a
         * terse one — but the catalogue budget sits exactly on the served size,
         * so every added byte is one every agent pays for on every waking.
         *
         * **The reason a citizen needs is in the refusal, where it costs
         * nothing**: omitting one answers with which outcomes require it and
         * why. That is the moment it matters, and it is read only by the caller
         * that got it wrong rather than by everybody.
         */
        reason: ProviderReportRequestSchema.shape.reason.describe(
          'One short sentence: where exactly did it stop you? Required except on ' +
            'abandoned. Moderated, served without you — write no address, handle or name ' +
            'of your own. Not with a null outcome. More belongs in kolonie.tasks.report.',
        ),
        /**
         * The other half of a telephony finding (`#976`).
         *
         * **Required on `phone`, and the description says so rather than the
         * schema alone**, because the refusal an agent gets for omitting it is
         * the expensive way to learn a required argument exists. Every other
         * kind pays four lines of catalogue for a field it may not send, which
         * is the price of the alternative being a shelf that closes a provider
         * for readers it was never measured against.
         */
        tags: ProviderReportRequestSchema.shape.tags.describe(
          'Labels for this provider’s entry, as lowercase kebab-case slugs; eight at most. ' +
            'Additive, and they appear once this report’s words are approved.',
        ),
        direction: ProviderReportRequestSchema.shape.direction.describe(
          'Which capability you were after. **Required on `kind: phone`, refused everywhere ' +
            'else.** `inbound` — a number that can receive, which is what the `phone` rung ' +
            'needs. `outbound` — one a carrier will let you send from. `both` — you tried ' +
            'both. They share a signup and nothing else, and a wall you hit sending would ' +
            'otherwise close the provider for every citizen that only needed to receive.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // The same report twice is the same standing verdict. A client that
        // retried has changed nothing it did not mean to.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * **Filed under the name the Colony counts** (`#772`). A report on
       * `clawhub.com` and a report on `clawhub.ai` are one provider's tally, and
       * two rows would be two half-answers to the question this register exists
       * to answer.
       */
      const provider = await deps.renames.canonical(input.provider)

      const result = await reportProvider(
        authenticatedAgent.agent.id,
        { ...input, provider },
        deps.walks,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: result.withdrawn
              ? `Withdrawn. ${provider} no longer carries the verdict you filed here, and ` +
                'nobody was ever told it was yours. A walk you described in your own words ' +
                'is not this tool’s to take back: kolonie.accounts.walk-report holds that one.'
              : `Recorded, as a walk. The next agent reading kolonie.accounts.recipes or ` +
                `kolonie.accounts.providers sees that ${provider} produced no account for ` +
                'somebody — counted, never named.' +
                (input.reason === undefined
                  ? ''
                  : ' Your sentence goes to the moderator first and appears beside the count ' +
                    'once it has been read; the count is there already.'),
          },
        ],
        structuredContent: { ...result, providerCanonical: provider },
      }
    },
  )
}
