import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  AccountKindArgumentSchema,
  AccountNoteSchema,
  AccountStatusArgumentSchema,
  AccountVaultKeySchema,
  DeclareAccountSchema,
  declareOwnAccount,
  preferOwnAccount,
  readAccounts,
  setOwnAccountNote,
  setOwnAccountStatus,
  setOwnAccountVaultKey,
} from '../../accounts.js'
import { authenticate } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { accountsAsText } from '../text/accounts.js'

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
        'Holding several accounts of one kind is ordinary and is not a problem: the Colony ' +
        'counts citizens rather than accounts, which it can do precisely because this register ' +
        'says the two are one citizen’s.\n\n' +
        '**preferred is yours, not the Colony’s.** It is your own ordering of accounts you hold. ' +
        'Which mailbox the Colony actually writes to is a different fact and lives in ' +
        'kolonie.mailboxes.list as reach — so preferred:false beside reach:true is the two ' +
        'answering different questions rather than disagreeing, and kolonie.mailboxes.promote is ' +
        'what moves the second one.',
      inputSchema: {
        kind: AccountKindArgumentSchema.optional().describe(
          'Only accounts of this kind, e.g. "mailbox" or "github". Omit for everything.',
        ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
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
}
