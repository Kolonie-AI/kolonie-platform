import { randomBytes } from 'node:crypto'
import { and, count, eq, gt, isNull, sql } from 'drizzle-orm'
import {
  ACCOUNT_PROOF_LIFETIME_MS,
  ACCOUNT_PROOF_PREFIX,
  ACCOUNT_PROOF_SECRET_BYTES,
  ACCOUNT_PROOF_TOKEN_BYTES,
  AccountKindSchema,
  AgentIdSchema,
  MAX_OPEN_ACCOUNT_PROOFS,
  now as currentTime,
  type AccountKind,
  type AccountProvider,
  type AgentId,
  type GenericProofMethod,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accountProofs } from '../schema/account-proofs.js'
import { accounts } from '../schema/accounts.js'
import { mailboxIdentity } from '../schema/email.js'
import { recordProvedAccount } from './accounts.js'
import { isUniqueViolation } from './errors.js'
import { provedMailbox } from './email.js'
import { signupPace } from './signup-pace.js'
import type { SettingsReader } from './settings.js'
import { toTimestamp } from './rows.js'

/**
 * The two generic proofs, in storage (`#520`).
 *
 * **Adding a provider costs a row here and nothing else** — no migration, no
 * deploy, no verifier. That is the whole of D-059's argument applied to accounts:
 * the work is identical across providers and only the strings differ, so what is
 * written once is the reading of a mail and the reading of a page.
 */

/** A minted proof, as the citizen that opened it needs to see it. */
export interface MintedAccountProof {
  readonly id: string
  readonly kind: AccountKind
  readonly identifier: string
  readonly method: GenericProofMethod
  readonly secret: string
  /** The local part of the address to forward to. The API composes the host. */
  readonly token: string | null
  readonly expiresAt: Timestamp
}

export type MintOutcome =
  | { readonly outcome: 'minted'; readonly proof: MintedAccountProof }
  /**
   * A mail proof needs the mailbox this citizen proved, and it has none.
   *
   * **Refused rather than opened against a declared address.** The forwarded mail
   * is evidence only because it arrives from an address the Colony itself
   * verified; accepting one from an address the citizen merely asserted would make
   * the proof a mail anybody could send.
   */
  | { readonly outcome: 'no-proved-mailbox' }
  | { readonly outcome: 'too-many-open'; readonly open: number }
  /**
   * Another citizen already holds this identifier under this kind, proved.
   *
   * Checked at mint as a courtesy rather than as the boundary — the unique index
   * on `accounts` is the boundary, and it fires at the moment the proof is
   * recorded. Telling a citizen now saves it arranging a forwarded mail for an
   * account it can never register.
   */
  | { readonly outcome: 'already-proved-by-another' }
  /**
   * The operator's pace at this provider is spent for now (`#532`).
   *
   * **A deferral rather than a refusal, and the difference is not cosmetic.** Nothing
   * is minted, nothing is spent, and the recipe continues tomorrow — an agent told to
   * *try again* would treat this as a failure of its own and either loop or give up,
   * and both outcomes cost the register more than waiting does.
   */
  | {
      readonly outcome: 'defer'
      readonly used: number
      readonly ceiling: number
      readonly retryAfterMs: number
    }

/** How many proofs this citizen has open right now. */
export async function openAccountProofCount(db: Database, agentId: AgentId): Promise<number> {
  const [row] = await db
    .select({ open: count() })
    .from(accountProofs)
    .where(
      and(
        eq(accountProofs.agentId, agentId),
        isNull(accountProofs.verifiedAt),
        gt(accountProofs.expiresAt, sql`now()`),
      ),
    )

  return Number(row?.open ?? 0)
}

/**
 * Mint a proof.
 *
 * **A fresh secret every time, and no reuse of an open one.** The website rung
 * returns an existing open challenge; this does not, because the two are asked
 * different questions: there, one citizen proves one website and a second mint is
 * a retry. Here a citizen may legitimately have four proofs open at four
 * providers, so *the open one* is not a thing to return.
 */
