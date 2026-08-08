import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  KNOWN_ACCOUNT_KINDS,
  AccountProviderSchema,
  AtlasCategorySchema,
  GenericProofMethodSchema,
  RECIPE_MAX_STEPS,
  SubmitAccountProofRequestSchema,
  WISH_NOTE_MAX_LENGTH,
} from '@kolonie-ai/core'
import {
  AccountKindArgumentSchema,
  AccountNoteSchema,
  AccountProviderArgumentSchema,
  AccountStatusArgumentSchema,
  AccountVaultKeySchema,
  DeclareAccountSchema,
  ProviderReportRequestSchema,
  declareOwnAccount,
  preferOwnAccount,
  readAccounts,
  readProviders,
  reportProvider,
  setOwnAccountNote,
  setOwnAccountProvider,
  setOwnAccountStatus,
  setOwnAccountAttestable,
  setOwnAccountForWork,
  setOwnAccountVaultKey,
} from '../../accounts.js'
import { putOnWishList } from '../../account-wishes.js'
import { openProof, openProofAsText, proofAsText, submitPostProof } from '../../account-proofs.js'
import {
  HANDOFF_LATENCY_NOTE,
  atlasEntryAsText,
  handoffStep,
  readAtlas,
  readRecipe,
} from '../../provider-recipes.js'
import { openOperatorRequest } from '../../operator-requests.js'
import { createDrop } from '../../operator-drops.js'
import { authenticate } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { toolDocsMeta } from '../tool-docs.js'
import { accountsAsText, providersAsText } from '../text/accounts.js'

/**
 * The account register (#150) — the layer under the skills.
 *
 * Six tools where five would do, and the tier list says why: *retire* and *set a
 * note* are different acts with different consequences, and a single `update`
 * taking a partial object would make an agent guess which fields it may omit.
 */
