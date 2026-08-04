import { z } from 'zod'
import {
  ACCOUNT_NOTE_MAX_LENGTH,
  AccountStatusSchema,
  KNOWN_ACCOUNT_KINDS,
  type Account,
  type AccountKind,
  type AccountStatus,
  type AgentId,
  type ApiError,
} from '@kolonie-ai/core'
import type { AccountDeclaration, AccountEdit, Database } from '@kolonie-ai/db'
import {
  declareAccount,
  listAccounts,
  provedMailbox,
  setAccountNote,
  setAccountPreference,
  setAccountStatus,
  setAccountVaultKey,
} from '@kolonie-ai/db'
import { fieldErrors } from './validation.js'

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
    },
  ): Promise<AccountDeclaration>
  setStatus(agentId: AgentId, accountId: string, status: AccountStatus): Promise<AccountEdit>
  setNote(agentId: AgentId, accountId: string, note: string | null): Promise<AccountEdit>
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
  readonly preferred: boolean
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
 */
export function databaseAccountResolution(db: Database): AccountResolution {
  return {
    async heldByKind(agentId, kinds) {
      const resolved = new Map<string, readonly HeldAccount[]>()

      for (const kind of kinds) {
        const held = await listAccounts(db, agentId, kind as AccountKind)
        const reach =
          kind === 'mailbox' ? ((await provedMailbox(db, agentId))?.address ?? null) : null

        resolved.set(
          kind,
          held
            // Retired and lost are omitted: the citizen said so, and offering
            // one back would be the Colony overriding the one field it does not
            // own.
            .filter((account) => account.status === 'in-use')
            .map((account) => ({
              identifier: account.identifier,
              proved: account.proved,
              preferred:
                kind === 'mailbox'
                  ? reach !== null && reach.toLowerCase() === account.identifier.toLowerCase()
                  : account.preferred,
            }))
            .sort((left, right) => Number(right.preferred) - Number(left.preferred)),
        )
      }

      return resolved
    },
  }
}

/** Storage wired to a real database. The only place these two meet. */
export function databaseAccounts(db: Database): AccountRegister {
  return {
    list: (agentId, kind) => listAccounts(db, agentId, kind),
    declare: (agentId, input) => declareAccount(db, agentId, input),
    setStatus: (agentId, accountId, status) => setAccountStatus(db, agentId, accountId, status),
    setNote: (agentId, accountId, note) => setAccountNote(db, agentId, accountId, note),
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

export type AccountsResponse = {
  readonly accounts: readonly Account[]
  /** The kinds the Colony proves today, so an agent need not guess a slug. */
  readonly knownKinds: readonly string[]
}

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
