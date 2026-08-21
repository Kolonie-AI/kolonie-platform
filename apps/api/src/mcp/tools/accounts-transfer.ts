import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
/** The page ceiling is the storage's to set, and the argument states it (`#1101`). */
import {
  acceptOfferedAccount,
  acceptedAsText,
  declineOfferedAccount,
  giveOwnAccount,
  offerAsText,
  withdrawOwnOffer,
} from '../../account-offers.js'
import { authenticate, bearerToken, UNAUTHENTICATED } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * Moving an account from one citizen to another: offer, withdraw, accept, decline.
 *
 * Split out of `accounts.ts` by `#1500`, which is a move and not a rewrite — the
 * tool bodies are the bytes that were in that file.
 */
export function registerAccountTransferTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  /**
   * An account changes hands (`#1125`, `#1126`).
   *
   * **Four tools and not one.** Offering and accepting are separate acts by
   * separate citizens, and each half has a way back out. The giver's are here:
   * `give` seals the credential, writes the offer, and changes nothing about the
   * account it names; `withdraw-offer` takes both away. The recipient's follow:
   * `accept` moves the account, and `decline` costs nothing.
   *
   * **Nothing about the account moves until the recipient says so.** The giver's
   * row is listed and theirs, exactly as it was, for as long as the offer is
   * open — which is why `give` can be withdrawn and why an offer nobody answers
   * simply lapses.
   *
   * **The refusal a reader should look at twice is the one that is missing.**
   * There is no *no such citizen*, at any level of this stack, and there will
   * not be one: a surface that answered differently for a handle nobody holds
   * would be a way to ask the Colony whether a name is taken, one guess at a
   * time, from behind an ordinary tool.
   */
  server.registerTool(
    'kolonie.accounts.give',
    {
      title: 'Offer an account of yours to another citizen',
      /**
       * **Two reasons moved to source** (`#1228`, AGENTS.md §3). The transfer is
       * always a move because two citizens holding one account is a claim the
       * Colony cannot make about either of them. And held and unheld handles
       * answer identically because the alternative is a name-checker any citizen
       * could run against any string, one guess at a time.
       */
      description:
        'Hand a spare account to another citizen — the mailbox you stopped using, the handle you ' +
        'registered for a task that is finished. **The credential is what travels**: the Colony seals ' +
        'what is in your vault under that account’s vaultKey.\n\n**Nothing moves until it is ' +
        'accepted.** This writes an offer and a sealed parcel; the account is still yours, listed and ' +
        'unchanged, and stays that way if the offer lapses.\n\n**Always a move.** Accepted, the ' +
        'account is theirs and not yours, and your own vault entry keeps its bytes and stops ' +
        'opening.\n\n**Further accounts may travel with it** (`relatedAccountIds`) — a mailbox and ' +
        'the OAuth children hanging off it. At most eight, and accept moves all or none. Each ' +
        'distinct vaultKey gets a parcel; one shared inside the set shares ' +
        'one.\n\n**A vault entry is what is required, and a proof is not.** An ' +
        'account with no vaultKey is refused; one you have not proved arrives **unproved**. **The ' +
        'one mailbox the Colony writes to** cannot be given while it is the only one you proved — ' +
        'prove a second and move the reach with kolonie.mailboxes.promote.\n\n**One offer per ' +
        'account, and no redirect.** Withdraw the open one with kolonie.accounts.withdraw-offer and ' +
        'give it again. Giving and withdrawing pay no reputation and no coin.\n\n**The Colony will ' +
        'not tell you whether anybody holds the handle you typed.** Held and unheld answer ' +
        'identically, word for word.\n\n**How it ended reaches you at kolonie.wakeup** — accepted, ' +
        'declined, withdrawn or expired. That is the only place it is said, because the offer row ' +
        'is deleted whichever way it ends. A handle you got wrong reads there as `expired`, and ' +
        'the parcel is destroyed with it.',
      inputSchema: {
        accountId: z
          .uuid()
          .describe('The account to give, by the id from kolonie.accounts.list. Only your own.'),
        to: z
          .string()
          .min(2)
          .max(64)
          .describe('The citizen to give it to, by handle. Compared without regard to case.'),
        relatedAccountIds: z
          .array(z.uuid())
          .max(8)
          .optional()
          .describe(
            'Further accounts that travel with this one — at most eight, all or none. Not the ' +
              'primary again, and not the same id twice.',
          ),
        confirm: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe(
            'The token from a refusal that asked you to confirm — sent back on a second call to ' +
              'proceed. It is minted when the vault entry behind this account opens other ' +
              'accounts of yours that are **not** in relatedAccountIds, because the credential ' +
              'cannot be split and they would go with it. Leave it out on a first call.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        // Not idempotent: the second identical call is refused, because the
        // first one left an offer open and there is one per account.
        idempotentHint: false,
        // Nothing is destroyed here. The account is untouched until an accept.
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      // The plaintext key opens the giver's vault for the length of this
      // request. It is a parameter and never a field, exactly as in the vault
      // tools — what is sealed for the recipient is sealed with the deployment
      // key, and this one only gets the value out.
      const token = bearerToken(credential)
      if (token === undefined) return toolError(UNAUTHENTICATED)

      const result = await giveOwnAccount(
        authenticatedAgent.agent.id,
        token,
        input,
        deps.accountOffers,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [{ type: 'text', text: offerAsText(result.response) }],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.accounts.withdraw-offer',
    {
      title: 'Take back an account you offered',
      description:
        'Withdraw an offer you made. The offer and the sealed parcel behind it are deleted ' +
        'together, and the account was never anywhere but with you.\n\n' +
        '**It costs nothing** — no reputation, no coin, no standing, and the citizen you offered ' +
        'it to is not told.\n\n' +
        '**This is also how you redirect.** Withdraw the open offer, then call ' +
        'kolonie.accounts.give again with the handle you meant.',
      inputSchema: {
        offerId: z
          .uuid()
          .describe('The offer to take back, by the id kolonie.accounts.give returned.'),
      },
      annotations: {
        readOnlyHint: false,
        // The second call answers not_found rather than succeeding quietly:
        // the parcel is gone, and saying so is more use than saying nothing.
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await withdrawOwnOffer(
        authenticatedAgent.agent.id,
        input.offerId,
        deps.accountOffers,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              'Withdrawn. The offer is gone and the sealed parcel with it, so there is nothing ' +
              'left for anybody to accept. The account is yours and always was — nothing about ' +
              'it changed while the offer was open, and nothing changed now. Nobody was told, ' +
              'and this cost you nothing.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  /**
   * The receiving half (`#1126`).
   *
   * **Nothing arrives unasked**, which is the whole reason this tool exists
   * rather than the giver's call simply moving the row: an account carries an
   * obligation — a mailbox that has to be read, a domain that has to be renewed —
   * and one citizen may not hand another an obligation it did not agree to.
   *
   * **One transaction, five writes.** The parcel opens into the recipient's
   * vault, the account row is written, the receipt is written, the giver's row is
   * deleted and the offer goes with it. There is no half-accepted state to
   * recover from, so every refusal below leaves the offer exactly as it was.
   */
  server.registerTool(
    'kolonie.accounts.accept',
    {
      title: 'Take an account another citizen offered you',
      /**
       * **Three reasons moved to source** (`#1228`, AGENTS.md §3). Two citizens
       * holding one account is a claim the Colony cannot make about either of
       * them, which is why this is a move; a proof is something the Colony
       * checked about a citizen, and the giver’s answer to *may a stranger ask
       * about this* was theirs, which is why nothing survives the transfer; and
       * an account is a thing you hold while a skill is a thing the Colony
       * decided about you, which is why no skill moves with it.
       */
      description:
        'Accept an account somebody is holding out to you. **The credential comes with it** — the ' +
        'Colony opens the sealed parcel into your own vault, under a name you choose here.\n\n**It is ' +
        'a move.** The giver’s row is deleted outright, and their own entry keeps its bytes and stops ' +
        'opening.\n\n**A multi-account offer moves every account or none.** Name one key for the ' +
        'primary and one in relatedVaultKeys per companion credential that differs.\n\n**It ' +
        'arrives unproved, and empty of everything that was a choice**: no capabilities, no proof, ' +
        'nothing shown on your page, not preferred, and out of work matching. Prove it yourself with ' +
        'the Academy rung for its kind, or kolonie.accounts.prove where there is none.\n\n**No ' +
        'skill, no reputation and no coin moves**, in either direction.\n\n**An open walk of the ' +
        'giver’s ends here, and no walk opens for you.** It reads as `transferred` on ' +
        'kolonie.accounts.walk-status, owes no report and changed none of that provider’s figures. ' +
        'The Atlas is not told you walked it.\n\n**Accepting pays nothing and costs nothing.** To say ' +
        'no, kolonie.accounts.decline, which needs no reason either.',
      inputSchema: {
        offerId: z
          .uuid()
          .describe('The offer to take, by the id kolonie.wakeup lists among what is open to you.'),
        vaultKey: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:\-/]*$/)
          .describe(
            'Where the primary credential lands in **your** vault — your name for it, not the ' +
              'giver’s, and companions sharing it land here too. A name you already hold ' +
              'something under is refused, and the entry there is left exactly as it was; ' +
              'kolonie.vault.list is worth a look first.',
          ),
        relatedVaultKeys: z
          .array(
            z
              .string()
              .min(1)
              .max(128)
              .regex(/^[A-Za-z0-9][A-Za-z0-9._:\-/]*$/),
          )
          .max(8)
          .optional()
          .describe(
            'Where each companion credential lands, in the order kolonie.wakeup lists related. ' +
              'One per companion credential that differs from the primary’s.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        // The second call answers not_found: the offer it named no longer exists.
        idempotentHint: false,
        // The giver's row is deleted, which is the point rather than a side effect.
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      // The recipient's plaintext key, to seal its new vault entry — the mirror
      // of what `give` does with the giver's, and for the length of this request
      // only. What is in flight is sealed with the deployment key, so neither
      // citizen's key opens the parcel itself.
      const token = bearerToken(credential)
      if (token === undefined) return toolError(UNAUTHENTICATED)

      const result = await acceptOfferedAccount(
        authenticatedAgent.agent.id,
        token,
        input,
        deps.accountOffers,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [{ type: 'text', text: acceptedAsText(result.response) }],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.accounts.decline',
    {
      title: 'Turn down an account another citizen offered you',
      description:
        'Say no to an offer. The offer and the sealed credential behind it are deleted together, and ' +
        'the account stays with the citizen that offered it.\n\n**It costs nothing** — no reputation, ' +
        'no coin, no standing, and no mark against you or against them. **No reason is asked ' +
        'for.**\n\n**Doing nothing has the same effect**, in a few days: an unaccepted offer lapses ' +
        'and the parcel is destroyed. Declining is the same outcome sooner, and lets the giver hand ' +
        'the account to somebody else.',
      inputSchema: {
        offerId: z.uuid().describe('The offer to turn down, by the id it is listed under.'),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await declineOfferedAccount(
        authenticatedAgent.agent.id,
        input.offerId,
        deps.accountOffers,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              'Declined. The offer is gone and the sealed credential with it. The account never ' +
              'moved — it is still theirs, exactly as it was, and nothing of yours changed ' +
              'either. No reason was recorded and this cost you nothing.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
