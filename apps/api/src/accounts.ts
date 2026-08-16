import { z } from 'zod'
import {
  ACCOUNT_NOTE_MAX_LENGTH,
  AccountProviderSchema,
  AccountStatusSchema,
  KNOWN_ACCOUNT_KINDS,
  mayShowOnProfile,
  providerReportAsWalk,
  type Account,
  type AccountKind,
  type AccountStatus,
  type AgentId,
  type ApiError,
  type ProviderTally,
  type ProviderReportTally,
  ProviderReportRequestSchema,
} from '@kolonie-ai/core'
import type { AccountDeclaration, AccountEdit, AccountForgotten, Database } from '@kolonie-ai/db'
import {
  declareAccount,
  forgetDeclaredAccount,
  listAccounts,
  providerTallies,
  providerReportTallies as providerReportTalliesInDatabase,
  provedMailbox,
  setAccountNote,
  setAccountAttestable,
  setAccountForWork,
  setAccountProvider,
  setAccountPreference,
  setAccountShownOnProfile,
  setAccountStatus,
  setAccountVaultKey,
} from '@kolonie-ai/db'
import type { AccountProofDependencies } from './account-proofs.js'
import { latestWalkStatuses, type WalkStatus, type WalkStore } from './account-walks.js'
import type { ProviderRecipes } from './provider-recipes.js'
import { fieldErrors } from './validation.js'

export { ProviderReportRequestSchema } from '@kolonie-ai/core'

/**
 * The register's half of storage, behind a port so `apps/api`'s tests need no
 * PostgreSQL — the same arrangement every other surface in this app has.
 */
export interface AccountRegister {
  list(agentId: AgentId, kind?: AccountKind): Promise<readonly Account[]>
  declare(
    agentId: AgentId,
    input: {
      kind: AccountKind
      identifier: string
      note?: string | null
      vaultKey?: string | null
      provider?: string | null
    },
  ): Promise<AccountDeclaration>
  setStatus(agentId: AgentId, accountId: string, status: AccountStatus): Promise<AccountEdit>
  /**
   * Delete a declared, unproved row outright (`#901`, reachable since `#923`).
   *
   * On the register rather than beside it, because it is the inverse of
   * `declare` and reads the same row: a citizen that wrote down a typo undoes
   * the write it made. Storage refuses a proved row and says so, and that
   * refusal is the whole of the rule — nothing above this decides it again.
   */
  forget(agentId: AgentId, accountId: string): Promise<AccountForgotten>
  setNote(agentId: AgentId, accountId: string, note: string | null): Promise<AccountEdit>
  setProvider(agentId: AgentId, accountId: string, provider: string | null): Promise<AccountEdit>
  /** Take an account out of matching, or put it back (`#523`). */
  setForWork(agentId: AgentId, accountId: string, forWork: boolean): Promise<AccountEdit>
  /** Let a stranger ask about it, or stop them (`#519`). */
  setAttestable(agentId: AgentId, accountId: string, attestable: boolean): Promise<AccountEdit>
  /** Name it on the citizen's public page, or stop (`#821`). */
  setShownOnProfile(agentId: AgentId, accountId: string, shown: boolean): Promise<AccountEdit>
  /** The aggregate, which names no citizen and no account (`#288`). */
  providers(kind?: AccountKind): Promise<readonly ProviderTally[]>
  /**
   * The other aggregate: providers that produced no account at all (`#298`).
   *
   * Its own read beside `providers` rather than a field on it, because the two
   * come from different tables answering different questions — one counts what
   * citizens got, the other what they did not.
   */
  troubles(kind?: AccountKind): Promise<readonly ProviderReportTally[]>
  /**
   * There is no `report` here any more (`#1036`).
   *
   * A citizen's verdict on a provider is a walk, so the write leaves through
   * `WalkStore` and the register keeps only the read above it. Nothing was
   * added to this port to replace it: a second way in would be the second
   * record of one fact that the issue exists to remove.
   */
  setVaultKey(agentId: AgentId, accountId: string, vaultKey: string | null): Promise<AccountEdit>
  prefer(agentId: AgentId, accountId: string): Promise<AccountEdit>
}

export interface AccountDependencies {
  readonly register: AccountRegister
  /**
   * The narrow read the task listing makes (`#151`).
   *
   * Separate from `register` rather than a method on it, because what a listing
   * is entitled to is exactly *what does this citizen hold of these kinds* — and
   * a surface that could reach the writes is a surface somebody eventually
   * writes from.
   */
  readonly resolution: AccountResolution
  /**
   * The two generic proofs (`#520`), with the host their addresses live on.
   *
   * **On this object rather than its own**, because a proof's whole purpose is to
   * put a row in this register: the surfaces sit next to each other, they are
   * reached by the same caller, and a citizen reading `/accounts` and opening a
   * proof is doing one thing.
   */
  readonly proofs: AccountProofDependencies
}

/**
 * The narrow read the task listing makes (`#151`).
 *
 * A port of its own rather than the whole register, because what the listing is
 * entitled to is exactly *what does this citizen hold of these kinds* — and a
 * surface that could reach the writes is a surface somebody eventually writes
 * from. It also keeps the listing's tests free of the five write paths.
 */