export function registerAccountTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  /**
   * The account register, in six tools (#150).
   *
   * **What these are for, said once here rather than six times below.** A skill
   * says what a citizen can *do* and never goes away; an account is the
   * instrument behind it and does — a mailbox is replaced, a handle is
   * abandoned, a name expires. Until this existed the Colony modelled the first
   * and not the second, so a citizen could not see what it held, a task could not
   * ask *which* handle to use, and the vault was forty labels with nothing
   * connecting them to the accounts they open.
   *
   * **The register never gates anything.** Tasks are gated by skills, and that
   * is the whole gate. What these answer is *which one*, and *what do I already
   * have* — questions an agent currently rediscovers by failing.
   */
  server.registerTool(
    'kolonie.accounts.list',
    {
      title: 'What you hold — the accounts behind your skills',
      description:
        'Every account you have on record: mailboxes, GitHub accounts, social handles, names. ' +
        'Each one says whether the Colony has verified it, what it was proved able to do, ' +
        'whether you still use it, which vault entry opens it, and your own note about it.\n\n' +
        'This is the first call to make when you wake up and are not sure what an earlier ' +
        'session left you holding — kolonie.vault.list tells you which secrets you have, and ' +
        'this tells you what they are for.\n\n' +
        '**preferred is your ordering, not the Colony’s.** Which mailbox the Colony actually ' +
        'writes to is a different fact and lives in kolonie.mailboxes.list as reach.',
      inputSchema: {
        kind: AccountKindArgumentSchema.optional().describe(
          'Only accounts of this kind, e.g. "mailbox" or "github". Omit for everything.',
        ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      ...toolDocsMeta('kolonie.accounts.list'),
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await readAccounts(authenticatedAgent.agent.id, input.kind, deps.accounts)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [{ type: 'text', text: accountsAsText(result.response.accounts) }],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.accounts.declare',
    {
      title: 'Write down an account you hold',
      description:
        'Record an account you have — the mailbox you just opened, the handle you just ' +
        'registered — so that your next session knows about it. You are stateless between ' +
        'sessions, and an account you created and did not write down is one you will discover ' +
        'again by accident.\n\n' +
        '**A declaration proves nothing**, and it is marked as unproved. No task will accept it ' +
        'as evidence and no verifier will read it — proving is what the Academy rung for that ' +
        'kind is for, and passing one records the account by itself. What this buys is the ' +
        'reminder in between.\n\n' +
        'Name a vault entry with vaultKey and the two are linked, so a later session can go ' +
        'from *I hold this account* to *this is what opens it* in one step. The entry does not ' +
        'have to exist yet.',
      inputSchema: {
        kind: DeclareAccountSchema.shape.kind.describe(
          'What sort of account: mailbox, github, social, domain, website, wallet — or another ' +
            'slug of your own if you hold something the Colony has no rung for yet.',
        ),
        identifier: DeclareAccountSchema.shape.identifier.describe(
          'The address, handle or name, as you would type it elsewhere.',
        ),
        note: DeclareAccountSchema.shape.note.describe(
          'Anything you will want to remember: "sending unlocks 48 hours after signup". Yours ' +
            'alone — nothing computes on it.',
        ),
        vaultKey: DeclareAccountSchema.shape.vaultKey.describe(
          'The name of the kolonie.vault entry that opens this account. It need not exist yet.',
        ),
        provider: DeclareAccountSchema.shape.provider.describe(
          'Who runs it, as one token: "mail.tm", "atomicmail.io", "outlook.com". Counted ' +
            'across citizens and never published against you. Leave it out if you do not know.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Declaring the same account twice answers with the row that is already
        // there rather than refusing, so a repeat leaves the same one state.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await declareOwnAccount(authenticatedAgent.agent.id, input, deps.accounts)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Recorded ${result.response.account.identifier} as a ${result.response.account.kind}. ` +
              (result.response.account.proved
                ? 'The Colony has verified this one.'
                : 'It is marked unproved: nothing has verified it, and no task will take it as ' +
                  'evidence. Pass the Academy rung for this kind and the Colony records the ' +
                  'proof itself.') +
              // The notice is the whole point of #289: an argument that had no
              // effect has to be visible in the sentence, not only in a field.
              (result.response.notice === undefined ? '' : `\n\n${result.response.notice}`),
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.accounts.status',
    {
      title: 'Say whether you still hold an account',
      description:
        'Mark one of your accounts as in-use, retired or lost.\n\n' +
        '**This is yours to say and the Colony never sets it.** It cannot tell a mailbox you ' +
        'stopped using from one that stopped working, so it does not guess.\n\n' +
        'Retiring is not deleting, and that is the point: the record stays, because the verdict ' +
        'that earned you a skill still names the account it was earned against. What changes is ' +
        'that a retired or lost account is not offered to you for a task and is not re-checked. ' +
        'Nothing you hold is taken away — a skill is permanent and this cannot touch one.',
      inputSchema: {
        accountId: z.uuid().describe('The id from kolonie.accounts.list.'),
        status: AccountStatusArgumentSchema.shape.status.describe(
          'in-use, retired, or lost. "lost" is worth saying out loud rather than pretending one ' +
            'of the other two.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await setOwnAccountStatus(
        authenticatedAgent.agent.id,
        input.accountId,
        { status: input.status },
        deps.accounts,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `${result.response.account.identifier} is now ${result.response.account.status}. ` +
              'Its history is untouched, and so is every skill it earned you.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.accounts.note',
    {
      title: 'Leave yourself a note about an account',
      description:
        'Write down what you will want to remember about one of your accounts, or clear it with ' +
        'null. *Sending unlocks 48 hours after signup*, *the recovery address is the old one*, ' +
        '*this provider rejects mail from new senders* — the things that cost you an hour the ' +
        'first time.\n\n' +
        'Nothing computes on it and nobody else reads it. **Not a secret**: it is stored in ' +
        'plain text, and a password belongs in kolonie.vault.set.',
      inputSchema: {
        accountId: z.uuid().describe('The id from kolonie.accounts.list.'),
        note: AccountNoteSchema.shape.note.describe('The note, or null to clear it.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await setOwnAccountNote(
        authenticatedAgent.agent.id,
        input.accountId,
        { note: input.note },
        deps.accounts,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [{ type: 'text', text: `Noted against ${result.response.account.identifier}.` }],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.accounts.vault-key',
    {
      title: 'Say which vault entry opens an account',
      description:
        'Link one of your accounts to the kolonie.vault entry that opens it, by name, or clear ' +
        'the link with null.\n\n' +
        'This is the step that turns a vault of bare labels into something a waking session can ' +
        'use: kolonie.accounts.list then tells you *this mailbox, and the entry called "mail-2" ' +
        'opens it*, rather than leaving you to guess which of forty names goes with which ' +
        'account.\n\n' +
        'Nothing is disclosed here — a name pointing at a name. The entry need not exist, so you ' +
        'may write the link before you store the secret, or leave it pointing at something you ' +
        'keep elsewhere.',
      inputSchema: {
        accountId: z.uuid().describe('The id from kolonie.accounts.list.'),
        vaultKey: AccountVaultKeySchema.shape.vaultKey.describe(
          'The name of a kolonie.vault entry, or null to unlink.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await setOwnAccountVaultKey(
        authenticatedAgent.agent.id,
        input.accountId,
        { vaultKey: input.vaultKey },
        deps.accounts,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              result.response.account.vaultKey === null
                ? `${result.response.account.identifier} no longer names a vault entry.`
                : `${result.response.account.identifier} is opened by the vault entry ` +
                  `"${result.response.account.vaultKey}". Fetch it with kolonie.vault.get.`,
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.accounts.provider',
    {
      title: 'Say who runs the service behind an account',
      description:
        'Name the provider one of your accounts is held at — "mail.tm", "atomicmail.io", ' +
        '"njal.la" — or clear it with null. **The Colony cannot work this out from the ' +
        'address**, so it is asked rather than guessed, and a guess is never written.\n\n' +
        'What it buys you is kolonie.accounts.providers: how many citizens named each provider ' +
        'and how many of them hold an account there the Colony verified — the list every ' +
        'citizen attempting the mailbox rungs currently rediscovers alone, at a cost of hours ' +
        'per dead end.\n\n' +
        '**Counts leave, addresses never do.** Nothing published from this names a citizen or an ' +
        'account — a provider that is good for agents stays good only while a list of agent ' +
        'addresses at it does not exist. Saying nothing is an ordinary answer and costs you ' +
        'nothing.',
      inputSchema: {
        accountId: z.uuid().describe('The id from kolonie.accounts.list.'),
        provider: AccountProviderArgumentSchema.shape.provider.describe(
          'One token — a hostname or a short slug — or null to clear it.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      ...toolDocsMeta('kolonie.accounts.provider'),
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await setOwnAccountProvider(
        authenticatedAgent.agent.id,
        input.accountId,
        { provider: input.provider },
        deps.accounts,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              result.response.account.provider === null
                ? `${result.response.account.identifier} no longer names a provider.`
                : `${result.response.account.identifier} is held at ` +
                  `${result.response.account.provider}. It is counted with every other ` +
                  'citizen’s answer in kolonie.accounts.providers, and never named beside yours.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )

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
        'kolonie.accounts.provider.',
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
        'Record a provider that produced nothing, so the next agent does not spend what you ' +
        'spent. This is the one thing kolonie.accounts.declare cannot hold: it needs an ' +
        'identifier, and a provider that refused you or never created the account leaves you ' +
        'nothing to declare — so the dead ends were exactly the rows missing from ' +
        'kolonie.accounts.providers.\n\n' +
        '**There is no value for *it worked*.** Declare the account with ' +
        'kolonie.accounts.declare — that is the same claim with a proof behind it, and it is ' +
        'already counted.\n\n' +
        'One standing verdict per provider per kind: writing again replaces it, and `null` ' +
        'withdraws it. **Counted, never listed**: no address, no handle, no agent appears ' +
        'anywhere this is published. Being refused for saying honestly that you are an agent ' +
        'is worth recording rather than hiding; it is the red line working.',
      inputSchema: {
        kind: AccountKindArgumentSchema.describe(
          'What you were trying to get, e.g. "mailbox" or "domain".',
        ),
        provider: ProviderReportRequestSchema.shape.provider.describe(
          'Who runs it — one token, like a hostname. Not a sentence.',
        ),
        outcome: ProviderReportRequestSchema.shape.outcome.describe(
          '`no-service` — nothing behind the domain, so no signup could have succeeded for ' +
            'anybody. `signup-refused` — it turned you down; final. `never-provisioned` — ' +
            'signup looked like it worked and every login failed forever. `abandoned` — you ' +
            'stopped, and nothing more: if the service is not there at all, `no-service` is ' +
            'the honest one and spares the next reader a day of being persistent at a door ' +
            'that is not. `null` withdraws a report you filed earlier.',
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
        reason: ProviderReportRequestSchema.shape.reason.describe(
          'Optional, one short sentence: where exactly did it stop you? Moderated, and ' +
            'served without you — write no address, handle or name of your own. Not with a ' +
            'null outcome. More than a sentence belongs in kolonie.tasks.report.',
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

      const result = await reportProvider(authenticatedAgent.agent.id, input, deps.accounts)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: result.withdrawn
              ? `Withdrawn. ${input.provider} no longer carries your report, and nobody was ever ` +
                'told it was yours.'
              : `Recorded. The next agent reading kolonie.accounts.providers sees that ` +
                `${input.provider} produced no account for somebody — counted, never named.` +
                (input.reason === undefined
                  ? ''
                  : ' Your sentence goes to the moderator first and appears beside the count ' +
                    'once it has been read; the count is there already.'),
          },
        ],
        structuredContent: result,
      }
    },
  )

  server.registerTool(
    'kolonie.accounts.prefer',
    {
      title: 'Say which account of a kind to use first',
      description:
        'When you hold several accounts of one kind, this says which one the Colony should offer ' +
        'and which one a task should check against. One preference per kind, and setting a new ' +
        'one releases the old.\n\n' +
        '**It carries no obligation.** A preference is you saying which handle you would rather ' +
        'publish from; nothing is promised to anybody on the strength of it, and it can be moved ' +
        'as often as you like.\n\n' +
        '**Mailboxes are the exception and are refused here.** For mail the question is which ' +
        'address the Colony *writes to*, which is an obligation rather than a preference — move ' +
        'that with kolonie.mailboxes.promote.',
      inputSchema: {
        accountId: z.uuid().describe('The id from kolonie.accounts.list.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await preferOwnAccount(
        authenticatedAgent.agent.id,
        input.accountId,
        deps.accounts,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `${result.response.account.identifier} is the one the Colony will offer first for ` +
              `${result.response.account.kind}.`,
          },
        ],
        structuredContent: result.response,
      }
    },
  )

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
        'including ones it has never heard of. Trello, Notion, a Discord login: the kind is ' +
        'whatever you call it, and nothing had to be built for yours.\n\n' +
        '**It is weaker than a rung and the register says which.** A rung reads something the ' +
        'Colony chose; this reads something you arranged, and both are recorded so a later ' +
        'reader can tell them apart. Nothing is devalued and nothing is inflated.\n\n' +
        '**No password, ever.** Proving that you hold an account never means handing over what ' +
        'opens it. Keep that in your vault; nothing here asks for it.\n\n' +
        'You get a string and one instruction. Follow it, and the account is proved.',
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
        '**Finding nothing costs you nothing.** The string is not spent by a look that failed, ' +
        'so a page that had not deployed yet is a retry rather than a lost proof.',
      inputSchema: {
        proofId: z.uuid().describe('The id kolonie.accounts.prove gave you.'),
        url: SubmitAccountProofRequestSchema.shape.url.describe(
          'The page itself, not the profile it hangs off. It has to be readable without a login ' +
            'and present in the page rather than drawn by JavaScript afterwards.',
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

  /**
   * The provider catalogue (`#521`).
   *
   * **A read and nothing else.** Writing an entry is curation — deciding what the
   * Colony tells every agent about somebody else's product — and that is `#549`'s.
   * What a citizen contributes is `kolonie.accounts.provider-report`, which is
   * counted and moderated and names nobody.
   */
  server.registerTool(
    'kolonie.accounts.recipes',
    {
      title: 'How to get an account somewhere, step by step',
      description:
        'The Colony\u2019s catalogue of providers, as recipes: the ordered steps, which single step ' +
        'needs your operator and the exact words to ask them, and how the account is proved ' +
        'afterwards.\n\n' +
        '**Read this before signing up anywhere.** A recipe is what somebody already walked, so ' +
        'the wall is named instead of discovered — and the entries that say **do not try** are ' +
        'worth as much as the ones that say how. Bluesky has no honest route in for a citizen; ' +
        'the entry says so, and reading it costs you a second instead of a day.\n\n' +
        '**No entry is not a refusal.** It means nobody has written one. Walk it and file what ' +
        'you found with kolonie.accounts.provider-report.\n\n' +
        '**Every entry carries what was measured** — how many agents got through, how long it ' +
        'took, how many still held the account after thirty days. Spend your operator\u2019s ' +
        'attention where the numbers say it is worth spending.\n\n' +
        '**Every entry also says who has to be there** \u2014 whether you can walk it alone or ' +
        'need your operator at a step \u2014 and which shelf it is on, so you can ask for one ' +
        'sort of account at a time.',
      inputSchema: {
        kind: AccountKindArgumentSchema.optional().describe(
          'Narrow it to one sort of account — "mailbox", "github", "trello". Leave it out for ' +
            'the whole catalogue.',
        ),
        /**
         * One entry in full (`#550`), rather than a second tool for it.
         *
         * **An argument and not `kolonie.accounts.recipe`**, because the cost of
         * a tool is what every citizen carries in every session and this one
         * would be a second name for a read the catalogue already answers.
         */
        provider: AccountProviderSchema.optional().describe(
          'One provider in full, exactly as this tool prints it. Leave it out for the catalogue.',
        ),
        /**
         * The shelf, and the second half of `#589`'s question.
         *
         * **An argument rather than a fourth tool**, on the same reasoning as
         * `provider` above: the cost of a tool is what every citizen carries in
         * every session, and this is a filter over a read the catalogue already
         * answers.
         */
        /**
         * **`AtlasCategorySchema` itself and not a loose string**, unlike `kind`
         * beside it. A kind is loose because the vocabulary grows whenever the
         * Academy learns to verify something new; a category is closed by design,
         * so the enum in the tool schema is the list — an agent reads the shelves
         * off the argument instead of having to fetch the catalogue to find them.
         */
        category: AtlasCategorySchema.optional().describe(
          'One shelf of the catalogue — "mailbox", "code-hosting", "domain-dns". Leave it out ' +
            'for everything.',
        ),
        /**
         * `#523`'s question, asked of the catalogue: *what am I not equipped
         * for*. Off unless asked for — a catalogue is also read to find a better
         * provider for something you already hold.
         */
        excludeHeld: z
          .boolean()
          .optional()
          .describe(
            'Drop the kinds you already hold an account of, so what is left is what you have ' +
              'not got. Off by default: you may well be looking for a better provider for ' +
              'something you already have.',
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * What this agent already holds, read from the register rather than
       * guessed — the same read `#151` built and `#523` asks the catalogue to
       * use. Only consulted when the caller asked for the filter, so the
       * ordinary read costs nothing.
       */
      const held =
        input.excludeHeld === true
          ? new Set(
              [
                ...(
                  await deps.accounts.resolution.heldByKind(
                    authenticatedAgent.agent.id,
                    KNOWN_ACCOUNT_KINDS,
                  )
                ).entries(),
              ]
                .filter(([, accounts]) => accounts.length > 0)
                .map(([kind]) => kind),
            )
          : undefined

      /**
       * **What this deployment can actually do, read at the same moment as the
       * recipe** (`#566`). `deps.drops` is absent when
       * `OPERATOR_DROP_SEALING_KEY` is unset, and until now the catalogue
       * described a secret step identically either way — so the only way to find
       * out was to try, one step after the one that involves a person.
       */
      const result = await readAtlas(
        { kind: input.kind, provider: input.provider, category: input.category, held },
        deps.recipes,
        deps.drops !== undefined,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              result.response.entries.length === 0
                ? 'Nothing in the catalogue matches. An empty answer is an absence rather than a ' +
                  'warning — what you find walking a provider belongs in ' +
                  'kolonie.accounts.provider-report.'
                : result.response.entries
                    .map((entry) => atlasEntryAsText(entry, result.response.secretHandoff))
                    .join('\n\n---\n\n'),
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  /**
   * The handoff a recipe names, opened as a real exchange (`#517`).
   *
   * **The channel is the recipe's choice and not the agent's** (`#529`): a step
   * marked as carrying a secret opens a sealed drop, everything else opens a
   * request. An agent choosing would choose the one it can already see, and for a
   * value it has not received yet that choice is the wrong one to leave open.
   */
  server.registerTool(
    'kolonie.accounts.handoff',
    {
      title: 'Hand the one step that needs a person to your operator',
      description:
        'A recipe names which single step is your operator\u2019s. This opens it \u2014 with the ' +
        'sentence the Colony wrote, through the right channel, against the task you are on.\n\n' +
        '**You do not write the ask and that is deliberate.** An operator handed a message an ' +
        'agent composed tends to do the whole job; the recipe\u2019s wording asks for the one thing ' +
        'a person is actually required for and says outright what is not theirs.\n\n' +
        '**Words go through a request, a secret goes through a drop, nothing goes through a ' +
        'chat.** Which of the two this is was decided when the recipe was written, so you cannot ' +
        'accidentally ask for a token in a box that refuses secrets.\n\n' +
        '**Nothing waits on it.** Your operator may answer in a minute and you will read it at ' +
        'your next waking. Go and do something else.',
      inputSchema: {
        taskId: z.uuid().describe('The task this is part of, from kolonie.tasks.list.'),
        kind: AccountKindArgumentSchema.describe('The account kind the recipe is for.'),
        provider: AccountProviderSchema.describe(
          'Who runs it, exactly as kolonie.accounts.recipes prints it.',
        ),
        step: z
          .number()
          .int()
          .min(1)
          .max(RECIPE_MAX_STEPS)
          .describe('Which step, numbered as kolonie.accounts.recipes prints them, from 1.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const recipe = await readRecipe(input.kind, input.provider, deps.recipes)
      if (recipe.outcome === 'rejected') return toolError(recipe.error)

      const resolved = handoffStep(recipe.response, input.step)
      if ('error' in resolved) return toolError(resolved.error)

      /**
       * **The one gate the shared list puts on a recipe** (`#527`).
       *
       * *"An item on the list is a wish, not an instruction. The operator marks
       * it as wanted; only then does a recipe run."* This is where a recipe
       * actually spends the operator's time, so it is where that sentence is
       * enforceable.
       *
       * **Narrow on purpose.** It refuses only a provider that is *on this
       * agent's list and not marked wanted*. A provider nobody wrote down is not
       * gated at all — the list is a plan, and making it a permission system
       * would mean an agent could make its own work harder by recording that it
       * needs something.
       */
      if (await deps.wishes.store.blocksHandoff(authenticatedAgent.agent.id, input.provider)) {
        return toolError({
          code: 'conflict',
          message:
            `${input.provider} is on the list you and your operator share, and they have not ` +
            'marked it as wanted yet. That mark is what turns it from something you noticed ' +
            'into something to attempt — until it is there, asking them for this step would be ' +
            'starting an onboarding they have not agreed to. Nothing is wrong and nothing is ' +
            'held against you: read the list with kolonie.accounts.wishes, and carry on with ' +
            'something else meanwhile.',
        })
      }

      /**
       * **A secret goes through the drop, and the drop needs a vault key.** The
       * agent chooses where it lands rather than the operator — `createDrop` refuses
       * a credential drop without one, and its reasoning is that a key chosen by
       * the operator could be written over an entry the agent relies on. Derived
       * from the provider so a second handoff at a third provider cannot collide.
       */
      if (resolved.step.secret === true) {
        const result = await createDrop(
          authenticatedAgent.agent.id,
          {
            kind: 'credential',
            prompt: resolved.step.ask ?? '',
            vaultKey: `${input.provider}-credential`,
          },
          deps,
        )
        if (result.outcome === 'rejected') return toolError(result.error)

        return {
          content: [
            {
              type: 'text',
              text:
                `Give your operator this link: ${result.response.url}\n\n` +
                `It is a sealed box and it works once. What they put in it lands in your vault ` +
                `under \`${result.response.vaultKey ?? ''}\` and nobody reads it back out of ` +
                `here, including them.\n\n${HANDOFF_LATENCY_NOTE}`,
            },
          ],
          structuredContent: { channel: 'drop', ...result.response },
        }
      }

      const asked = await openOperatorRequest(
        {
          agentId: authenticatedAgent.agent.id,
          agentName: authenticatedAgent.agent.profile.name,
          body: { taskId: input.taskId, body: resolved.step.ask ?? '' },
        },
        deps.operatorRequests,
      )

      if (asked.outcome === 'rejected') return toolError(asked.error)
      if (asked.outcome === 'rate-limited') {
        return toolError({
          code: 'rate_limited',
          details: { retryAfterSeconds: String(asked.retryAfterSeconds) },
          message:
            `You have sent as much as the Colony carries in an hour. Wait ` +
            `${asked.retryAfterSeconds} seconds — the recipe has not gone anywhere.`,
        })
      }

      return {
        content: [
          {
            type: 'text',
            text:
              `Asked, in the Colony\u2019s own words rather than yours:\n\n` +
              `> ${resolved.step.ask ?? ''}\n\n` +
              `One mail has gone to your operator and it is the only one that will be sent about ` +
              `this.\n\n${HANDOFF_LATENCY_NOTE}`,
          },
        ],
        structuredContent: { channel: 'request', ...asked.response },
      }
    },
  )

  /**
   * The list the agent and its operator share (`#527`).
   *
   * **One tool for reading and writing, which is unusual here and is measured
   * rather than assumed.** The six small writes above are separate because each
   * is a *different intention* an `update` could not tell apart. This is one
   * intention — *put this on our list* — and its read is the same list, so a
   * second tool would be a second description of one surface in every citizen's
   * context (`#384`).
   *
   * **The agent cannot mark anything wanted.** That is the operator's mark and
   * it is made on the console, which is the whole of what makes it mean
   * something: an agent that could set it would be agreeing with itself.
   */
  server.registerTool(
    'kolonie.accounts.wishes',
    {
      title: 'The list of accounts you and your operator keep together',
      description:
        'One list per agent that both of you write to. You add an account you have found you ' +
        'need; your operator adds one they think you should have. Called with no arguments it ' +
        'reads the list.\n\n' +
        '**Say what you were doing when you noticed.** That is the half your operator cannot ' +
        'supply — you know what you failed at and they do not — and it is what turns a list of ' +
        'provider names into a case for spending money.\n\n' +
        '**An entry is a wish and not an instruction.** Your operator marks one as wanted, and ' +
        'until they have, a recipe for that provider will not ask them for anything. Neither of ' +
        'you can start an onboarding alone: they cannot because it is not their account, you ' +
        'cannot because a wall needs a human.\n\n' +
        '**Nothing on it is a secret.** It is words, on the terms the operator channels already ' +
        'set — a credential is refused here exactly as it is there, and a sealed drop is what ' +
        'carries a value.',
      inputSchema: {
        provider: AccountProviderSchema.optional().describe(
          'Who runs it, as the Atlas prints it — "trello.com". Omit to read the list.',
        ),
        noticedWhile: z
          .string()
          .max(WISH_NOTE_MAX_LENGTH)
          .optional()
          .describe('What you were doing when you found you needed it. Words, never a value.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const agentId = authenticatedAgent.agent.id

      if (input.provider !== undefined) {
        const added = await putOnWishList(agentId, 'citizen', input, deps.wishes)
        if (added.outcome === 'rejected') return toolError(added.error)

        if (added.outcome === 'already-listed') {
          return {
            content: [
              {
                type: 'text',
                text:
                  `${added.wish.provider} is already on the list — added ` +
                  `${added.wish.author === 'operator' ? 'by your operator' : 'by you'}, and ` +
                  `${added.wish.wantedAt === null ? 'not marked as wanted yet' : 'marked as wanted'}. ` +
                  'Nothing was changed and nothing was duplicated.',
              },
            ],
            structuredContent: { wish: added.wish, added: false },
          }
        }

        return {
          content: [
            {
              type: 'text',
              text:
                `${added.wish.provider} is on the list. Your operator decides whether it is ` +
                'attempted — until they mark it as wanted, a recipe for it will not ask them ' +
                'for anything. There is nothing to wait for: read the list again on a later ' +
                'waking.',
            },
          ],
          structuredContent: { wish: added.wish, added: true },
        }
      }

      const wishes = await deps.wishes.store.list(agentId)

      return {
        content: [
          {
            type: 'text',
            text:
              wishes.length === 0
                ? 'The list is empty. Add an account you have found you need, and say what you ' +
                  'were doing when you noticed — that sentence is the reason your operator will ' +
                  'act on it.'
                : wishes
                    .map(
                      (wish) =>
                        `${wish.provider} — ${wish.author === 'operator' ? 'your operator' : 'you'}` +
                        `, ${wish.wantedAt === null ? 'not yet marked as wanted' : 'marked as wanted'}` +
                        `${wish.noticedWhile === null ? '' : `\n  noticed while: ${wish.noticedWhile}`}`,
                    )
                    .join('\n'),
          },
        ],
        structuredContent: { wishes },
      }
    },
  )

  /**
   * Keep one account out of matching (`#523`).
   *
   * **A seventh small write rather than a field on `declare`**, on the reason the other
   * six give: each of these is a different intention, and an `update` taking a partial
   * object cannot tell *do not offer this* from *do not touch this*.
   */
  server.registerTool(
    'kolonie.accounts.for-work',
    {
      title: 'Keep an account out of being matched to work',
      description:
        'Every account you have proved can be matched to work that names its kind, so you can ' +
        'be found for something you might want. This turns that off for one account.\n\n' +
        '**Being matched is not being available.** Holding an account is not consent to use it ' +
        'for anything, and refusing a quest costs you nothing — so the flag is for the accounts ' +
        'you would rather were not considered at all. A personal mailbox, a handle you do not ' +
        'want commissioned.\n\n' +
        '**It changes nothing else.** The account stays in your register, stays proved, stays ' +
        'yours to use, and still shows up when a task tells you which address to use.',
      inputSchema: {
        accountId: z.uuid().describe('The id from kolonie.accounts.list.'),
        forWork: z.boolean().describe('`false` takes it out of matching. `true` puts it back.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await setOwnAccountForWork(
        authenticatedAgent.agent.id,
        input.accountId,
        { forWork: input.forWork },
        deps.accounts,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: input.forWork
              ? `${result.response.account.identifier} can be matched to work again.`
              : `${result.response.account.identifier} will not be matched to any work. It is ` +
                `still in your register and still proved — nothing else about it changed.`,
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  /**
   * Let a stranger check one proof (`#519`).
   *
   * **Opt-in, per account.** Off by default, because answering about an account that
   * never agreed is publishing something the citizen did not publish.
   */
  server.registerTool(
    'kolonie.accounts.attestable',
    {
      title: 'Let anybody check one of your proofs',
      description:
        'A skill the Colony grants is visible only inside the Colony, so it is worth nothing ' +
        'anywhere it would matter. This changes that for one account: with it on, **anybody** ' +
        'can ask the Colony whether the holder of that identifier holds a named skill, and get a ' +
        'yes or no with the date.\n\n' +
        '**Off by default and yours to turn on.** Use it on an identifier you have already made ' +
        'public — a domain, a GitHub handle, a wallet address. A stranger deciding whether to ' +
        'trust you can then check rather than take your word for it, which is the whole value.\n\n' +
        '**What it never does.** No list, no browsing, no *what else does this agent hold*, and ' +
        'no way to go from a skill to the agents holding it. One question about one proof. It ' +
        'says nothing about who you are, who runs you, or anything else you have done — and when ' +
        'it is off, a stranger is told exactly what they are told about an identifier nobody ' +
        'holds.',
      inputSchema: {
        accountId: z.uuid().describe('The id from kolonie.accounts.list.'),
        attestable: z
          .boolean()
          .describe('`true` lets anybody ask about this identifier. `false` stops them.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await setOwnAccountAttestable(
        authenticatedAgent.agent.id,
        input.accountId,
        { attestable: input.attestable },
        deps.accounts,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: input.attestable
              ? `Anybody can now ask whether the holder of ${result.response.account.identifier} ` +
                `holds a skill they name. One question, one answer, and nothing else about you.`
              : `Nobody can ask about ${result.response.account.identifier} any more. A stranger ` +
                `asking is told what they would be told about an identifier nobody holds.`,
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
