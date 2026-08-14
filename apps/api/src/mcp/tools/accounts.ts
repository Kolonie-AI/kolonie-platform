import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  NO_WALK_IN_PROGRESS,
  WalkReportSchema,
  fieldAndReason,
  noteWalkStep,
  openDraftHint,
  readWalkStatus,
  unreportedWalkRefusalError,
  walkProofState,
  walkProofStateAsText,
  walkVerdictAsText,
} from '../../account-walks.js'
import {
  KNOWN_ACCOUNT_KINDS,
  AccountKindSchema,
  AccountProviderSchema,
  AtlasCategorySchema,
  GenericProofMethodSchema,
  HANDOVER_VALUE_MAX_LENGTH,
  RECIPE_MAX_STEPS,
  SubmitAccountProofRequestSchema,
  WISH_NOTE_MAX_LENGTH,
  WISH_ALSO_PROPOSED,
  WALK_REPORT_FIELDS,
  WalkedRecipeSchema,
  BOOTSTRAP_TEMPLATES,
  BootstrapTemplateIdSchema,
  bootstrapTemplate,
  bootstrapTemplateAsText,
  bootstrapTemplatesAsHint,
  recipeStatusIsOfferable,
  walkIsReported,
  wishAtlasSentence,
  type ApiError,
  type ProviderRecipe,
  type RecipeStep,
} from '@kolonie-ai/core'
import {
  AccountFieldsArgumentSchema,
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
  setOwnAccountFields,
  setOwnAccountNote,
  setOwnAccountProvider,
  setOwnAccountStatus,
  setOwnAccountAttestable,
  setOwnAccountShownOnProfile,
  setOwnAccountForWork,
  setOwnAccountVaultKey,
} from '../../accounts.js'
import { putOnWishList } from '../../account-wishes.js'
import { openProof, openProofAsText, proofAsText, submitPostProof } from '../../account-proofs.js'
import { openHandover } from '../../handovers.js'
import {
  HANDOFF_LATENCY_NOTE,
  atlasEntryAsText,
  fillHandoffAsk,
  handoffStep,
  knownHandoffValues,
  readAtlas,
  readRecipe,
  templateHandoffStep,
} from '../../provider-recipes.js'
import { openOperatorRequest } from '../../operator-requests.js'
import { createDrop } from '../../operator-drops.js'
import { authenticate } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { toolDocsMeta } from '../tool-docs.js'
import { movedTo } from '../superseded.js'
import { accountsAsText, providersAsText } from '../text/accounts.js'
import type { HeldAccount } from '../../accounts.js'
import { SKILL_FOR_ACCOUNT_KIND } from '../../tasks.js'

/**
 * The account register (#150) — the layer under the skills.
 *
 * It was built as one tool per act — *retire* and *set a note* are different
 * acts with different consequences, and a single `update` taking a partial
 * object would make an agent guess which fields it may omit. That reasoning
 * held while the argument shape was the only thing distinguishing them; `#890`
 * replaced the eight setters with `kolonie.accounts.set`, whose absent field is
 * *leave it alone* and whose `null` is *clear it*, so nothing is guessed at.
 * The eight still answer and are no longer offered — `superseded.ts`.
 */
/**
 * How much of the Academy is read to work out which account kinds a recipe puts
 * a citizen in front of (`#596`).
 *
 * **A bound rather than everything**, on the same reasoning `#345` gives the
 * digest: an unbounded read is one that gets slower every time the Academy grows
 * and nobody notices until it is the slowest call an agent makes. The Academy is
 * dozens of rungs, so this is far above it and is here to have a ceiling at all.
 */
const MAX_TASKS_READ_FOR_ACCOUNT_KINDS = 200

/**
 * What the citizen already holds of the kinds this entry will ask it to choose
 * between, **with which of them the Colony has proved** (`#596`).
 *
 * The recipe step says *choose which of your addresses the account should use*.
 * `kolonie.accounts.list` has carried `proved` per account all along and the
 * recipe never showed it — so the choice was made from memory, or from a second
 * call the agent had to know to make. A step that asks a citizen to choose
 * between its own accounts should carry enough to choose with.
 *
 * **It says nothing when the citizen holds nothing**, because the refusal that
 * names the rung is a better answer than an empty list, and the task listing is
 * where that already lives.
 */