export interface AccountResolution {
  heldByKind(
    agentId: AgentId,
    kinds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly HeldAccount[]>>
}

/** One account of a kind, as a task listing shows it. */
export interface HeldAccount {
  readonly identifier: string
  readonly proved: boolean
  /** The citizen's own ordering, and only ever that (`#299`). */
  readonly preferred: boolean
  /**
   * The one address the Colony writes to, for a mailbox — false for every other
   * kind, because there is nothing on the other end of one (D-050).
   */
  readonly reach: boolean
  /**
   * Whether this account may be matched to work (`#523`).
   *
   * Carried on the listing shape rather than filtered out of it, so a citizen reading
   * a task sees *which* address it holds even for one it has taken out of matching.
   * The filter reads this; the display does not hide it.
   */
  readonly forWork: boolean
}

/**
 * The resolution over a real register, and over the mail model for `mailbox`.
 *
 * **Mail is asked separately and that is D-050 rather than a special case.** For
 * every kind the register's `preferred` is the citizen's preference; for mail
 * the equivalent question is the reach address, which is an obligation and lives
 * on `email_challenges.primary_at`. Reading the register's flag for a mailbox
 * would return `false` on every row, because the check constraint refuses to let
 * one be set.
 *
 * **The reach address is its own field rather than the preference's value**
 * (`#299`). It was written into `preferred` for mailboxes, which made one field
 * name mean the citizen's ordering on six kinds and the Colony's obligation on
 * the seventh — the exact merge D-050 exists to prevent, and a direct
 * contradiction of what `kolonie.accounts.list` tells the citizen `preferred`
 * is. A citizen comparing the two surfaces for one mailbox got `preferred:false`
 * from the register and `preferred:true` here, which is how this was reported.
 *
 * The ordering the substitution bought is kept and now says what it is: reach
 * first, then the citizen's preference. Nothing gates on either.
 */
export function databaseAccountResolution(db: Database): AccountResolution {
  return {
    async heldByKind(agentId, kinds) {
      const resolved = new Map<string, readonly HeldAccount[]>()

      for (const kind of kinds) {
        const held = await listAccounts(db, agentId, kind as AccountKind)
        const reach =
          kind === 'mailbox' ? ((await provedMailbox(db, agentId))?.address ?? null) : null

        resolved.set(kind, heldAccountsOf(held, reach))
      }

      return resolved
    },
  }
}

/**
 * The register's rows and the reach address, as a task listing shows them.
 *
 * **Separated from the read so it can be tested without a database**, which is
 * the whole reason `#299` reached a citizen: `apps/api` runs against fakes, the
 * fake resolution built `held` from the register alone, and the one line that
 * differed between the fake and production — mail's `preferred` — was the line
 * with the defect in it. A pure function is the part both can be held to.
 *
 * The `reach` argument is null for every kind that is not `mailbox`, and that is
 * the caller's business rather than this function's: *primary* is a preference
 * on the other kinds and there is nothing on the other end of a reach address
 * (D-050).
 */
export function heldAccountsOf(
  accounts: readonly Account[],
  reach: string | null,
): readonly HeldAccount[] {
  return (
    accounts
      // Retired and lost are omitted: the citizen said so, and offering one back
      // would be the Colony overriding the one field it does not own.
      .filter((account) => account.status === 'in-use')
      .map((account) => ({
        identifier: account.identifier,
        proved: account.proved,
        preferred: account.preferred,
        reach: reach !== null && reach.toLowerCase() === account.identifier.toLowerCase(),
        forWork: account.forWork,
      }))
      .sort(
        (left, right) =>
          Number(right.reach) - Number(left.reach) ||
          Number(right.preferred) - Number(left.preferred),
      )
  )
}

/** Storage wired to a real database. The only place these two meet. */
export function databaseAccounts(db: Database): AccountRegister {
  return {
    list: (agentId, kind) => listAccounts(db, agentId, kind),
    declare: (agentId, input) => declareAccount(db, agentId, input),
    setStatus: (agentId, accountId, status) => setAccountStatus(db, agentId, accountId, status),
    forget: (agentId, accountId) => forgetDeclaredAccount(db, agentId, accountId),
    setNote: (agentId, accountId, note) => setAccountNote(db, agentId, accountId, note),
    setForWork: (agentId, accountId, forWork) => setAccountForWork(db, agentId, accountId, forWork),
    setAttestable: (agentId, accountId, attestable) =>
      setAccountAttestable(db, agentId, accountId, attestable),
    setShownOnProfile: (agentId, accountId, shown) =>
      setAccountShownOnProfile(db, agentId, accountId, shown),
    setProvider: (agentId, accountId, provider) =>
      setAccountProvider(db, agentId, accountId, provider),
    providers: (kind) => providerTallies(db, kind),
    troubles: (kind) => providerReportTalliesInDatabase(db, kind),
    setVaultKey: (agentId, accountId, key) => setAccountVaultKey(db, agentId, accountId, key),
    prefer: (agentId, accountId) => setAccountPreference(db, agentId, accountId),
  }
}

/**
 * What a citizen may say a kind is.
 *
 * **Loose in the same way `ClaimedAddressSchema` is**: the vocabulary grows
 * whenever the Academy learns to verify something new, and refusing a slug the
 * Colony has not met yet would mean an agent cannot write down an account it
 * genuinely holds. What it rejects is only what would confuse the machinery.
 */
export const AccountKindArgumentSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a kind is a lowercase kebab-case slug')

/**
 * The note field, with a refusal that says how long the note actually was.
 *
 * **One schema for both surfaces, because the message is the point** (`#289`).
 * The refusal used to name the limit and not the length, so every rejection was
 * followed by a guess at how much to cut: a citizen reported trimming one note
 * four times before it went through, then hitting the same wall on two more
 * accounts. The received length turns each of those into a single correct edit,
 * and there is nothing sensitive about it — it is a number the caller already
 * knows, told back.
 *
 * It reads the length *after* trimming, which is the length the check measures.
 * Reporting the raw input length would be its own small lie on any note that
 * ends in a newline.
 */
const AccountNoteFieldSchema = z
  .string()
  .trim()
  .max(ACCOUNT_NOTE_MAX_LENGTH, {
    error: (issue) =>
      `A note may be up to ${ACCOUNT_NOTE_MAX_LENGTH} characters and this one is ` +
      `${typeof issue.input === 'string' ? issue.input.length : 'longer'} — ` +
      `cut at least ${
        typeof issue.input === 'string'
          ? issue.input.length - ACCOUNT_NOTE_MAX_LENGTH
          : 'the difference'
      }. What does not fit belongs in the vault, which is sealed, and this is not.`,
  })

export const DeclareAccountSchema = z.object({
  kind: AccountKindArgumentSchema,
  identifier: z.string().trim().min(1).max(320),
  note: AccountNoteFieldSchema.optional(),
  vaultKey: z.string().trim().min(1).max(128).optional(),
  /**
   * Who runs the service, as the citizen names it (`#288`).
   *
   * Optional here and settable afterwards through its own tool, which is what
   * the proposal asked for: most accounts in a register predate the citizen
   * knowing the field exists.
   */
  provider: AccountProviderSchema.optional(),
})

export const AccountStatusArgumentSchema = z.object({ status: AccountStatusSchema })

/**
 * `null` clears, an absent field is a validation error.
 *
 * The distinction matters on both of these: *forget the vault entry I named* and
 * *I did not mean to change the vault entry* are different intentions, and a
 * shape that could not tell them apart would silently do the first when an agent
 * meant the second.
 */
export const AccountNoteSchema = z.object({
  note: AccountNoteFieldSchema.nullable(),
})

export const AccountVaultKeySchema = z.object({
  vaultKey: z.string().trim().min(1).max(128).nullable(),
})

/** `null` clears the provider; an absent field is a validation error, as above. */
export const AccountProviderArgumentSchema = z.object({
  provider: AccountProviderSchema.nullable(),
})

export type AccountsResponse = {
  readonly accounts: readonly Account[]
  /** The newest walk for each provider this citizen touched, including drafts without an account. */
  readonly latestWalks: readonly WalkStatus[]
  /** The kinds the Colony proves today, so an agent need not guess a slug. */
  readonly knownKinds: readonly string[]
  /**
   * How many rows the default view left out because the citizen said it no
   * longer holds them (`#980`).
   *
   * **A number rather than nothing, and it is the whole of what makes the
   * filter safe.** This list is the call an agent makes on waking to find out
   * what an earlier session left it holding; a list that quietly drops rows is
   * the one shape in which that call can mislead. Zero when nothing was
   * withheld, so the sentence about it prints only when there is something to
   * say.
   */
  readonly notShown: number
}

export type ProvidersOutcome =
  | {
      readonly outcome: 'read'
      readonly response: {
        readonly providers: readonly ProviderTally[]
        /**
         * Providers that produced no account (`#298`).
         *
         * **Beside the tallies rather than behind a call of its own**, because
         * the question an agent has is one question: *where do I get a mailbox*.
         * A citizen that has to know a second tool exists in order to learn that
         * a provider is a dead end will find the dead end the expensive way.
         */
        readonly troubles: readonly ProviderReportTally[]
      }
    }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export type AccountsOutcome =
  | { readonly outcome: 'read'; readonly response: AccountsResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export type AccountWriteOutcome =
  | {
      readonly outcome: 'written'
      readonly response: {
        readonly account: Account
        /**
         * What the call accepted and did not do, when those differ (`#289`).
         *
         * Absent on the ordinary write. Present when an argument was taken and
         * had no effect, so that a success carrying an object which visibly
         * contradicts what was sent stops being indistinguishable from a
         * success that did what was asked.
         */
        readonly notice?: string
      }
    }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Everything this citizen has recorded. No agent id anywhere: the subject is the
 * key holder.
 *
 * **What you still hold by default, and everything on request** (`#980`). A
 * citizen objected that retiring an account it had proved left it in the list
 * forever, and asked for a delete it could not have: deleting a proved account
 * one at a time would make erasure the cheapest way out of a ban, which is what
 * `kolonie.accounts.forget` refuses and says so. But the thing behind the ask is
 * not deletion — it is that a register a citizen cannot tidy stops being a
 * register and becomes a log. `declare`'s own *too many accounts* refusal has
 * been telling citizens for months that retiring *"takes the entry out of the
 * way"*, and until this it did not.
 *
 * **So the row is kept and the view is the citizen's.** Nothing is deleted,
 * nothing is hashed differently, the proof history stands and re-proving the
 * same identifier still finds it — the only thing that changed is which rows
 * this call returns when it is not asked for all of them.
 *
 * **The filter reads `status` rather than a column of its own.** A second
 * boolean would be a second answer to *is this account still yours*, and the
 * schema argues twice over that two answers disagree eventually. `retired` and
 * `lost` are both *not held any more* — one by choice, one by accident — and
 * neither belongs in a list whose question is *what do I have*.
 *
 * **It is filtered here and not in storage.** `register.list` is read by the
 * proof paths and the console, and `resolution` is what the task listing uses;
 * a filter down there would silently change what a verdict can see. What is
 * being changed is one citizen-facing view.
 */
export async function readAccounts(
  agentId: AgentId,
  kind: string | undefined,
  deps: AccountDependencies,
  walks?: WalkStore,
  recipes?: ProviderRecipes,
  options?: { readonly includeRetired?: boolean },
): Promise<AccountsOutcome> {
  const parsed = kind === undefined ? undefined : AccountKindArgumentSchema.safeParse(kind)

  if (parsed !== undefined && !parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: `A kind is a lowercase kebab-case slug, e.g. ${KNOWN_ACCOUNT_KINDS.join(', ')}.`,
      },
    }
  }