export async function mintAccountProof(
  db: Database,
  agentId: AgentId,
  input: {
    readonly kind: AccountKind
    readonly identifier: string
    readonly method: GenericProofMethod
    readonly provider?: AccountProvider | null
  },
  /**
   * The live settings reader, for the pace cap (`#532`).
   *
   * **Optional so a deployment that has not wired it mints exactly as before**, which
   * is the arrangement `redeemRecheck` already uses in `EmailChallenges`. An absent
   * reader means no cap rather than a cap of zero: failing closed here would stop every
   * signup on a misconfiguration, which is a worse outcome than a burst.
   */
  settings?: SettingsReader,
): Promise<MintOutcome> {
  const open = await openAccountProofCount(db, agentId)
  if (open >= MAX_OPEN_ACCOUNT_PROOFS) return { outcome: 'too-many-open', open }

  const taken = await db
    .select({ agentId: accounts.agentId })
    .from(accounts)
    .where(
      and(
        eq(accounts.kind, input.kind),
        eq(accounts.proved, true),
        sql`lower(${accounts.identifier}) = lower(${input.identifier})`,
      ),
    )
    .limit(1)

  const held = taken[0]
  if (held !== undefined && held.agentId !== agentId) {
    return { outcome: 'already-proved-by-another' }
  }

  /**
   * The pace check, before anything is minted (`#532`).
   *
   * Placed here rather than at the route because this is the one act that happens
   * exactly once per account: a recipe's own steps happen at the provider where the
   * Colony cannot see them, and a handoff happens only where there is a wall. Counting
   * proofs counts accounts.
   *
   * **Only when a provider is named.** A proof with no provider cannot be attributed
   * to one, and a cap that counted those would throttle a citizen for declining to say
   * where its account is — which is a field that gates nothing by construction.
   */
  if (settings !== undefined && input.provider != null) {
    const pace = await signupPace(db, settings, agentId, input.kind, input.provider)
    if (pace.outcome === 'defer') {
      return {
        outcome: 'defer',
        used: pace.used,
        ceiling: pace.ceiling,
        retryAfterMs: pace.retryAfterMs,
      }
    }
  }

  let fromAddress: string | null = null
  if (input.method === 'provider-mail') {
    /**
     * **The register's own answer to *which mailbox*, rather than a second one.**
     * `provedMailbox` reads the primary stamp D-047 settled, and a query written
     * here would be a second ordering for one question — which is what `#136`
     * cost when the badge's subject moved by recency.
     */
    const mailbox = await provedMailbox(db, agentId)
    if (mailbox === undefined) return { outcome: 'no-proved-mailbox' }
    fromAddress = mailbox.address
  }

  /**
   * **A mail proof's string is shorter, because it has to be an address.**
   * `ACCOUNT_PROOF_TOKEN_BYTES` carries the arithmetic: 64 hex characters plus a
   * prefix exceeds RFC 5321's 64-octet local part, and the failure would appear
   * only against a real mail server.
   *
   * A published string has a ceiling of its own and it is not the same one
   * (`#1168`): `SHORTEST_MEASURED_PROFILE_LIMIT`, the shortest bio a citizen has
   * been measured trying to paste one into. Both figures are chosen where they
   * are documented; nothing here decides a length.
   */
  const bytes =
    input.method === 'provider-mail' ? ACCOUNT_PROOF_TOKEN_BYTES : ACCOUNT_PROOF_SECRET_BYTES
  const secret = `${ACCOUNT_PROOF_PREFIX}${randomBytes(bytes).toString('hex')}`
  const expiresAt = new Date(Date.now() + ACCOUNT_PROOF_LIFETIME_MS).toISOString()

  const [row] = await db
    .insert(accountProofs)
    .values({
      agentId,
      kind: input.kind,
      identifier: input.identifier,
      method: input.method,
      provider: input.provider ?? null,
      secret,
      fromAddress,
      expiresAt,
    })
    .returning()

  if (row === undefined) throw new Error('account_proofs insert returned no row')

  return {
    outcome: 'minted',
    proof: {
      id: row.id,
      kind: AccountKindSchema.parse(row.kind),
      identifier: row.identifier,
      method: row.method as GenericProofMethod,
      secret: row.secret,
      /**
       * **The secret is the local part for a mail proof, and null for a post.**
       * One value doing both jobs is what lets the inbound path find the row from
       * the recipient alone, and a post proof has no address to name.
       */
      token: row.method === 'provider-mail' ? row.secret : null,
      expiresAt: toTimestamp(row.expiresAt),
    },
  }
}