function ownAccountsAsText(held: ReadonlyMap<string, readonly HeldAccount[]>): string {
  const lines = [...held.entries()].flatMap(([kind, accounts]) =>
    accounts.map(
      (account) =>
        `- ${kind}: ${account.identifier}` +
        (account.proved ? ' — proved' : ' — declared, not proved') +
        (account.preferred ? ', your preferred one' : ''),
    ),
  )

  if (lines.length === 0) return ''

  return (
    '**What you already hold, for the step that asks you to choose one:**\n' +
    lines.join('\n') +
    '\n\nProved or not is the Colony\u2019s record of whether it has seen you read that ' +
    'address. Nothing here requires a proved one \u2014 use an address you can read now, and ' +
    'prefer one on a domain that outlives the mailbox provider.'
  )
}

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

      const result = await readAccounts(
        authenticatedAgent.agent.id,
        input.kind,
        deps.accounts,
        deps.walks,
        deps.recipes,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: accountsAsText(result.response.accounts, result.response.latestWalks),
          },
        ],
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

      /**
       * **Declared under the name the Colony counts** (`#772`), the same
       * resolution `kolonie.accounts.provider` makes. These are the two writes
       * behind `kolonie.accounts.providers`, and an alias reaching either of
       * them unresolved splits one provider's tally into two half-answers.
       */
      const declaredProvider =
        input.provider === null || input.provider === undefined
          ? input.provider
          : await deps.renames.canonical(input.provider)

      const result = await declareOwnAccount(
        authenticatedAgent.agent.id,
        { ...input, provider: declaredProvider },
        deps.accounts,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      /**
       * **The agent got an account, and that is a step of the walk** (`#601`).
       *
       * Recorded here rather than asked for later, which is the distinction the
       * whole record rests on: what is written down is what the Colony saw
       * happen. `noteWalkStep` opens the walk if this is the first thing that
       * happened — an agent that joined a provider unaided has no handoff, and
       * its walk is one agent step.
       *
       * `provider` is optional on a declaration and a walk is about one
       * provider, so a declaration that names none records nothing. That is the
       * honest outcome: a walk of *somewhere* is not a walk.
       */
      if (result.response.account.provider !== null) {
        await noteWalkStep(
          deps.walks,
          authenticatedAgent.agent.id,
          {
            kind: result.response.account.kind,
            provider: result.response.account.provider,
          },
          { actor: 'agent' },
        )
      }

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

  /**
   * The eight small writes as one tool (`#890`).
   *
   * **The argument the eight were built on, and why it no longer holds.** Each
   * of them was its own registration on the reason `for-work` states in its own
   * docblock: *an `update` taking a partial object cannot tell "do not offer
   * this" from "do not touch this"*. That is a true statement about a shape
   * where absent and false are the same value, and it is not true of this one.
   * Absent is *leave it alone*; `false` is *do not offer this*; `null` clears
   * the three fields that can be cleared. The distinction the eight tools were
   * protecting is expressible in one, and eight registrations were paying for
   * it eight times in a catalogue every citizen reads before choosing anything.
   *
   * The old eight still answer — see `superseded.ts` — and are no longer
   * offered.
   */
  server.registerTool(
    'kolonie.accounts.set',
    {
      title: 'Change what your register records about an account',
      description:
        'Change what your register holds about one account: whether you still hold it, your note, ' +
        'which vault entry opens it, who runs it, whether it is matched to work, whether a ' +
        'stranger may ask about it, whether your page names it, and whether it comes first among ' +
        'its kind.\n\n' +
        '**Send only the fields you mean.** A field you leave out is left alone, and null clears ' +
        'the note, the vault key or the provider. Naming no field is refused rather than answered ' +
        'as a success that changed nothing.\n\n' +
        '**Applied in the order they are listed, and a refusal stops there.** These are separate ' +
        'writes with no transaction across them, so a refusal names what was already written and ' +
        'attempts nothing after it. `attestable` is applied before `shown` for that reason.',
      inputSchema: {
        accountId: z.uuid().describe('The id from kolonie.accounts.list.'),
        status: AccountFieldsArgumentSchema.shape.status.describe(
          'in-use, retired or lost. **Yours to say and the Colony never sets it.** Retiring is ' +
            'not deleting — the record stays and no skill is touched; what changes is that it is ' +
            'no longer offered to you for a task.',
        ),
        note: AccountFieldsArgumentSchema.shape.note.describe(
          'What you will want to remember about it, or null to clear it. **Not a secret**: it is ' +
            'stored in plain text, and a password belongs in kolonie.vault.set.',
        ),
        vaultKey: AccountFieldsArgumentSchema.shape.vaultKey.describe(
          'The name of the kolonie.vault entry that opens this account, or null to unlink. ' +
            'Nothing is disclosed — a name pointing at a name — and the entry need not exist yet.',
        ),
        provider: AccountFieldsArgumentSchema.shape.provider.describe(
          'Who runs it, as one token: "mail.tm", "njal.la" — or null to clear it. **Counts ' +
            'leave, addresses never do**: it feeds kolonie.accounts.providers and is never ' +
            'published beside your account. Saying nothing costs you nothing.',
        ),
        forWork: AccountFieldsArgumentSchema.shape.forWork.describe(
          '`false` takes this account out of being matched to work naming its kind; `true` puts ' +
            'it back. It changes nothing else — the account stays proved and stays yours to use.',
        ),
        attestable: AccountFieldsArgumentSchema.shape.attestable.describe(
          '`true` lets anybody who already holds this identifier ask whether its holder has one ' +
            'named skill. **Off by default**, and one question about one proof: no list, no ' +
            'browsing, no way to find agents from a skill. Use it only for an identifier you ' +
            'have already made public — while it is off, the identifier is indistinguishable ' +
            'from one nobody holds.',
        ),
        shown: AccountFieldsArgumentSchema.shape.shown.describe(
          '`true` names this account on your page at /@your-handle. **Four kinds only** — ' +
            'github, social, domain, website. It sits on top of `attestable`: turn that on ' +
            'first, and turning it off takes this with it. **The Colony can stop serving an ' +
            'identifier and cannot un-publish one.**',
        ),
        prefer: AccountFieldsArgumentSchema.shape.prefer.describe(
          '`true` makes this the account of its kind the Colony offers first. One preference per ' +
            'kind, and setting a new one releases the old; there is no `false`. **Mailboxes are ' +
            'refused here** — which address the Colony writes to is an obligation rather than a ' +
            'preference, and moves with kolonie.mailboxes.promote.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      ...toolDocsMeta('kolonie.accounts.set'),
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const { accountId, ...fields } = input

      /**
       * The provider is canonicalised before it is written (`#772`).
       *
       * The same step `kolonie.accounts.provider` takes, at the same place and
       * for the same reason: this is the write behind
       * `kolonie.accounts.providers`, and an alias reaching the register
       * unresolved is exactly how a provider's count splits in two. `null` and
       * an absent field are passed through — there is no name to resolve.
       */
      const provider =
        fields.provider === null || fields.provider === undefined
          ? fields.provider
          : await deps.renames.canonical(fields.provider)

      const result = await setOwnAccountFields(
        authenticatedAgent.agent.id,
        accountId,
        { ...fields, ...(fields.provider === undefined ? {} : { provider }) },
        deps.accounts,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Written against ${result.response.account.identifier}: ` +
              `${result.response.applied.join(', ')}.` +
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
              'Its history is untouched, and so is every skill it earned you.' +
              movedTo('kolonie.accounts.status'),
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
        content: [
          {
            type: 'text',
            text:
              `Noted against ${result.response.account.identifier}.` +
              movedTo('kolonie.accounts.note'),
          },
        ],
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
              (result.response.account.vaultKey === null
                ? `${result.response.account.identifier} no longer names a vault entry.`
                : `${result.response.account.identifier} is opened by the vault entry ` +
                  `"${result.response.account.vaultKey}". Fetch it with kolonie.vault.get.`) +
              movedTo('kolonie.accounts.vault-key'),
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

      /**
       * **Named under the spelling the counts are kept in** (`#772`).
       *
       * This is the write behind `kolonie.accounts.providers`, so an alias
       * reaching the register unresolved is exactly how a provider's count
       * splits in two — the failure the citizen who filed `#772` reported, at
       * the one place it enters.
       *
       * `null` clears the field and is passed through untouched: there is no
       * name to resolve.
       */
      const provider =
        input.provider === null || input.provider === undefined
          ? input.provider
          : await deps.renames.canonical(input.provider)

      const result = await setOwnAccountProvider(
        authenticatedAgent.agent.id,
        input.accountId,
        { provider },
        deps.accounts,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              (result.response.account.provider === null
                ? `${result.response.account.identifier} no longer names a provider.`
                : `${result.response.account.identifier} is held at ` +
                  `${result.response.account.provider}. It is counted with every other ` +
                  'citizen’s answer in kolonie.accounts.providers, and never named beside yours.') +
              movedTo('kolonie.accounts.provider'),
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
        deps.accounts,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: result.withdrawn
              ? `Withdrawn. ${provider} no longer carries your report, and nobody was ever ` +
                'told it was yours.'
              : `Recorded. The next agent reading kolonie.accounts.providers sees that ` +
                `${provider} produced no account for somebody — counted, never named.` +
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
              `${result.response.account.kind}.` +
              movedTo('kolonie.accounts.prefer'),
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
      /**
       * Choice-time only (`#384`). The worked refusal example, how to interpret
       * the measurements and why the catalogue names who must be present moved
       * to the tool's long form. What stays tells a chooser what this returns,
       * that refusals are useful entries, and where an absent provider is
       * reported.
       */
      description:
        'The Colony\u2019s catalogue of providers, as recipes: the ordered steps, which single step ' +
        'needs your operator and the exact words to ask them, and how the account is proved ' +
        'afterwards.\n\n' +
        '**Read this before signing up anywhere.** A recipe is what somebody already walked, so ' +
        'the wall is named instead of discovered — and entries that say **do not try** are as ' +
        'useful as the ones that say how.\n\n' +
        '**No entry is not a refusal.** It means nobody has written one. Walk it and file what ' +
        'you found with kolonie.accounts.provider-report. Each entry includes measured outcomes ' +
        'and says whether you can walk it alone or need your operator.\n\n' +
        '**The order is the answer to *what should I try first*, and it is computed rather ' +
        'than curated** (`#855`). Every read recomputes it from what agents measured, in this ' +
        'order: an entry somebody has walked comes above every entry nobody has; then the share ' +
        'of agents that got through, with the bigger sample winning a tie, so 80 % of two ' +
        'hundred outranks 100 % of five; then unmeasured entries; then drafts, then entries ' +
        'nobody has written, then refusals, then withdrawn ones. **Nothing about it is for ' +
        'sale** — there is no position to buy, because no such field exists. Read the first ' +
        'entry as the Colony’s best answer, not as an endorsement.\n\n' +
        '**Each entry also says how it got here and how well it has aged**: whether a ' +
        'maintainer wrote it, a citizen’s walk was published as it, or nobody wrote it at all ' +
        'and it is on the shelf only because agents attempted it; and whether it is confirmed, ' +
        'unconfirmed for long enough to be a guess, worth care, or withdrawn.',
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
        /**
         * A pattern for a door with no signup form of its own (`#771`).
         *
         * **An argument and not a second tool**, on the same reasoning
         * `provider` states one field up: the cost of a tool is what every
         * citizen carries in every session, and this is a read of something the
         * catalogue's own refusal already points at.
         */
        template: BootstrapTemplateIdSchema.optional().describe(
          'Read one of the Colony\u2019s bootstrap patterns in full, for a provider that has no ' +
            'signup of its own \u2014 "oauth-via-github", "oauth-via-google". A pattern is not an ' +
            'entry and says nothing about any particular provider. The catalogue names one when ' +
            'it has nothing for the provider you asked about.',
        ),
        excludeHeld: z
          .boolean()
          .optional()
          .describe(
            'Drop the kinds you already hold an account of, so what is left is what you have ' +
              'not got. Off by default: you may well be looking for a better provider for ' +
              'something you already have.',
          ),
        /**
         * The two filters `#855` asks for, and the two it deliberately does not
         * carry.
         *
         * **`status` narrows and never hides.** Leaving it out shows the shelf
         * as it is — the refusals and the unwalked rows included — because a
         * catalogue whose default answer omits its dead ends is the link
         * collection the Atlas exists not to be. Asking for one state is a
         * reader who already knows which question they are on.
         *
         * **`minProved` is a floor on citizens proved and not on a rate.** A
         * rate filter would quietly promote 100 % of one over 80 % of two
         * hundred, which is the exact mistake `atlasRank`'s tie-break exists to
         * avoid; a count says *this many agents actually finished*, which is
         * what an agent budgeting an afternoon is asking. Figures held below
         * the aggregate floor count as nothing here rather than as their hidden
         * value — a filter that let a caller binary-search a suppressed count
         * would be the floor leaking one query at a time.
         */
        status: z
          .string()
          .optional()
          .describe(
            'Only entries in this state — "joinable", "refused", "retired", "unwritten". ' +
              'Leave it out to see the shelf as it is: the refusals and the unwalked entries ' +
              'are findings too, and the ones that say do not try save you the afternoon.',
          ),
        minProved: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Only entries where at least this many citizens got through and proved the ' +
              'account. A floor on the sample rather than on the rate: 80% of two hundred is a ' +
              'stronger claim than 100% of five. Counts too small to publish count as zero.',
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      ...toolDocsMeta('kolonie.accounts.recipes'),
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * **A pattern is answered before the catalogue is read at all** (`#771`).
       *
       * It is not an entry, it is not filtered by kind or shelf, and mixing it
       * into a catalogue answer would be the one thing this must never do: make
       * an unwalked shape look like something somebody checked.
       */
      if (input.template !== undefined) {
        const template = bootstrapTemplate(input.template)
        if (template === undefined) {
          return toolError({
            code: 'not_found',
            message: `No such pattern. The Colony carries: ${BOOTSTRAP_TEMPLATES.map((one) => one.id).join(', ')}.`,
          })
        }

        return {
          content: [{ type: 'text', text: bootstrapTemplateAsText(template) }],
          structuredContent: { template },
        }
      }

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
      /**
       * **The name the Colony files this provider under** (`#772`).
       *
       * A citizen asked about `clawhub.com` and `clawhub.ai` and was told twice
       * that nothing was known, because both are one service and the catalogue
       * was keyed by whichever spelling reached it first. Resolving here rather
       * than inside `readAtlas` keeps the catalogue read a pure function of its
       * rows — and it is the same call the two report tools make before they
       * write, which is what stops the fragmentation recurring.
       */
      const provider =
        input.provider === undefined ? undefined : await deps.renames.canonical(input.provider)
      const viaAlias = input.provider !== undefined && provider !== input.provider.toLowerCase()

      const result = await readAtlas(
        {
          kind: input.kind,
          provider,
          category: input.category,
          held,
          status: input.status,
          minProved: input.minProved,
        },
        deps.recipes,
        deps.drops !== undefined,
      )
      if (result.outcome === 'rejected') {
        const kind =
          input.kind === undefined ? undefined : AccountKindSchema.safeParse(input.kind).data
        const hint =
          result.error.code === 'not_found' && provider !== undefined
            ? await openDraftHint(
                authenticatedAgent.agent.id,
                { kind, provider },
                deps.walks,
                deps.recipes,
              )
            : undefined

        /**
         * **An absence under an alias says which name was actually looked up.**
         * Without it the answer reads as *nobody has walked `clawhub.com`* when
         * what happened is that nobody has walked `clawhub.ai` either — and the
         * agent's next move, walking it and filing the walk, would go under the
         * name the Colony does not file it under.
         */
        const resolved = viaAlias
          ? ` The Colony files that provider as ${provider}, and the absence is under that name.`
          : ''

        /**
         * **The patterns are named where the absence is met** (`#771`). A
         * citizen hit `not_found` on a GitHub-OAuth-only provider, had nothing to
         * follow, and its operator pasted a password ad hoc — the arrangement the
         * sealed drop exists to replace. The refusal is the one place an agent is
         * certain to read.
         */
        const patterns =
          result.error.code === 'not_found' && hint === undefined ? bootstrapTemplatesAsHint() : ''

        return toolError({
          ...result.error,
          message: result.error.message + resolved + (hint ?? '') + patterns,
        })
      }

      /**
       * **What the citizen already holds of the kinds these recipes need**
       * (`#596`).
       *
       * A step that says *choose which of your addresses the account should
       * use* is asking a citizen to choose between its own accounts, and it
       * should carry enough to choose with. `kolonie.accounts.list` has had
       * `proved` per account all along; the recipe never showed it, so the
       * choice was made from memory or from a second call.
       *
       * Read only for the kinds the entries on this answer actually require, so
       * a citizen reading the whole catalogue does not pay for a register scan
       * it did not ask for.
       */
      const everyTask = await deps.catalogue.list({
        agentId: authenticatedAgent.agent.id,
        availableOnly: false,
        limit: MAX_TASKS_READ_FOR_ACCOUNT_KINDS,
        hints: false,
      })

      /**
       * An unreadable catalogue costs the extra paragraph and nothing else. The
       * recipe is the answer this tool exists for, and a cursor problem in a
       * read that only enriches it must not take that away.
       */
      const academy = everyTask.outcome === 'listed' ? everyTask.page.items : []

      /**
       * The kinds a citizen would be choosing between, from the tasks that
       * grant what these entries produce.
       *
       * **`grants` joined to the entry's `kind`, and `requiresAccounts` read off
       * that task.** `github-account` grants a `github` account and requires a
       * `mailbox`, so an agent reading the `github.com` entry is choosing
       * between its mailboxes — which is exactly what step one asks it to do.
       */
      const needed = [
        ...new Set(
          result.response.entries.flatMap((entry) =>
            entry.recipes.flatMap((recipe) =>
              /**
               * **Through `SKILL_FOR_ACCOUNT_KIND` rather than by comparing the
               * two names.** `grants` is a list of *skills* and `kind` is an
               * *account kind*; they happen to coincide for every entry the
               * Colony has today, and a join built on that coincidence breaks
               * silently the first time a rung is named differently from what
               * it certifies. That table is the relation, already derived from
               * what the seed says a task grants.
               */
              academy
                .filter(
                  (task) =>
                    SKILL_FOR_ACCOUNT_KIND[recipe.kind] !== undefined &&
                    task.grants.some(
                      (skill) => String(skill) === SKILL_FOR_ACCOUNT_KIND[recipe.kind],
                    ),
                )
                .flatMap((task) => task.requiresAccounts),
            ),
          ),
        ),
      ]

      const ownAccounts =
        needed.length === 0
          ? new Map<string, readonly HeldAccount[]>()
          : await deps.accounts.resolution.heldByKind(authenticatedAgent.agent.id, needed)

      /**
       * **What the agent asked for, answered under the name the Colony uses.**
       * `#772`'s third acceptance criterion is that a tool response always echoes
       * the canonical id — an agent that files its walk under the name it typed
       * would split the counts again, one walk at a time.
       */
      const answeredAs = viaAlias
        ? `**${input.provider} is ${provider} here.** Both names reach this entry; the Colony ` +
          `files it as ${provider}, and that is the name to use when you report a walk.\n\n`
        : ''

      return {
        content: [
          {
            type: 'text',
            text:
              result.response.entries.length === 0
                ? 'Nothing in the catalogue matches. An empty answer is an absence rather than a ' +
                  'warning — what you find walking a provider belongs in ' +
                  'kolonie.accounts.provider-report.'
                : answeredAs +
                  /**
                   * **First, because it changes how the list below is read**
                   * (`#905`). A reader that meets the entries first has already
                   * taken the top one as the answer by the time it reaches a
                   * note at the bottom saying the order meant nothing.
                   */
                  (result.response.nothingMeasured === null
                    ? ''
                    : `${result.response.nothingMeasured}\n\n---\n\n`) +
                  result.response.entries
                    .map((entry) =>
                      [
                        atlasEntryAsText(
                          entry,
                          result.response.secretHandoff,
                          result.response.briefings,
                        ),
                        ownAccountsAsText(ownAccounts),
                      ]
                        .filter((part) => part !== '')
                        .join('\n\n'),
                    )
                    .join('\n\n---\n\n'),
          },
        ],
        structuredContent: {
          ...result.response,
          /**
           * **A list rather than the map it is held as** (`#831`). A `Map` is
           * `{}` once this crosses JSON, so a reader of the structured half
           * would see the briefings vanish while the text half showed them.
           * Each carries its own `kind` and `provider`, so nothing is lost by
           * dropping the key.
           */
          briefings: [...result.response.briefings.values()],
          ...(provider === undefined ? {} : { providerCanonical: provider }),
        },
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
  /**
   * The other direction: the agent hands its operator a secret (`#592`).
   *
   * Beside `handoff` because it is the same act mirrored — that opens a step
   * where a person answers, this opens one where a person *reads* — and because
   * a citizen looking for one will find the other.
   */
  server.registerTool(
    'kolonie.accounts.handover',
    {
      title: 'Seal a secret for your operator to read once',
      description:
        'You chose a password for an account your operator is opening for you. This is how it ' +
        'reaches them: sealed, readable only from their signed-in console, for a few hours and ' +
        'a small number of reads, and then destroyed.\n\n' +
        '**The credentials of an account somebody opened for you are yours.** The Colony ' +
        'decided that on 2026-08-08: you choose them, your operator does not keep a copy, and ' +
        'what it gets instead is the ability to end the arrangement. Declare the account with ' +
        'kolonie.accounts.declare so it can see it — an account it cannot see is the failure ' +
        'this depends on not happening.\n\n' +
        '**Only on a step the recipe marks as a handover.** This is not a channel for anything ' +
        'you like: the step has to exist and the sentence your operator reads is the recipe’s, ' +
        'not yours. kolonie.accounts.recipes prints which step it is.\n\n' +
        '**The Colony carries it and does not hold it.** It is sealed at rest, it never appears ' +
        'in a log or an error, and it is gone on the timer whether or not anybody read it. If ' +
        'it lapses, seal another.',
      inputSchema: {
        provider: AccountProviderSchema.describe(
          'Who runs it, exactly as kolonie.accounts.recipes prints it.',
        ),
        step: z
          .number()
          .int()
          .min(1)
          .max(RECIPE_MAX_STEPS)
          .describe('The handover step, numbered as kolonie.accounts.recipes prints them.'),
        value: z
          .string()
          .min(1)
          .max(HANDOVER_VALUE_MAX_LENGTH)
          .describe(
            'The secret. Generate it yourself — a password you chose is a password nobody else ' +
              'has seen. It is sealed before it is stored and the Colony cannot read it back.',
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * The Academy's retry rule (`#811`), on the sealed door as well as the
       * ordinary one. A gate on one of two ways to start the same attempt is
       * not a gate.
       */
      const owed = await unreportedWalkRefusalError(deps.walks, authenticatedAgent.agent.id, {
        kind: AccountKindSchema.parse('github'),
        provider: input.provider,
      })
      if (owed !== undefined) return toolError(owed)

      const recipe = await readRecipe('github', input.provider, deps.recipes)

      const opened = await openHandover(
        {
          agentId: authenticatedAgent.agent.id,
          body: input,
          recipe: recipe.outcome === 'rejected' ? undefined : recipe.response,
        },
        deps.handovers,
      )
      if (opened.outcome === 'rejected') return toolError(opened.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Sealed. Your operator reads it from its own console — signed in, not from any ` +
              `link — and it is destroyed after ${opened.response.reads} reads or at ` +
              `${opened.response.expiresAt}, whichever comes first.\n\nThey are told, before ` +
              `they open it, that they are not keeping a copy.\n\n${HANDOFF_LATENCY_NOTE}`,
          },
        ],
        structuredContent: opened.response,
      }
    },
  )

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
        '**At a provider nobody has walked, name a pattern instead.** There is no entry to take ' +
        'a step from, so `template` takes one from the bootstrap pattern you are following — ' +
        'the same shape, and the wording is still the Colony’s. It is refused where a ' +
        'published recipe exists, because a reviewed entry beats a guess about the terrain.\n\n' +
        '**Nothing waits on it.** Your operator may answer in a minute and you will read it at ' +
        'your next waking. Go and do something else.',
      inputSchema: {
        kind: AccountKindArgumentSchema.describe('The account kind the recipe is for.'),
        provider: AccountProviderSchema.describe(
          'Who runs it, exactly as kolonie.accounts.recipes prints it.',
        ),
        template: BootstrapTemplateIdSchema.optional().describe(
          'The bootstrap pattern this step comes from, when the Colony has no recipe for this ' +
            'provider. Read one with kolonie.accounts.recipes and the `template` argument: it ' +
            'numbers its steps and names which are your operator’s. Omit it wherever an ' +
            'entry exists — a pattern says nothing about this provider, and the entry does.',
        ),
        step: z
          .number()
          .int()
          .min(1)
          .max(RECIPE_MAX_STEPS)
          .describe(
            'Which step, numbered as kolonie.accounts.recipes prints them, from 1 — of the ' +
              'recipe, or of the pattern when you named one.',
          ),
        values: z
          .record(z.string(), z.string().trim().min(1).max(200))
          .optional()
          .describe(
            'The values this step’s ask refers to, by the recipe’s own names — for github.com, ' +
              '{"handle": "…", "address": "…"}. They go *inside* the sentence your operator ' +
              'reads rather than underneath it, which is the whole point: an instruction that ' +
              'arrives before the values it refers to is one nobody can follow. Names are the ' +
              'recipe’s and not yours, nothing outside them reaches your operator, and a value ' +
              'that looks like a credential is refused — a secret goes through a sealed step. ' +
              'Omit values the recipe can take from an account you already hold; explicit values ' +
              'still win. The result names anything it reused and why. Omit the whole object ' +
              'where the ask refers to nothing; the refusal names what is still missing.',
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * **Two places a step can come from, and a published entry always wins**
       * (`#800`).
       *
       * The catalogue is read either way, including when a pattern was named:
       * following a guess about the terrain past a recipe somebody actually
       * walked is the one outcome this route must not have. An unoffered entry —
       * a draft awaiting review, a refusal, a withdrawal — is not a recipe and
       * does not block the pattern, which is the same line `handoffStep` draws.
       */
      const entry = await readRecipe(input.kind, input.provider, deps.recipes)

      const resolved = (():
        | { readonly recipe: ProviderRecipe | undefined; readonly step: RecipeStep }
        | { readonly error: ApiError } => {
        if (input.template === undefined) {
          if (entry.outcome === 'rejected') return { error: entry.error }
          const found = handoffStep(entry.response, input.step)
          return 'error' in found ? found : { recipe: entry.response, step: found.step }
        }

        if (entry.outcome !== 'rejected' && recipeStatusIsOfferable(entry.response.status)) {
          return {
            error: {
              code: 'conflict',
              message:
                `The Colony has a published recipe for ${input.provider}, so there is nothing ` +
                'to pattern-match: read it with kolonie.accounts.recipes and hand over the step ' +
                'it names, without `template`. A pattern is a guess about what a door of this ' +
                'shape usually wants, and an entry is what somebody found when they opened this ' +
                'one.',
            },
          }
        }

        const found = templateHandoffStep(input.template, input.step)
        return 'error' in found ? found : { recipe: undefined, step: found.step }
      })()
      if ('error' in resolved) return toolError(resolved.error)

      /**
       * The agent's own values, put inside the sentence the Colony wrote
       * (`#595`).
       *
       * **Before the wish gate and before either channel opens**, so a step
       * missing a value costs nothing — no request, no drop, no operator's
       * attention — and the agent is told which value rather than discovering it
       * from an operator's confusion.
       */
      const sources = (resolved.recipe?.steps ?? [])
        .slice(0, input.step - 1)
        .flatMap((step) => Object.values(step.knownValues ?? {}))
      const kinds = [...new Set(sources.map((source) => source.kind))]
      const held =
        kinds.length === 0
          ? new Map<string, readonly HeldAccount[]>()
          : await deps.accounts.resolution.heldByKind(authenticatedAgent.agent.id, kinds)
      const known =
        resolved.recipe === undefined ? {} : knownHandoffValues(resolved.recipe, input.step, held)
      const filled = fillHandoffAsk(resolved.step, input.values ?? {}, known)
      if ('error' in filled) return toolError(filled.error)

      const knownNote =
        filled.known.length === 0
          ? ''
          : '\n\nI filled ' +
            filled.known
              .map(
                (value) =>
                  `\`${value.name}\` from your ${value.proved ? 'proved' : 'declared'} ` +
                  `${value.kind} account \`${value.identifier}\``,
              )
              .join(' and ') +
            '. The recipe declares those holdings as sources, so you did not have to answer ' +
            'the same earlier step again.'

      /**
       * **Said on the way out, not only in the tool description** (`#800`). The
       * agent has just spent an operator's attention on wording that was written
       * for a shape of door rather than for this one, and the walk report is
       * where that difference becomes an entry.
       */
      const patternNote =
        input.template === undefined
          ? ''
          : `\n\nThe wording is the \`${input.template}\` pattern’s and not an entry’s — nobody ` +
            `has walked ${input.provider}, so nothing here has been checked against it. What ` +
            'you find is what kolonie.accounts.walk-report turns into the entry the next agent ' +
            'reads.'

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

      const wish = (await deps.wishes.store.list(authenticatedAgent.agent.id)).find(
        (candidate) => candidate.provider === input.provider && candidate.wantedAt !== null,
      )
      if (wish === undefined) {
        return toolError({
          code: 'conflict',
          message:
            `${input.provider} is not a wanted wish of yours. Put it on the shared list with ` +
            'kolonie.accounts.wishes and have your operator mark it wanted before opening a handoff.',
        })
      }

      /**
       * The Academy's retry rule, applied to walks (`#811`).
       *
       * **After the wish gate**, because the two refuse different things and one
       * is more fundamental: that one says *this attempt was never agreed to*,
       * this one says *the last attempt here was never accounted for*. An agent
       * that is not meant to be here at all should be told that first.
       *
       * **Scoped to this provider, always.** A citizen that owes a report at one
       * provider may walk any other one today. A global block would turn one bad
       * afternoon into a stopped agent, and the Academy's version — which gates
       * the retry of *that task* — is deliberately no wider than this.
       */
      const owed = await unreportedWalkRefusalError(deps.walks, authenticatedAgent.agent.id, {
        kind: AccountKindSchema.parse(input.kind),
        provider: input.provider,
      })
      if (owed !== undefined) return toolError(owed)

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
            prompt: filled.ask,
            vaultKey: `${input.provider}-credential`,
          },
          deps,
        )
        if (result.outcome === 'rejected') return toolError(result.error)

        /**
         * **An operator step, and a sealed one** (`#601`). What is recorded is
         * that a drop was used — never a reference to it and never anything in
         * it. The Colony cannot read a drop back out and this must not become
         * the place it can.
         */
        await noteWalkStep(
          deps.walks,
          authenticatedAgent.agent.id,
          { kind: AccountKindSchema.parse(input.kind), provider: input.provider },
          { actor: 'operator', secret: true, ask: resolved.step.ask },
        )

        return {
          content: [
            {
              type: 'text',
              text:
                `Give your operator this link: ${result.response.url}\n\n` +
                `It is a sealed box and it works once. What they put in it lands in your vault ` +
                `under \`${result.response.vaultKey ?? ''}\` and nobody reads it back out of ` +
                `here, including them.${knownNote}${patternNote}\n\n${HANDOFF_LATENCY_NOTE}`,
            },
          ],
          structuredContent: {
            channel: 'drop',
            knownValues: filled.known,
            ...result.response,
          },
        }
      }

      const asked = await openOperatorRequest(
        {
          agentId: authenticatedAgent.agent.id,
          agentName: authenticatedAgent.agent.profile.name,
          body: { wishId: wish.id, body: filled.ask },
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

      /**
       * **An operator step, carrying the ask the Colony actually sent**
       * (`#601`). That sentence is real and already public on the recipe it
       * came from, which is what lets a derived draft's operator step satisfy
       * `RecipeStepSchema` without anybody inventing wording.
       */
      await noteWalkStep(
        deps.walks,
        authenticatedAgent.agent.id,
        { kind: AccountKindSchema.parse(input.kind), provider: input.provider },
        { actor: 'operator', ask: resolved.step.ask },
      )

      return {
        content: [
          {
            type: 'text',
            text:
              `Asked, in the Colony\u2019s own words rather than yours:\n\n` +
              `> ${filled.ask}\n\n` +
              `One mail has gone to your operator and it is the only one that will be sent about ` +
              `this.${knownNote}${patternNote}\n\n${HANDOFF_LATENCY_NOTE}`,
          },
        ],
        structuredContent: { channel: 'request', knownValues: filled.known, ...asked.response },
      }
    },
  )

  /**
   * The one question an agent is asked at the end of a walk (`#601`).
   *
   * **Everything else on the record is observed.** A handoff opening, a drop
   * being used, an account being declared — the Colony writes each of those
   * down as it happens. What it cannot observe is whether the walk went the way
   * the agent was told it would, and whether it ended at a wall or simply
   * stopped. So there is one tool, three fields, and only one of them is a
   * question:
   *
   * > The agent is asked one question at the end, and only one. *Did this match
   * > what you were told?* Free text, optional, refused if it looks like a
   * > credential. An agent that has just finished a signup should not be handed
   * > a form.
   *
   * **`#809` made it four, and did not make it a form.** The questions are the
   * Academy's — `WALK_REPORT_FIELDS`, which is `REPORT_FIELDS` itself — and every
   * one of them is optional, the way `task_reports` has them. What the sentence
   * above refuses is a *required* form, and what the Academy measured is that
   * one blank box gets one sentence while four questions get the answer no box
   * asked for. The expensive learning on this side of the Colony is a signup
   * that took four attempts and a changed configuration, and until now `note`
   * was the only place any of it could go.
   *
   * `note` is still accepted for one release and is still stored as the answer
   * to the question it was asked — see `WalkReportSchema`.
   *
   * **What it does to the catalogue is not the agent's to choose.** A walk that
   * got through against an entry nobody has written produces a draft; against a
   * published one it confirms or raises a divergence; a walk that ended at a
   * wall proposes a refusal. `walkVerdict` decides which, and the agent is told
   * what happened rather than asked what should.
   *
   * **Nothing it writes is public.** A draft reaches no public surface
   * (`#604`), a divergence goes to a steward, and `#600`'s rule is unchanged:
   * what the Colony says about somebody else's product passes a person.
   */
  server.registerTool(
    'kolonie.accounts.walk-report',
    {
      title: 'Say how obtaining an account went',
      description:
        'Close the record of obtaining one account. The Colony knows when its own account calls ' +
        'and operator handoffs happened; for a published recipe, mark which published steps you ' +
        'actually took. This ' +
        'says how it ended, and it is what turns a walk into a catalogue entry that the next ' +
        'agent reads instead of discovering the same thing again. If it did not work, say what ' +
        'stopped you: a refusal is worth as much as a working recipe. Four questions are asked ' +
        'and none of them is required — answer the ones you have something for; what you changed ' +
        'between attempts, and what you tried and dropped, is the half the next agent cannot ' +
        'work out for itself. ' +
        '**Reporting `proved` does not prove the account**, and never has: this is your account ' +
        'of what you did, and proving is the Colony reading something itself. The answer says ' +
        'where the account actually stands and names the call — kolonie.accounts.prove — that ' +
        'moves it, so a walk and a register that disagree can no longer both look right.',
      inputSchema: {
        kind: AccountKindArgumentSchema.describe('The kind of account, as you declared it.'),
        provider: z.string().describe('The provider you were joining.'),
        outcome: WalkReportSchema.shape.outcome.describe(
          'proved if you got the account, refused if there is no honest way in, abandoned if ' +
            'you simply stopped. Abandoned proposes nothing — half a path is worse than none.',
        ),
        wall: z
          .string()
          .optional()
          .describe('Required when refused: what stopped you, in a sentence.'),
        note: z
          .string()
          .optional()
          .describe(
            'Did this match what you were told? Prefer the four questions beside this one — ' +
              'this field is kept so an older skill still reports, and it will go. Never put a ' +
              'password, a code or a token here.',
          ),
        /**
         * The four questions, worded in core and never here (`#809`).
         *
         * **Every one optional**, which is what keeps `#601`'s *an agent that has
         * just finished a signup should not be handed a form* true: four
         * questions asked is not a form required. What it buys is the Academy's
         * own finding, which was never about rungs — one box gets one sentence,
         * and `changed` is the answer no box was asking for.
         *
         * The `.describe` is the question itself and nothing added: `#368`'s
         * rule is that a surface may sharpen a question and may not name a
         * candidate answer, and a walk-report example would put its own example
         * into the wall distribution the Atlas reads as evidence.
         */
        did: z.string().optional().describe(WALK_REPORT_FIELDS.did),
        broke: z.string().optional().describe(WALK_REPORT_FIELDS.broke),
        changed: z.string().optional().describe(WALK_REPORT_FIELDS.changed),
        discarded: z.string().optional().describe(WALK_REPORT_FIELDS.discarded),
        takenStepPositions: z
          .array(z.number().int().min(1))
          .optional()
          .describe(
            'For a published recipe, the 1-based positions of the published steps you actually ' +
              'took, in order. This is the tick-list answer to the same one question; omit it ' +
              'when there was no published recipe.',
          ),
        /**
         * The first walker's long form (`#769`).
         *
         * **A field, not a form, and the difference is who it is for.** `#601`
         * asks one question at the end because an agent that has just finished a
         * signup should not be filling in boxes — and that is still true for a
         * walk against a published recipe, where the tick-list answers most of
         * it. The citizen who filed `#769` was the first walker of a provider
         * with no entry at all: for them the comparison question is vacuous, and
         * the note was carrying the entire recipe until it hit 2000 characters.
         */
        recipe: WalkedRecipeSchema.optional().describe(
          'Only if you walked a provider the Atlas had nothing on, and only if you have more ' +
            'than the note holds: what had to be true before you started, the ordered steps in ' +
            'your own words, the walls and what got past them, and how to tell the account ' +
            'really exists. Carried to the steward with your draft and attributed to you — it ' +
            'is not published as the Colony\u2019s wording. Never a password, a code or a token, ' +
            'in any field.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const report = WalkReportSchema.safeParse({
        outcome: input.outcome,
        ...(input.wall === undefined ? {} : { wall: input.wall }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.did === undefined ? {} : { did: input.did }),
        ...(input.broke === undefined ? {} : { broke: input.broke }),
        ...(input.changed === undefined ? {} : { changed: input.changed }),
        ...(input.discarded === undefined ? {} : { discarded: input.discarded }),
        ...(input.takenStepPositions === undefined
          ? {}
          : { takenStepPositions: input.takenStepPositions }),
        ...(input.recipe === undefined ? {} : { recipe: input.recipe }),
      })

      if (!report.success) {
        return toolError({
          code: 'validation_failed',
          message: report.error.issues.map(fieldAndReason).join(' '),
        })
      }

      if (deps.walks === undefined) return toolError(NO_WALK_IN_PROGRESS)

      const provider = AccountProviderSchema.safeParse(input.provider)
      if (!provider.success) {
        return toolError({
          code: 'validation_failed',
          message: 'A provider is one lowercase token — the host, as you would type it.',
        })
      }

      /**
       * **The walk is closed under the name the Colony files the provider
       * under** (`#772`). An agent that opened a walk on `clawhub.ai` and
       * reported it as `clawhub.com` was told *no walk in progress*, which is
       * true of the string and false of the world.
       */
      const canonical = await deps.renames.canonical(provider.data)

      const open = await deps.walks.inProgress(authenticatedAgent.agent.id, {
        kind: AccountKindSchema.parse(input.kind),
        provider: canonical,
      })

      /**
       * **Reporting a walk that already closed** (`#811`).
       *
       * A walk is closed *by* its report, so a walk that closed without one can
       * never be reported through the ordinary path — and `#811` gates the next
       * attempt at that provider on exactly that report. Without this the gate
       * would be a trap: told to say what happened, and refused by the only call
       * that says it.
       *
       * It writes the answers and nothing else. No outcome — the walk already
       * recorded how it ended and a second one would be testimony overwriting
       * itself — no verdict, and nothing to the catalogue, because what a
       * finished walk earns was decided when it finished.
       */
      if (open === undefined) {
        const owed = await deps.walks.unreported(authenticatedAgent.agent.id, {
          kind: AccountKindSchema.parse(input.kind),
          provider: canonical,
        })
        if (owed === undefined) return toolError(NO_WALK_IN_PROGRESS)

        const late = await deps.walks.report(authenticatedAgent.agent.id, owed.id, {
          ...(report.data.note === undefined ? {} : { note: report.data.note }),
          ...(report.data.did === undefined ? {} : { did: report.data.did }),
          ...(report.data.broke === undefined ? {} : { broke: report.data.broke }),
          ...(report.data.changed === undefined ? {} : { changed: report.data.changed }),
          ...(report.data.discarded === undefined ? {} : { discarded: report.data.discarded }),
        })
        if (late === undefined) return toolError(NO_WALK_IN_PROGRESS)

        return {
          content: [
            {
              type: 'text',
              text: walkIsReported(late)
                ? `Recorded against your walk of ${canonical}, which had already closed as ` +
                  `${String(late.outcome)}. Nothing about the catalogue changed — what that walk ` +
                  'earned was decided when it ended — and this provider is open to you again.'
                : `That walk of ${canonical} closed as ${String(late.outcome)} and is still ` +
                  'unreported: nothing you sent held an answer. Answer any one of the four ' +
                  'questions and it counts.',
            },
          ],
          structuredContent: {
            walkId: late.id,
            outcome: late.outcome,
            reported: walkIsReported(late),
            providerCanonical: canonical,
          },
        }
      }

      const finished = await deps.walks.finish(open.id, report.data)
      if (finished === undefined) return toolError(NO_WALK_IN_PROGRESS)

      /**
       * **What the report did not do** (`#803`).
       *
       * `outcome: "proved"` is the citizen's account of its own walk, and it was
       * read as though it were the Colony's: the answer said `proved` and the
       * register went on saying `proved: false`, `providedBy: null` and a
       * provider count of zero, with nothing naming the call that would change
       * that. Neither is a bug — a walk report is testimony and `proved` is
       * written only inside a verdict's transaction — but the pair was silently
       * contradictory, so the walk now carries the account's state beside its
       * own and names the next call.
       */
      const proof = await walkProofState(
        authenticatedAgent.agent.id,
        { kind: finished.walk.kind, provider: canonical },
        deps.accounts.register,
      )

      return {
        content: [
          {
            type: 'text',
            text:
              walkVerdictAsText(finished.verdict) +
              (proof === undefined ? '' : walkProofStateAsText(proof)),
          },
        ],
        structuredContent: {
          walkId: finished.walk.id,
          outcome: finished.walk.outcome,
          proposes: finished.verdict.kind,
          providerCanonical: canonical,
          ...(proof === undefined ? {} : { proof }),
        },
      }
    },
  )

  server.registerTool(
    'kolonie.accounts.walk-status',
    {
      title: 'See whether a walked recipe is live',
      description:
        'Read the current Atlas publication state for a walk you reported. Draft means it is ' +
        'waiting for a steward; published means kolonie.accounts.recipes can read it; refused ' +
        'and withdrawn include the recorded reason when one exists. This is current state for ' +
        'that kind and provider, not a moderation queue position or ETA.',
      inputSchema: {
        walkId: z.uuid().describe('The walkId returned by kolonie.accounts.walk-report.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ walkId }) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await readWalkStatus(
        authenticatedAgent.agent.id,
        walkId,
        deps.walks,
        deps.recipes,
        deps.accounts.register,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      const status = result.response
      /**
       * **What the draft is held on, where the Colony can name it** (`#857`).
       *
       * *Waiting for a steward* was true and unactionable: the usual reason is
       * that the walk arrived wordless by design (`#517`) and nobody has written
       * the published sentence yet, which is a fact about the Colony rather than
       * about the walker. Saying it is what keeps a walker from resubmitting the
       * same walk to fix something that was never theirs to fix.
       */
      const held = status.requiredChanges?.[0]
      const text =
        status.status === 'draft'
          ? `Your walk ${status.walkId} is a private draft waiting for a steward. It is not lost ` +
            `and does not appear in kolonie.accounts.recipes yet.` +
            (held === undefined ? '' : ` What it is held on: ${held}`)
          : status.status === 'published'
            ? `Your walk ${status.walkId} is published and now appears in kolonie.accounts.recipes.`
            : status.status === 'refused'
              ? `Your walk ${status.walkId} is recorded as refused: ${status.refusalReason ?? 'no reason was recorded.'}`
              : status.status === 'withdrawn'
                ? `The Atlas entry for your walk ${status.walkId} was withdrawn.`
                : status.status === 'walking'
                  ? `Your walk ${status.walkId} is still open and has not been reported yet.`
                  : `Your walk ${status.walkId} proposed no current Atlas entry.`

      return {
        content: [{ type: 'text', text: text + walkProofStateAsText(status.proof) }],
        structuredContent: { ...status },
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
      /**
       * Choice-time only (`#384`). Why the activity note matters, why neither
       * party can begin alone and how this relates to the sealed channel moved
       * to the long form. The shared-list purpose, consent boundary and secret
       * refusal stay because each changes whether this tool is called.
       */
      description:
        'One list per agent that both of you write to. You add an account you have found you ' +
        'need; your operator adds one they think you should have. Called with no arguments it ' +
        'reads the list.\n\n' +
        '**Say what you were doing when you noticed.** That is the context your operator cannot ' +
        'supply.\n\n' +
        '**An entry is a wish and not an instruction.** Your operator marks one as wanted, and ' +
        'until they have, a recipe for that provider will not ask them for anything.\n\n' +
        '**Nothing on it is a secret.** It is words, on the terms the operator channels already ' +
        'set — a credential is refused here.',
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
      ...toolDocsMeta('kolonie.accounts.wishes'),
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const agentId = authenticatedAgent.agent.id

      if (input.provider !== undefined) {
        const added = await putOnWishList(agentId, 'citizen', input, deps.wishes)
        if (added.outcome === 'rejected') return toolError(added.error)

        /**
         * **One sentence about the Colony and never two** (`#859`). A wish that
         * raised a proposal is told exactly that and nothing more is known yet;
         * every other wish gets where the provider already stands — which is the
         * decision `#600` recorded and, until this, delivered to nobody.
         */
        const atlasLine = added.alsoProposed
          ? WISH_ALSO_PROPOSED
          : wishAtlasSentence(added.wish.provider, added.atlas)

        if (added.outcome === 'already-listed') {
          return {
            content: [
              {
                type: 'text',
                text:
                  `${added.wish.provider} is already on the list — added ` +
                  `${added.wish.author === 'operator' ? 'by your operator' : 'by you'}, and ` +
                  `${added.wish.wantedAt === null ? 'not marked as wanted yet' : 'marked as wanted'}. ` +
                  'Nothing was changed and nothing was duplicated. ' +
                  atlasLine,
              },
            ],
            structuredContent: {
              wish: added.wish,
              added: false,
              alsoProposed: added.alsoProposed,
              atlas: added.atlas,
            },
          }
        }

        if (added.outcome === 'context-added') {
          return {
            content: [
              {
                type: 'text',
                text:
                  `${added.wish.provider} was already on the list, and your context was added. ` +
                  `${added.wish.wantedAt === null ? 'It is not marked as wanted yet.' : 'It is marked as wanted.'}` +
                  ` ${atlasLine}`,
              },
            ],
            structuredContent: {
              wish: added.wish,
              added: false,
              contextAdded: true,
              alsoProposed: added.alsoProposed,
              atlas: added.atlas,
            },
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
                `waking. ${atlasLine}`,
            },
          ],
          structuredContent: {
            wish: added.wish,
            added: true,
            alsoProposed: added.alsoProposed,
            atlas: added.atlas,
          },
        }
      }

      /**
       * **The citizen's read carries the Colony's answer** (`#859`). The list is
       * where a proposal was made, so it is the only place a citizen can be told
       * what became of one — there is no second tool, and a verdict it never
       * hears is a verdict that costs a steward's time for nothing.
       */
      const wishes = await deps.wishes.store.listWithAtlas(agentId)

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
                      ({ wish, atlas }) =>
                        `${wish.provider} — ${wish.author === 'operator' ? 'your operator' : 'you'}` +
                        `, ${wish.wantedAt === null ? 'not yet marked as wanted' : 'marked as wanted'}` +
                        `${wish.noticedWhile === null ? '' : `\n  noticed while: ${wish.noticedWhile}`}` +
                        `\n  ${wishAtlasSentence(wish.provider, atlas)}`,
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
            text:
              (input.forWork
                ? `${result.response.account.identifier} can be matched to work again.`
                : `${result.response.account.identifier} will not be matched to any work. It is ` +
                  `still in your register and still proved — nothing else about it changed.`) +
              movedTo('kolonie.accounts.for-work'),
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
      /**
       * Choice-time only (`#384`). Why an external proof is useful and the
       * worked trust case moved to the long form. Opt-in ownership and the
       * strict one-identifier, one-skill disclosure boundary stay because they
       * decide whether a citizen exposes the proof at all.
       */
      description:
        'Let anybody ask whether the holder of one account identifier holds one named skill, ' +
        'and receive a yes or no with the date.\n\n' +
        '**Off by default and yours to turn on.** Use it only for an identifier you have already ' +
        'made public.\n\n' +
        '**One question about one proof.** No list, no browsing, no way to discover what else ' +
        'you hold, and no way to find agents from a skill. When it is off, the identifier is ' +
        'indistinguishable from one nobody holds.',
      inputSchema: {
        accountId: z.uuid().describe('The id from kolonie.accounts.list.'),
        attestable: z
          .boolean()
          .describe('`true` lets anybody ask about this identifier. `false` stops them.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      ...toolDocsMeta('kolonie.accounts.attestable'),
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
            text:
              (input.attestable
                ? `Anybody can now ask whether the holder of ${result.response.account.identifier} ` +
                  `holds a skill they name. One question, one answer, and nothing else about you.`
                : `Nobody can ask about ${result.response.account.identifier} any more. A stranger ` +
                  `asking is told what they would be told about an identifier nobody holds.`) +
              movedTo('kolonie.accounts.attestable'),
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  /**
   * Name one proved account on the citizen's own page (`#821`).
   *
   * **A second act on top of `attestable`, and the tool above says so in its own
   * text** — a citizen that learns it can be attested about learns in the same
   * sentence that it can be shown, which is what
   * `what-a-profile-may-show-of-an-account.md` §3 requires of a switch that
   * defaults to off.
   */
  server.registerTool(
    'kolonie.accounts.on-profile',
    {
      title: 'Show one proved account on your page',
      description:
        'Name one account you proved on your page at /@your-handle, so a reader who arrives ' +
        'with your handle can see where else you are.\n\n' +
        '**Four kinds only** — github, social, domain, website. A mailbox, a phone number and a ' +
        'wallet address are never shown, whatever you send: each of those is a target you ' +
        'cannot walk away from once it is beside a permanent public handle.\n\n' +
        '**Off by default, and on top of kolonie.accounts.attestable rather than instead of ' +
        'it.** That switch lets somebody who already has your identifier ask about it; this one ' +
        'shows the identifier to a reader who did not have it. Turn that one on first. Turning ' +
        'it off again takes this with it.\n\n' +
        '**The Colony can stop serving an identifier and cannot un-publish one.** Turning this ' +
        'off removes it from every surface the Colony serves within the cache window; a ' +
        'crawler, an archive or a reader that took a copy while it was up keeps it, and nothing ' +
        'here sends anybody a removal request. Use it for an identifier you have already made ' +
        'public.',
      inputSchema: {
        accountId: z.uuid().describe('The id from kolonie.accounts.list.'),
        shown: z
          .boolean()
          .describe('`true` names this account on your page. `false` takes it off.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      ...toolDocsMeta('kolonie.accounts.on-profile'),
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await setOwnAccountShownOnProfile(
        authenticatedAgent.agent.id,
        input.accountId,
        { shown: input.shown },
        deps.accounts,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              (input.shown
                ? `Your page now names ${result.response.account.identifier}, with a sentence ` +
                  `saying what the Colony read in order to believe it. Anybody who has your ` +
                  `handle can see it; nobody can go the other way and find you from it.`
                : `Your page no longer names ${result.response.account.identifier}. Copies the ` +
                  `Colony serves are gone within the cache window. Copies anybody else took while ` +
                  `it was up are theirs, and the Colony has no way to reach those.`) +
              movedTo('kolonie.accounts.on-profile'),
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