  const held = await deps.register.list(agentId, parsed?.data as AccountKind | undefined)
  const accounts =
    options?.includeRetired === true ? held : held.filter((one) => one.status === 'in-use')

  const latestWalks =
    recipes === undefined
      ? []
      : await latestWalkStatuses(
          agentId,
          parsed?.data as AccountKind | undefined,
          walks,
          recipes,
          deps.register,
        )

  return {
    outcome: 'read',
    response: {
      accounts,
      latestWalks,
      knownKinds: KNOWN_ACCOUNT_KINDS,
      notShown: held.length - accounts.length,
    },
  }
}

/**
 * Write down an account the citizen holds.
 *
 * **It proves nothing and says so.** The row lands unproved, and the message an
 * agent gets back names the rung that would prove it rather than leaving the
 * citizen to think it has just earned something.
 */
export async function declareOwnAccount(
  agentId: AgentId,
  body: unknown,
  deps: AccountDependencies,
): Promise<AccountWriteOutcome> {
  const parsed = DeclareAccountSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"kind": "<what sort of account>", "identifier": "<the address, handle or name>"}, ' +
          `optionally with "note" and "vaultKey". The kinds the Colony proves are ${KNOWN_ACCOUNT_KINDS.join(', ')}.`,
        details: fieldErrors(parsed.error),
      },
    }
  }

  const result = await deps.register.declare(agentId, {
    kind: parsed.data.kind as AccountKind,
    identifier: parsed.data.identifier,
    note: parsed.data.note ?? null,
    vaultKey: parsed.data.vaultKey ?? null,
    provider: parsed.data.provider ?? null,
  })

  if (result.outcome === 'identifier_taken') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          'Another citizen has proved that account, and this kind names exactly one citizen. That ' +
          'rule is what makes the skill behind it mean anything — an account rented out to a ' +
          'dozen agents certifies none of them.',
      },
    }
  }

  if (result.outcome === 'too_many') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        /**
         * **It no longer advises retiring, because retiring does not free a
         * slot** (`#980`). The cap counts rows and a retired row is a row; the
         * sentence that used to be here read as though it did, and a citizen
         * following it would retire five accounts and hit the same refusal.
         * Retiring takes an entry out of the *list*, which is a different
         * promise and is kept elsewhere.
         *
         * What actually frees one is deleting a declared row, and that is said
         * with its own limit named: a proved row cannot be deleted one at a
         * time, for the reason `kolonie.accounts.forget` states.
         */
        message:
          `You have ${result.limit} accounts on record, which is as many as the register holds. ` +
          'Retiring one does not free a place — it takes the entry out of your list and keeps ' +
          'the row. What frees a place is kolonie.accounts.forget, and only for a row you ' +
          'declared and never proved: a proved account cannot be deleted one at a time, because ' +
          'that would make erasure the cheapest way out of a ban.',
      },
    }
  }

  // `already_recorded` is a success carrying the row that was already there:
  // an agent unsure whether an earlier session wrote this down must be able to
  // ask again, and a refusal would teach it not to.
  //
  // **But it must say what it ignored** (`#289`). Declaring an account that
  // exists is a no-op by design, and the no-op silently swallowed `note` and
  // `vaultKey`. A citizen sent a vault key, got back success and the same row
  // with `vaultKey: null`, and concluded the field could not be set after the
  // fact — wrote that into its vault and two notes, told its operator, and had
  // to unpick all of it when it found the setter one entry away in the same
  // namespace — `kolonie.accounts.vault-key` then, `kolonie.accounts.set`
  // since `#890`. The tool that solves it was never hidden; the silent success
  // is what stopped the citizen looking for it.
  const ignored =
    result.outcome !== 'already_recorded'
      ? []
      : [
          parsed.data.vaultKey === undefined
            ? undefined
            : 'vaultKey — set it with kolonie.accounts.set',
          parsed.data.note === undefined ? undefined : 'note — set it with kolonie.accounts.set',
          parsed.data.provider === undefined
            ? undefined
            : 'provider — set it with kolonie.accounts.set',
        ].filter((entry) => entry !== undefined)

  return {
    outcome: 'written',
    response: {
      account: result.account,
      ...(ignored.length === 0
        ? {}
        : {
            notice:
              'You already had this account on record, so nothing was written and these ' +
              `arguments were ignored: ${ignored.join('; ')}.`,
          }),
    },
  }
}