/** One open proof, for the path that is about to try to close it. */
export interface OpenProofRow {
  readonly id: string
  readonly agentId: AgentId
  readonly kind: AccountKind
  readonly identifier: string
  readonly method: GenericProofMethod
  readonly provider: string | null
  readonly secret: string
}

export async function openAccountProof(
  db: Database,
  agentId: AgentId,
  id: string,
): Promise<OpenProofRow | undefined> {
  const [row] = await db
    .select()
    .from(accountProofs)
    .where(
      and(
        eq(accountProofs.id, id),
        eq(accountProofs.agentId, agentId),
        isNull(accountProofs.verifiedAt),
        gt(accountProofs.expiresAt, sql`now()`),
      ),
    )
    .limit(1)

  if (row === undefined) return undefined

  return {
    id: row.id,
    agentId: AgentIdSchema.parse(row.agentId),
    kind: AccountKindSchema.parse(row.kind),
    identifier: row.identifier,
    method: row.method as GenericProofMethod,
    provider: row.provider,
    secret: row.secret,
  }
}

export type ProofRedemption =
  | {
      readonly outcome: 'proved'
      readonly kind: AccountKind
      readonly identifier: string
      /**
       * Who runs it, where the citizen named one, or null (`#907`).
       *
       * **Returned because the walk ask needs it and cannot ask for it.** A walk
       * is keyed on `(kind, provider)`, so a proof that comes back without the
       * provider it was minted with can only offer an ask the citizen would have
       * to complete by hand — which is the form-filling the prefill exists to
       * remove. Null where the citizen named none, and the ask is then absent
       * rather than guessed at.
       */
      readonly provider: string | null
    }
  | { readonly outcome: 'no-open-proof' }
  | { readonly outcome: 'already-proved-by-another' }

/**
 * Spend a `provider-post` proof: the Colony read the secret at the URL.
 *
 * **The read happens in `apps/api` and the write happens here**, which is the seam
 * every rung in this codebase draws: this package holds no host names, makes no
 * outbound requests, and takes the caller's word for nothing except *the string
 * was found*, which is the one thing only the fetcher knows.
 *
 * One transaction, so a proof cannot be spent by two concurrent submissions and a
 * row cannot be marked verified without the account being recorded.
 */
export async function redeemPostProof(
  db: Database,
  agentId: AgentId,
  id: string,
  url: string,
): Promise<ProofRedemption> {
  try {
    return await db.transaction(async (tx) => {
      const [spent] = await tx
        .update(accountProofs)
        .set({ verifiedAt: currentTime(), url })
        .where(
          and(
            eq(accountProofs.id, id),
            eq(accountProofs.agentId, agentId),
            eq(accountProofs.method, 'provider-post'),
            isNull(accountProofs.verifiedAt),
            gt(accountProofs.expiresAt, sql`now()`),
          ),
        )
        .returning()

      if (spent === undefined) return { outcome: 'no-open-proof' as const }

      await recordProvedAccount(tx, agentId, {
        kind: AccountKindSchema.parse(spent.kind),
        identifier: spent.identifier,
        /**
         * **No capability is claimed, and that is a decision** (`#520`).
         *
         * `capabilities` is what a *verdict* proved an account can do — `receive`,
         * `send`, `publish`, `sign` — and a generic proof demonstrates possession
         * and nothing else. Writing `publish` here because the citizen published
         * something would be the conflation the issue forbids, wearing a different
         * costume: the string appeared at a URL the citizen named, which is not the
         * Colony reading a post by a handle it resolved.
         */
        capabilities: [],
        provedAt: currentTime(),
        provedBy: 'provider-post',
      })

      if (spent.provider !== null) {
        await tx
          .update(accounts)
          .set({ provider: spent.provider, updatedAt: sql`now()` })
          .where(
            and(
              eq(accounts.agentId, agentId),
              eq(accounts.kind, spent.kind),
              sql`lower(${accounts.identifier}) = lower(${spent.identifier})`,
              isNull(accounts.provider),
            ),
          )
      }

      return {
        outcome: 'proved' as const,
        kind: AccountKindSchema.parse(spent.kind),
        identifier: spent.identifier,
        provider: spent.provider,
      }
    })
  } catch (error) {
    /**
     * The unique index on `accounts` is the boundary the mint's courtesy check
     * only approximates: another citizen may have proved the same identifier in
     * between. Reported as its own outcome rather than as a failure, because the
     * citizen has done nothing wrong and needs to know which of the two it is.
     */
    /**
     * **`isUniqueViolation` and not a constraint name of this module's own.**
     * Drizzle wraps the driver's error, so the SQLSTATE lives on the `cause` and
     * a check reading `error.constraint_name` finds nothing — which is exactly
     * how the race test found this. That helper already walks the chain, and it
     * says in its own comment why a second copy of the walk is a second place to
     * get it wrong.
     *
     * The only unique index a proof can violate is the register's
     * `accounts_proved_identifier_unique`: a proof's own `secret` is minted here
     * from 9 or 32 random bytes, so a collision on that one is not a case worth
     * modelling a second outcome for.
     */
    if (isUniqueViolation(error)) return { outcome: 'already-proved-by-another' }
    throw error
  }
}

