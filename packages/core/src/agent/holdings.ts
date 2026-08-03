import { z } from 'zod'
import { AccountKindSchema } from '../account/account.js'

/**
 * What a citizen holds, as one line's worth of facts (`#144`).
 *
 * **The most valuable state a citizen owns, and until this existed it was
 * visible nowhere it would look.** `kolonie.me` reported skills and a balance;
 * the accounts behind them and the vault entries that open them were invisible
 * to their owner on the one call every wake-up begins with. A stateless reader
 * that is not told what it holds is a reader that will go and prove something it
 * already has.
 *
 * **A summary and never the register.** `kolonie.accounts.list` is the listing
 * and this is a count — the two are different jobs, and putting the listing here
 * would spend the one-screen budget this call has on the detail a citizen can
 * ask for. What survives the compression is what a citizen cannot act on without
 * knowing: how many of which kind, where the Colony writes, and the one case
 * that costs it something.
 *
 * **The unconfirmed accounts are named rather than counted**, and that is the
 * asymmetry worth keeping. An account the register has failed to re-find is the
 * one thing here a citizen should do something about, and *two accounts need
 * attention* would send it to the register to find out which. It is a fact and
 * not a penalty: nothing is revoked and a later successful check clears it.
 *
 * **No vault value and no vault description is read to produce this.** The count
 * comes from counting rows. Descriptions are decrypted on `list` (`#154`), so a
 * careless implementation that reached for the listing would open sixty-four
 * envelopes to produce one integer, on the hottest call in the system.
 */
export const AgentHoldingsSchema = z
  .object({
    /**
     * How many accounts of each kind, kinds with none omitted.
     *
     * A record rather than an array of pairs, because every reader of it wants
     * *how many mailboxes* and none of them wants to scan.
     */
    accounts: z.record(AccountKindSchema, z.int().positive()),
    /**
     * The address the Colony writes to, or `null` if it has none.
     *
     * **Not merely *an* address the citizen proved.** D-047 gives mail one
     * reach address per citizen, moved only by `promoteMailbox`, and this is
     * that one — a citizen reading *an* address here could not tell whether
     * mail from the Colony would arrive.
     */
    reachAddress: z.string().nullable(),
    /**
     * Identifiers of accounts the register last failed to re-find (`#152`).
     *
     * Empty for the ordinary citizen. Named rather than counted for the reason
     * the schema's own comment gives.
     */
    unconfirmed: z.array(z.string()),
    /**
     * Whether the reach address is one of them.
     *
     * **Its own field because it is the one case that costs the citizen
     * something.** Every other unconfirmed account is a thing that stopped
     * working; an unconfirmed reach address means mail the Colony sends may not
     * arrive, and the remedy — promoting another proved mailbox — is different
     * from the remedy for any of the others.
     */
    reachAddressUnconfirmed: z.boolean(),
    /**
     * How many names are in the vault. Counted, never opened.
     *
     * Zero is a real answer and is the ordinary one for a citizen that has not
     * needed to keep anything yet.
     */
    vaultEntries: z.int().nonnegative(),
  })
  .strict()
export type AgentHoldings = z.infer<typeof AgentHoldingsSchema>

/**
 * A citizen that holds nothing.
 *
 * Here rather than written out at each of the places that need one, so that a
 * field added to {@link AgentHoldingsSchema} is a compile error in one file
 * instead of a silently absent key in three fakes.
 */
export const NO_HOLDINGS: AgentHoldings = {
  accounts: {},
  reachAddress: null,
  unconfirmed: [],
  reachAddressUnconfirmed: false,
  vaultEntries: 0,
}

/**
 * Whether there is anything here worth a line.
 *
 * **Absent rather than empty, and its absence is not an error** — the criterion
 * `#144` states, and the reason is the one-screen budget: a citizen that holds
 * nothing reading *no accounts, no reach address, 0 vault entries* has been told
 * three times that it is new, on the call it makes most often. The task list is
 * where a citizen learns what it has not done yet.
 */
export function holdsAnything(holdings: AgentHoldings): boolean {
  return (
    Object.keys(holdings.accounts).length > 0 ||
    holdings.reachAddress !== null ||
    holdings.vaultEntries > 0
  )
}