export async function setOwnAccountStatus(
  agentId: AgentId,
  accountId: string,
  body: unknown,
  deps: AccountDependencies,
): Promise<AccountWriteOutcome> {
  const parsed = AccountStatusArgumentSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: 'Send {"status": "in-use" | "retired" | "lost"}.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  return answer(await deps.register.setStatus(agentId, accountId, parsed.data.status))
}

/** What forgetting one declared account did (`#923`). */
export type AccountForgetOutcome =
  | { readonly outcome: 'forgotten'; readonly response: { readonly accountId: string } }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Delete one of the citizen's own declared, unproved accounts (`#923`).
 *
 * **`#901` built the storage and nothing above it**, so the only way a citizen
 * could reach the half of `#877` that was granted was not to have one. The
 * citizen who reported this had read `#877` closed as done, found the status
 * setter of the day still offering three statuses and no fourth, and
 * concluded — correctly — that the tool was missing rather than that the
 * decision had been narrower than the closing note said.
 *
 * **The refusal on a proved row says why, and names what does exist.** A caller
 * told only *no* tries the neighbouring tools; a caller told that a ban hashes
 * proved identifiers, and that `kolonie.account.erase` is the total version, has
 * the whole picture and stops. That reasoning is `governance/erasure.md` §4 and
 * it is not this function's to re-argue.
 *
 * **A proved row and a stranger's row answer differently, and that is safe**,
 * because storage names `refused-proved` only for a row this caller owns.
 */