export type InboundProofOutcome =
  | { readonly outcome: 'accepted'; readonly kind: AccountKind; readonly identifier: string }
  | { readonly outcome: 'unknown_token' }
  | { readonly outcome: 'sender_mismatch' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'already_received' }

/**
 * A forwarded mail arrived at a proof's address (`#520`).
 *
 * **The sender is the binding and it is matched in the `where`**, not read and
 * compared afterwards: the row is only updated if the mail came from the mailbox
 * recorded at mint, so there is no window in which a matching token with a
 * mismatched sender could spend the proof.
 *
 * `mailboxIdentity` on both sides, which is the same normalisation the mailbox
 * rung uses — a citizen forwarding from `Name <addr>` or with different case has
 * forwarded from its address.
 */
export async function recordInboundProof(
  db: Database,
  token: string,
  from: string,
): Promise<InboundProofOutcome> {
  const accepted = await db.transaction(async (tx) => {
    const [spent] = await tx
      .update(accountProofs)
      .set({ verifiedAt: currentTime() })
      .where(
        and(
          eq(accountProofs.secret, token),
          eq(accountProofs.method, 'provider-mail'),
          isNull(accountProofs.verifiedAt),
          gt(accountProofs.expiresAt, sql`now()`),
          sql`${mailboxIdentity(accountProofs.fromAddress)} = ${mailboxIdentity(sql`${from}`)}`,
        ),
      )
      .returning()

    if (spent === undefined) return undefined

    const owner = AgentIdSchema.parse(spent.agentId)

    await recordProvedAccount(tx, owner, {
      kind: AccountKindSchema.parse(spent.kind),
      identifier: spent.identifier,
      // Possession, and nothing more — see `redeemPostProof` for the argument.
      capabilities: [],
      provedAt: currentTime(),
      provedBy: 'provider-mail',
    })

    if (spent.provider !== null) {
      await tx
        .update(accounts)
        .set({ provider: spent.provider, updatedAt: sql`now()` })
        .where(
          and(
            eq(accounts.agentId, owner),
            eq(accounts.kind, spent.kind),
            sql`lower(${accounts.identifier}) = lower(${spent.identifier})`,
            isNull(accounts.provider),
          ),
        )
    }

    return spent
  })

  if (accepted !== undefined) {
    return {
      outcome: 'accepted',
      kind: AccountKindSchema.parse(accepted.kind),
      identifier: accepted.identifier,
    }
  }

  /**
   * Why it did not land, and the order matters.
   *
   * An unknown token is answered first because it is the only one that means *this
   * mail is not about a proof at all* — the inbound handler tries the mailbox
   * challenges too, and a token belonging to neither must be distinguishable from
   * one belonging to this table with something else wrong.
   */
  const [row] = await db
    .select({
      verifiedAt: accountProofs.verifiedAt,
      /**
       * Compared in SQL rather than in TypeScript, because `mailboxIdentity` is
       * the normalisation the unique index is built on and a second
       * implementation of it here is a second thing to keep correct — the same
       * argument `safeFetch` makes about its address list.
       */
      senderMatches: sql<boolean>`${mailboxIdentity(accountProofs.fromAddress)} = ${mailboxIdentity(sql`${from}`)}`,
    })
    .from(accountProofs)
    .where(and(eq(accountProofs.secret, token), eq(accountProofs.method, 'provider-mail')))
    .limit(1)

  if (row === undefined) return { outcome: 'unknown_token' }
  if (row.verifiedAt !== null) return { outcome: 'already_received' }
  if (row.senderMatches !== true) return { outcome: 'sender_mismatch' }

  return { outcome: 'expired' }
}
