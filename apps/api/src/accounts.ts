import { z } from 'zod'
import {
  ACCOUNT_NOTE_MAX_LENGTH,
  AccountProviderSchema,
  AccountStatusSchema,
  KNOWN_ACCOUNT_KINDS,
  type Account,
  type AccountKind,
  type AccountStatus,
  type AgentId,
  type ApiError,
  type ProviderTally,
  type ProviderReportOutcome,
  type ProviderReportTally,
  ProviderReportRequestSchema,
} from '@kolonie-ai/core'
import type { AccountDeclaration, AccountEdit, Database } from '@kolonie-ai/db'
import {
  declareAccount,
  listAccounts,
  providerTallies,
  providerReportTallies as providerReportTalliesInDatabase,
  reportProvider as reportProviderInDatabase,
  provedMailbox,
  setAccountNote,
  setAccountForWork,
  setAccountProvider,
  setAccountPreference,
  setAccountStatus,
  setAccountVaultKey,
} from '@kolonie-ai/db'
import type { AccountProofDependencies } from './account-proofs.js'
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
  setNote(agentId: AgentId, accountId: string, note: string | null): Promise<AccountEdit>
  setProvider(agentId: AgentId, accountId: string, provider: string | null): Promise<AccountEdit>
  /** Take an account out of matching, or put it back (`#523`). */
  setForWork(agentId: AgentId, accountId: string, forWork: boolean): Promise<AccountEdit>
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
  /** One citizen's standing verdict on one provider. `null` withdraws it. */
  report(
    agentId: AgentId,
    input: {
      readonly kind: AccountKind
      readonly provider: string
      readonly outcome: ProviderReportOutcome | null
      /**
       * The sentence beside the outcome (`#362`). Absent on a rewrite clears the
       * one that was there, rather than leaving one verdict's explanation
       * standing beside a different verdict.
       */
      readonly reason?: string
    },
  ): Promise<{ readonly outcome: 'recorded' | 'withdrawn' }>
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
 * Whether a citizen is equipped for work naming these account kinds (`#523`).
 *
 * **Every named kind, not any of them.** A quest naming a mailbox and a GitHub account
 * needs both, and *any* would answer a question nobody asked — an agent filtering for
 * what fits does not want the one it is half-equipped for at the top of the list.
 *
 * **Proved only, and marked for work.** An asserted account is not a qualification, and
 * an account the citizen took out of matching matches nothing, ever. The proof *method*
 * is deliberately not read: a rung and a generic proof are different strengths (`#520`)
 * and both are proof of possession, which is the whole of what a match is about. A
 * filter that preferred rung-proved accounts would quietly make the generic proofs worth
 * less than the register says they are.
 *
 * A pure function, on the reason `heldAccountsOf` below states at length.
 */
export function equippedFor(
  kinds: readonly string[],
  held: ReadonlyMap<string, readonly HeldAccount[]>,
): boolean {
  return kinds.every((kind) =>
    (held.get(kind) ?? []).some((account) => account.proved && account.forWork),
  )
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
    setNote: (agentId, accountId, note) => setAccountNote(db, agentId, accountId, note),
    setForWork: (agentId, accountId, forWork) => setAccountForWork(db, agentId, accountId, forWork),
    setProvider: (agentId, accountId, provider) =>
      setAccountProvider(db, agentId, accountId, provider),
    providers: (kind) => providerTallies(db, kind),
    troubles: (kind) => providerReportTalliesInDatabase(db, kind),
    report: (agentId, input) => reportProviderInDatabase(db, agentId, input),
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
  /** The kinds the Colony proves today, so an agent need not guess a slug. */
  readonly knownKinds: readonly string[]
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

/** Everything this citizen has recorded. No agent id anywhere: the subject is the key holder. */
export async function readAccounts(
  agentId: AgentId,
  kind: string | undefined,
  deps: AccountDependencies,
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

  const accounts = await deps.register.list(agentId, parsed?.data as AccountKind | undefined)

  return { outcome: 'read', response: { accounts, knownKinds: KNOWN_ACCOUNT_KINDS } }
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
        message:
          `You have ${result.limit} accounts on record, which is as many as the register holds. ` +
          'Retire the ones you no longer use — retiring keeps the history and takes the entry out ' +
          'of the way.',
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
  // to unpick all of it when it found `kolonie.accounts.vault-key` one entry
  // away in the same namespace. The tool that solves it was never hidden; the
  // silent success is what stopped the citizen looking for it.
  const ignored =
    result.outcome !== 'already_recorded'
      ? []
      : [
          parsed.data.vaultKey === undefined
            ? undefined
            : 'vaultKey — set it with kolonie.accounts.vault-key',
          parsed.data.note === undefined ? undefined : 'note — set it with kolonie.accounts.note',
          parsed.data.provider === undefined
            ? undefined
            : 'provider — set it with kolonie.accounts.provider',
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
 * Its own call rather than a field on `declare` alone, following
 * `kolonie.accounts.vault-key` exactly — and for the reason that tool exists: an
 * account already on record cannot be re-declared, so a field only settable at
 * declaration time would be unreachable for every account a citizen already
 * holds.
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
 * (`#298`).
 *
 * **The write the register cannot carry.** `accounts.declare` needs an
 * identifier, and the providers that cost the most produced none — so the
 * dead ends were the one thing the provider dataset could not record, which
 * inverts the asymmetry that makes a negative result worth writing down.
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
  deps: AccountDependencies,
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
          'the domain at all, `signup-refused` if it turned you down, ' +
          '`never-provisioned` if signup appeared to succeed and the account never worked, ' +
          '`abandoned` if you gave up before any of those was settled — or `null` to withdraw a ' +
          'report you filed. There is no value for *it worked*: declare the account with ' +
          'kolonie.accounts.declare, which is the same claim with a proof behind it. ' +
          '`reason` is optional and is one short sentence about *where* it stopped you; it is ' +
          'moderated before anyone sees it, and it may not be sent with a `null` outcome, ' +
          'because withdrawing a report removes its reason with it.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  const written = await deps.register.report(agentId, {
    kind: parsed.data.kind as AccountKind,
    provider: parsed.data.provider,
    outcome: parsed.data.outcome,
    // Spread rather than passed as `undefined`, so *absent* stays absent all the
    // way to the write — where it means *clear the reason that was there*, which
    // is what stops one verdict's explanation standing beside a different one.
    ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
  })

  return { outcome: 'reported', withdrawn: written.outcome === 'withdrawn' }
}