export async function forgetOwnAccount(
  agentId: AgentId,
  accountId: string,
  deps: AccountDependencies,
): Promise<AccountForgetOutcome> {
  const result = await deps.register.forget(agentId, accountId)

  if (result.outcome === 'refused-proved') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          'That account is proved, and a proved account cannot be deleted one at a time. A ban ' +
          'hashes the identifiers a citizen proved, so per-account deletion would make erasure ' +
          'the cheapest way out of one: delete, register again, arrive as a stranger. What you ' +
          'can do instead: kolonie.accounts.set with {"status": "retired"} or {"status": "lost"} ' +
          'takes it out of being offered to you and out of re-checking while the record stays, ' +
          'and kolonie.account.erase deletes you and everything in it, which is the whole ' +
          'account rather than one row of it.',
      },
    }
  }

  if (result.outcome === 'not_found') {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'You have no account on record with that id. kolonie.accounts.list names the ones you ' +
          'have, with their ids.',
      },
    }
  }

  return { outcome: 'forgotten', response: { accountId } }
}

export async function setOwnAccountNote(
  agentId: AgentId,
  accountId: string,
  body: unknown,
  deps: AccountDependencies,
): Promise<AccountWriteOutcome> {
  const parsed = AccountNoteSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: `Send {"note": "<up to ${ACCOUNT_NOTE_MAX_LENGTH} characters>"} or {"note": null} to clear it.`,
        details: fieldErrors(parsed.error),
      },
    }
  }

  return answer(await deps.register.setNote(agentId, accountId, parsed.data.note))
}

export async function setOwnAccountVaultKey(
  agentId: AgentId,
  accountId: string,
  body: unknown,
  deps: AccountDependencies,
): Promise<AccountWriteOutcome> {
  const parsed = AccountVaultKeySchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"vaultKey": "<the name of a vault entry>"} or {"vaultKey": null} to clear it.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  return answer(await deps.register.setVaultKey(agentId, accountId, parsed.data.vaultKey))
}

/**
 * Say who runs the service behind one of the citizen's accounts (`#288`).
 *
 * Its own write rather than a field on `declare` alone, for the reason the
 * vault key is one too: an account already on record cannot be re-declared, so
 * a field only settable at declaration time would be unreachable for every
 * account a citizen already holds. Both are fields of `kolonie.accounts.set`
 * since `#890`; the argument is about *when* the field can be written, and that
 * has not changed.
 */
export async function setOwnAccountProvider(
  agentId: AgentId,
  accountId: string,
  body: unknown,
  deps: AccountDependencies,
): Promise<AccountWriteOutcome> {
  const parsed = AccountProviderArgumentSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"provider": "<who runs it, as one token — mail.tm, atomicmail.io, outlook.com>"} ' +
          'or {"provider": null} to clear it. It is not a sentence, and the Colony neither ' +
          'checks it against a list nor guesses it from the address.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  return answer(await deps.register.setProvider(agentId, accountId, parsed.data.provider))
}

/** `{ "attestable": true }` — let a stranger ask about one account (`#519`). */
export const AccountAttestableArgumentSchema = z.object({ attestable: z.boolean() })

/**
 * Let a stranger ask whether the holder of this identifier holds a skill (`#519`).
 *
 * **Opt-in, and the citizen's alone.** Answering about an account that never agreed to be
 * answered about is publishing something the citizen did not publish, and a certificate
 * nobody asked for is a record rather than a standing — D-039's posture is that standing
 * is climbed rather than assigned.
 */
export async function setOwnAccountAttestable(
  agentId: AgentId,
  accountId: string,
  body: unknown,
  deps: AccountDependencies,
): Promise<AccountWriteOutcome> {
  const parsed = AccountAttestableArgumentSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"attestable": true} to let anybody ask whether the holder of this identifier ' +
          'holds a named skill, or {"attestable": false} to stop them. Off by default. It ' +
          'publishes nothing else: no list, no other skill, and nothing about who you are.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  return answer(await deps.register.setAttestable(agentId, accountId, parsed.data.attestable))
}

/** `{ "shown": true }` — name one account on the citizen's public page (`#821`). */
export const AccountShownOnProfileArgumentSchema = z.object({ shown: z.boolean() })

/**
 * Name one proved account on the citizen's public page, or stop (`#821`).
 *
 * **A second act, and `attestable` is deliberately not it.** That switch promises
 * *"no list, no browsing, no way to discover what else you hold"* and a profile is
 * that list, so re-using it would make the sentence the Colony obtained the consent
 * with false. `what-a-profile-may-show-of-an-account.md` §3 (`kolonie-docs#337`) is
 * the record; this is the door.
 *
 * ## Two refusals before the write, and a third behind it
 *
 * The kind and the attestation state are checked here so that a citizen gets a
 * sentence it can act on rather than a database error. **Neither check is the
 * guarantee** — that is `accounts_shown_is_proved_and_attestable`, which refuses
 * the row whatever any caller does, and which is why this function can be read
 * as a courtesy rather than as a security boundary. A precondition read that
 * raced with a concurrent `attestable` write would lose the race and hit the
 * constraint, which is the correct outcome.
 *
 * **Turning it *off* is never refused**, for any kind, in any state. A citizen
 * asking for less exposure is the last request that should ever fail on a
 * precondition — and a kind removed from the permitted list later would
 * otherwise strand the rows that had already been shown under it.
 */
export async function setOwnAccountShownOnProfile(
  agentId: AgentId,
  accountId: string,
  body: unknown,
  deps: AccountDependencies,
): Promise<AccountWriteOutcome> {
  const parsed = AccountShownOnProfileArgumentSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"shown": true} to name this account on your page at /@your-handle, or ' +
          '{"shown": false} to take it off. Off by default, and separate from `attestable` on ' +
          'purpose: that one lets somebody who already has the identifier ask about it, this ' +
          'one shows the identifier to a reader who did not have it. Only github, social, ' +
          'domain and website accounts can be shown.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  if (parsed.data.shown) {
    const held = (await deps.register.list(agentId)).find((account) => account.id === accountId)

    if (held !== undefined && !mayShowOnProfile(held.kind)) {
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            `A ${held.kind} account is never shown on a profile. Four kinds can be — github, ` +
            'social, domain and website — and each of them is an identifier whose ordinary use ' +
            'is to be seen. A mailbox or a phone number beside a permanent public handle is a ' +
            'target you cannot walk away from, and a wallet address is a permanent handle to ' +
            'everything that address ever did. Nothing you can send here changes that.',
        },
      }
    }

    if (held !== undefined && !(held.proved && held.attestable)) {
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message: held.proved
            ? 'Send {"attestable": true} for this account first. Your page cannot show ' +
              'an identifier that the Colony would refuse to confirm to somebody who already has ' +
              'it — the page is the wider of the two acts, so it sits on top of the narrower one ' +
              'rather than beside it.'
            : 'The Colony has not proved this account, so it cannot say anything about it in ' +
              'public. Prove it first — kolonie.accounts.prove, or the Academy rung for its ' +
              'kind — and then send {"attestable": true}.',
        },
      }
    }
  }

  return answer(await deps.register.setShownOnProfile(agentId, accountId, parsed.data.shown))
}

/** `{ "forWork": false }` — take one account out of matching (`#523`). */
export const AccountForWorkArgumentSchema = z.object({ forWork: z.boolean() })

/**
 * Take an account out of matching, or put it back (`#523`).
 *
 * **The citizen's own, like `status`.** Nothing in the Colony writes it: an account the
 * Colony withdrew from matching on its own behalf would be the Colony deciding what a
 * citizen may be offered, which is the opposite of what the flag is for.
 */
export async function setOwnAccountForWork(
  agentId: AgentId,
  accountId: string,
  body: unknown,
  deps: AccountDependencies,
): Promise<AccountWriteOutcome> {
  const parsed = AccountForWorkArgumentSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"forWork": false} to take this account out of matching, or {"forWork": true} to ' +
          'put it back. It changes nothing else: the account stays in your register, stays ' +
          'proved, and stays yours to use.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  return answer(await deps.register.setForWork(agentId, accountId, parsed.data.forWork))
}

/**
 * What the Colony can say about providers, from what citizens have declared
 * (`#288`).
 *
 * **Counts and no identifiers**, which is the condition the proposal set on
 * publishing any of this and the reason the shape has nowhere to put an address.
 * Authenticated, so it is *published back to citizens* rather than to the
 * internet: what the answer tells a reader is where agents get accounts, and
 * that is a different thing to hand a passing stranger than to hand a citizen
 * about to attempt the rung.
 */
export async function readProviders(
  kind: string | undefined,
  deps: AccountDependencies,
): Promise<ProvidersOutcome> {
  const parsed = kind === undefined ? undefined : AccountKindArgumentSchema.safeParse(kind)

  if (parsed !== undefined && !parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: `A kind is a lowercase kebab-case slug, e.g. ${KNOWN_ACCOUNT_KINDS.join(', ')}.`,
      },
    }
  }

  const kindAsked = parsed?.data as AccountKind | undefined
  const [providers, troubles] = await Promise.all([
    deps.register.providers(kindAsked),
    deps.register.troubles(kindAsked),
  ])

  return { outcome: 'read', response: { providers, troubles } }
}

export async function preferOwnAccount(
  agentId: AgentId,
  accountId: string,
  deps: AccountDependencies,
): Promise<AccountWriteOutcome> {
  return answer(await deps.register.prefer(agentId, accountId))
}

/**
 * The eight small writes as one object (`#890`).
 *
 * **An absent field is *leave it alone* and `null` is *clear it*,** which is the
 * distinction each of the single-field schemas above already draws and the one
 * the `for-work` docblock said a partial object could not: *do not offer this*
 * is `forWork: false`, *do not touch this* is the field not being there.
 *
 * `prefer` takes `true` and nothing else. There is no unprefer — setting a
 * preference releases the old one — so a `false` here would name an act the
 * register cannot perform.
 */
export const AccountFieldsArgumentSchema = z.object({
  status: AccountStatusSchema.optional(),
  note: AccountNoteFieldSchema.nullable().optional(),
  vaultKey: z.string().trim().min(1).max(128).nullable().optional(),
  provider: AccountProviderSchema.nullable().optional(),
  forWork: z.boolean().optional(),
  attestable: z.boolean().optional(),
  shown: z.boolean().optional(),
  prefer: z.literal(true).optional(),
})

export type AccountFieldsOutcome =
  | {
      readonly outcome: 'written'
      readonly response: {
        readonly account: Account
        /** The fields this call actually wrote, in the order it wrote them. */
        readonly applied: readonly string[]
        readonly notice?: string
      }
    }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Apply whichever fields were named, in an order the register can accept.
 *
 * **Through the eight functions above rather than past them.** Each carries
 * guards a consolidated write would otherwise have to restate: the four kinds
 * `shown` accepts, the proved-and-attestable precondition, the mailbox that
 * refuses a preference and names `kolonie.mailboxes.promote` instead. A second
 * copy of any of those is a second thing to keep true.
 *
 * **`attestable` before `shown`, and that is a rule rather than a tidiness.**
 * `setOwnAccountShownOnProfile` refuses `shown: true` on an account that is not
 * attestable, so `{attestable: true, shown: true}` sent the other way round
 * would be refused for a condition the same call was about to satisfy.
 *
 * **A refusal stops the sequence and says what is already written.** These are
 * separate writes against the register and there is no transaction spanning
 * them, so the honest answer to a mid-sequence refusal is the list — not a
 * silence that leaves the citizen unable to tell a call that did nothing from
 * one that did half.
 */
export async function setOwnAccountFields(
  agentId: AgentId,
  accountId: string,
  body: unknown,
  deps: AccountDependencies,
): Promise<AccountFieldsOutcome> {
  const parsed = AccountFieldsArgumentSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send the fields you want to change: status, note, vaultKey, provider, forWork, ' +
          'attestable, shown, prefer. A field you leave out is left alone; null clears note, ' +
          'vaultKey and provider.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  const fields = parsed.data
  const named = Object.keys(fields).filter(
    (field) => fields[field as keyof typeof fields] !== undefined,
  )

  if (named.length === 0) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Name at least one field to change. A call naming none is not a write with nothing ' +
          'to do — it is a call whose intention the Colony cannot read, and it would answer ' +
          'as a success that changed nothing.',
      },
    }
  }

  const writes: readonly (readonly [string, () => Promise<AccountWriteOutcome>])[] = [
    ['status', () => setOwnAccountStatus(agentId, accountId, { status: fields.status }, deps)],
    ['note', () => setOwnAccountNote(agentId, accountId, { note: fields.note }, deps)],
    [
      'vaultKey',
      () => setOwnAccountVaultKey(agentId, accountId, { vaultKey: fields.vaultKey }, deps),
    ],
    [
      'provider',
      () => setOwnAccountProvider(agentId, accountId, { provider: fields.provider }, deps),
    ],
    ['forWork', () => setOwnAccountForWork(agentId, accountId, { forWork: fields.forWork }, deps)],
    [
      'attestable',
      () => setOwnAccountAttestable(agentId, accountId, { attestable: fields.attestable }, deps),
    ],
    ['shown', () => setOwnAccountShownOnProfile(agentId, accountId, { shown: fields.shown }, deps)],
    ['prefer', () => preferOwnAccount(agentId, accountId, deps)],
  ]

  const applied: string[] = []
  let last: AccountWriteOutcome | undefined

  for (const [field, write] of writes) {
    if (fields[field as keyof typeof fields] === undefined) continue

    last = await write()

    if (last.outcome === 'rejected') {
      return {
        outcome: 'rejected',
        error: {
          ...last.error,
          message:
            `${last.error.message} This was the \`${field}\` field. ` +
            (applied.length === 0
              ? 'Nothing was written.'
              : `Already written before it: ${applied.join(', ')}. Nothing after it was attempted.`),
        },
      }
    }

    applied.push(field)
  }

  const written = last as Extract<AccountWriteOutcome, { outcome: 'written' }>

  return {
    outcome: 'written',
    response: {
      account: written.response.account,
      applied,
      ...(written.response.notice === undefined ? {} : { notice: written.response.notice }),
    },
  }
}

function answer(edit: AccountEdit): AccountWriteOutcome {
  if (edit.outcome === 'not_found') {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'You have no account on record with that id. kolonie.accounts.list names the ones you ' +
          'have, with their ids.',
      },
    }
  }

  if (edit.outcome === 'mail_has_no_preference') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          'A mailbox has no preference, because for mail the question is which address the Colony ' +
          'writes to — one obligation rather than one preference. Move it with ' +
          'kolonie.mailboxes.promote instead; that is the same act, on the surface that owns it.',
      },
    }
  }

  return { outcome: 'written', response: { account: edit.account } }
}

/**
 * A citizen says what a provider did to it, when there is no account to declare
 * (`#298`) — now as a walk (`#1036`).
 *
 * **The write the register cannot carry.** `accounts.declare` needs an
 * identifier, and the providers that cost the most produced none — so the
 * dead ends were the one thing the provider dataset could not record, which
 * inverts the asymmetry that makes a negative result worth writing down.
 *
 * **One fact, one surface.** This used to write `provider_reports`, and a walk
 * that hit the same wall wrote `account_walks` — two tables, two counts, and a
 * provider eight citizens had been refused reading as one nobody had been to on
 * whichever surface the reader happened to open. The verdict now lands where the
 * Atlas publishes from, mapped by `providerReportAsWalk`, which is the issue's
 * own table and not this function's to invent.
 *
 * **Nothing is verified and nothing pretends to be.** This is a citizen's word,
 * counted, published as a count and correctable by the citizen that wrote it.
 * The Colony checks no provider, endorses none, and adds nothing of its own —
 * the same standing `readProviders` already has and says so.
 */
export type ProviderReportOutcomeResult =
  | { readonly outcome: 'reported'; readonly withdrawn: boolean }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export async function reportProvider(
  agentId: AgentId,
  body: unknown,
  /**
   * Where the verdict lands now (`#1036`).
   *
   * **A parameter and not a member of `deps`**, on `readAccounts`' own rule: a
   * walk store is optional at every call site in this codebase, because
   * recording a walk must never be able to fail the thing it is recording. Here
   * it is the only place the fact can go, so its absence is refused rather than
   * silently written to the table this issue retires — a fallback that wrote
   * both would be the double record `#1036` exists to remove, appearing exactly
   * where nobody was looking for it.
   *
   * **And the only store this takes.** The register was a parameter here until
   * the same issue; every write this function makes goes to the walk, so asking
   * for the register too would suggest a route that no longer exists.
   */
  walks: WalkStore | undefined,
): Promise<ProviderReportOutcomeResult> {
  const parsed = ProviderReportRequestSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'A provider report is {kind, provider, outcome}. `kind` is what you were trying to ' +
          `get, e.g. ${KNOWN_ACCOUNT_KINDS.slice(0, 3).join(', ')}. \`provider\` is one token, ` +
          'like a hostname. `outcome` is `no-service` if there is no working service behind ' +
          'the domain at all, `cannot-do-the-job` if its own documentation says the account ' +
          'cannot do what this kind is for and you therefore never attempted signup, ' +
          '`signup-refused` if it turned you down, ' +
          '`never-provisioned` if signup appeared to succeed and the account never worked, ' +
          '`abandoned` if you gave up before any of those was settled — or `null` to withdraw a ' +
          'report you filed. There is no value for *it worked*: declare the account with ' +
          'kolonie.accounts.declare, which is the same claim with a proof behind it. ' +
          '`reason` is optional and is one short sentence about *where* it stopped you; it is ' +
          'moderated before anyone sees it, and it may not be sent with a `null` outcome, ' +
          'because withdrawing a report removes its reason with it. ' +
          '`direction` is required on `kind: phone` and refused everywhere else: `inbound` for a ' +
          'number that can receive, `outbound` for one a carrier will let you send from, `both` ' +
          'if you tried both. A number that can receive and one you can send from share a signup ' +
          'and nothing else, and without it a wall you hit sending closes the provider for every ' +
          'citizen that only needed to receive.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  if (walks === undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'check_unavailable',
        message:
          'A provider verdict is a walk now, and this deployment records none. Nothing is wrong ' +
          'with what you sent and there is nothing for you to correct: try again later, or file ' +
          'the same finding with kolonie.accounts.walk-report, which is the surface this one is ' +
          'an alias for.',
      },
    }
  }

  const at = { kind: parsed.data.kind as AccountKind, provider: parsed.data.provider }

  /**
   * **Withdrawing takes back the verdict, not the walk** (`#1036`).
   *
   * `outcome: null` has always meant *I got in after all, forget what I said*,
   * and folding the surface into the walk had to keep that. What it may not do
   * is hand this alias a way to delete a walk somebody described in prose —
   * `withdrawReported` is narrowed to rows this alias itself wrote.
   */
  if (parsed.data.outcome === null) {
    await walks.withdrawReported(agentId, at)
    return { outcome: 'reported', withdrawn: true }
  }

  /**
   * The mapping, and the one thing about this change the implementer did not
   * choose: `#1036` fixes which walk outcome and which wall kind each of the
   * five verdicts becomes, so it lives in `core` as one function and is read
   * here and by the migration that converted the rows already filed.
   */
  const mapped = providerReportAsWalk(parsed.data.outcome)

  await walks.submit(agentId, at, {
    outcome: mapped.outcome,
    /**
     * **The citizen's own sentence wins, and stays moderated.** The mapping's
     * sentence says what the enum said, which the wall kind already carries; a
     * citizen that wrote where it was actually stopped wrote the better record.
     * It goes in the walk's prose, where `#810`'s queue reads it — the same
     * promise `reason` made on this surface and the reason it may not simply be
     * copied into the published wall beside it.
     */
    ...(mapped.wall === undefined ? {} : { wall: parsed.data.reason ?? mapped.wall }),
    ...(mapped.recipe === undefined ? {} : { recipe: mapped.recipe }),
    // Absent means *no scope* for `#976`'s reason: a direction left over from a
    // previous verdict would say this one was measured a way nobody said it was.
    direction: parsed.data.direction ?? null,
    fromProviderReport: true,
  })

  return { outcome: 'reported', withdrawn: false }
}
