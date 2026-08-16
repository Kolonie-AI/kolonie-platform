import { randomUUID } from 'node:crypto'
import {
  ACCOUNT_MAX_ENTRIES,
  ACCOUNT_PROOF_LIFETIME_MS,
  MAX_OPEN_ACCOUNT_PROOFS,
  now as currentTime,
  type Account,
  type AccountKind,
  type ProviderReportTally,
  type AgentId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { AccountProofs } from '../account-proofs.js'
import type {
  AccountRegister,
  AccountDependencies,
  AccountResolution,
  HeldAccount,
} from '../accounts.js'

export interface FakeAccountRegister extends AccountRegister {
  /**
   * Record a proved account without running a rung.
   *
   * The route tests are about the register's own surface; getting a proved row
   * in place should not require driving a verifier, and the *only* production
   * path that sets `proved` is the verdict transaction in `packages/db` — which
   * is asserted there, against a real database, where that property actually
   * lives.
   */
  readonly proveDirectly: (
    agentId: AgentId,
    account: Partial<Account> & { kind: string; identifier: string },
  ) => Account
  /** Put an account on another citizen's record, to exercise the uniqueness rule. */
  readonly claimForAnother: (kind: string, identifier: string) => void
  /**
   * Put one row into the provider tally, which nothing here can produce
   * (`#1036`).
   *
   * The verdicts behind that aggregate are `account_walks` rows now: filing a
   * report through this API writes a walk, and the tally is a join across two
   * tables in `packages/db`. A test about what the *read* publishes therefore
   * has to state its own row — the same escape hatch, and the same reason, as
   * {@link proveDirectly} above.
   */
  readonly trouble: (tally: ProviderReportTally) => void
  /**
   * Whether {@link claimForAnother} has taken this one (`#520`).
   *
   * Exposed so the proofs fake can refuse what production's unique index refuses,
   * rather than keeping a second set of its own and having the two disagree about
   * which accounts are taken.
   */
  readonly claimedElsewhere: (kind: string, identifier: string) => boolean
  /**
   * Who holds one account, by id, whoever they are (`#933`).
   *
   * `list` answers *this agent's accounts* and is the right shape for every
   * route, which is exactly why it cannot serve here: the thread fake needs to
   * adopt an account the moment the register makes one, and at that point it
   * knows the id and not the agent. In production the two are one row and a
   * trigger joins them; this is the reader that lets the fake do the same
   * rather than requiring every test to register the account twice.
   */
  readonly holder: (accountId: string) =>
    | {
        readonly agentId: AgentId
        readonly kind: string
        readonly identifier: string
        readonly provider: string | null
      }
    | undefined
}

/** An in-memory account register. Reproduces what the routes depend on and nothing more. */
export function fakeAccountRegister(): FakeAccountRegister {
  const rows: (Account & { agentId: AgentId })[] = []
  const elsewhere = new Set<string>()
  /** Seeded by {@link FakeAccountRegister.trouble} and by nothing else. */
  const tallies: ProviderReportTally[] = []

  const key = (kind: string, identifier: string) => `${kind}:${identifier.toLowerCase()}`

  const blank = (
    agentId: AgentId,
    kind: string,
    identifier: string,
  ): Account & { agentId: AgentId } => ({
    agentId,
    id: randomUUID(),
    kind: kind as AccountKind,
    identifier,
    proved: false,
    capabilities: [],
    status: 'in-use',
    preferred: false,
    forWork: true,
    attestable: false,
    shownOnProfile: false,
    note: null,
    vaultKey: null,
    provenance: 'self-acquired',
    obtainedThroughTaskId: null,
    provedBy: null,
    provedAt: null,
    confirmedAt: null,
    unconfirmedSince: null,
    provider: null,
    createdAt: currentTime(),
  })

  const own = (agentId: AgentId, accountId: string) =>
    rows.find((row) => row.agentId === agentId && row.id === accountId)

  const strip = ({ agentId: _agentId, ...account }: Account & { agentId: AgentId }): Account =>
    account

  return {
    async list(agentId, kind) {
      return rows
        .filter((row) => row.agentId === agentId && (kind === undefined || row.kind === kind))
        .sort(
          (a, b) =>
            Number(b.proved) - Number(a.proved) || Number(b.preferred) - Number(a.preferred),
        )
        .map(strip)
    },

    async declare(agentId, input) {
      const existing = rows.find(
        (row) =>
          row.agentId === agentId &&
          row.kind === input.kind &&
          row.identifier.toLowerCase() === input.identifier.toLowerCase(),
      )
      if (existing !== undefined) return { outcome: 'already_recorded', account: strip(existing) }

      const taken =
        elsewhere.has(key(input.kind, input.identifier)) ||
        rows.some(
          (row) =>
            row.agentId !== agentId &&
            row.proved &&
            row.kind === input.kind &&
            row.identifier.toLowerCase() === input.identifier.toLowerCase(),
        )

      // `website` is shareable — the one exception, mirrored from
      // `ACCOUNT_KINDS_ALLOWING_SHARING` so the fixture cannot be laxer than the
      // index the real thing is enforced by.
      if (taken && input.kind !== 'website') return { outcome: 'identifier_taken' }

      if (rows.filter((row) => row.agentId === agentId).length >= ACCOUNT_MAX_ENTRIES) {
        return { outcome: 'too_many', limit: ACCOUNT_MAX_ENTRIES }
      }

      const row = {
        ...blank(agentId, input.kind, input.identifier),
        note: input.note ?? null,
        vaultKey: input.vaultKey ?? null,
        provider: input.provider ?? null,
      }
      rows.push(row)
      return { outcome: 'declared', account: strip(row) }
    },

    async setStatus(agentId, accountId, status) {
      const row = own(agentId, accountId)
      if (row === undefined) return { outcome: 'not_found' }
      row.status = status
      return { outcome: 'updated', account: strip(row) }
    },

    /**
     * The same three outcomes `forgetDeclaredAccount` has, on the same rule
     * (`#923`). `refused-proved` is named only for a row this caller owns, so
     * the fake cannot answer a question about a stranger's id that production
     * refuses to answer.
     */
    async forget(agentId, accountId) {
      const row = own(agentId, accountId)
      if (row === undefined) return { outcome: 'not_found' }
      if (row.proved) return { outcome: 'refused-proved' }

      rows.splice(rows.indexOf(row), 1)
      return { outcome: 'forgotten' }
    },

    async setNote(agentId, accountId, note) {
      const row = own(agentId, accountId)
      if (row === undefined) return { outcome: 'not_found' }
      row.note = note
      return { outcome: 'updated', account: strip(row) }
    },

    async setVaultKey(agentId, accountId, vaultKey) {
      const row = own(agentId, accountId)
      if (row === undefined) return { outcome: 'not_found' }
      row.vaultKey = vaultKey
      return { outcome: 'updated', account: strip(row) }
    },

    async setAttestable(agentId, accountId, attestable) {
      const row = own(agentId, accountId)
      if (row === undefined) return { outcome: 'not_found' }
      row.attestable = attestable
      /**
       * The real `setAccountAttestable` widens its own update for this, because
       * the check constraint would otherwise refuse a citizen asking for *less*
       * exposure (`#821`). The fake carries the same rule rather than leaving
       * the two to disagree — a fixture that permits a state the database
       * refuses is a test suite that passes on rows production cannot hold.
       */
      if (!attestable) row.shownOnProfile = false
      return { outcome: 'updated', account: strip(row) }
    },

    async setShownOnProfile(agentId, accountId, shown) {
      const row = own(agentId, accountId)
      if (row === undefined) return { outcome: 'not_found' }
      /** `accounts_shown_is_proved_and_attestable`, as the fake can express it. */
      if (shown && !(row.proved && row.attestable)) return { outcome: 'not_found' }
      row.shownOnProfile = shown
      return { outcome: 'updated', account: strip(row) }
    },

    async setForWork(agentId, accountId, forWork) {
      const row = own(agentId, accountId)
      if (row === undefined) return { outcome: 'not_found' }
      row.forWork = forWork
      return { outcome: 'updated', account: strip(row) }
    },

    async setProvider(agentId, accountId, provider) {
      const row = own(agentId, accountId)
      if (row === undefined) return { outcome: 'not_found' }
      row.provider = provider
      return { outcome: 'updated', account: strip(row) }
    },

    /**
     * The aggregate, counted the way the real one counts it (`#288`).
     *
     * **Citizens rather than rows**, which is the one property of this query
     * worth reimplementing in a fixture: a fake that counted accounts would let
     * a test pass while a provider looked popular because one agent held three
     * mailboxes there. Whether Postgres groups it the same way is asserted in
     * `packages/db` against a real one.
     */
    async providers(kind) {
      const tallies = new Map<string, { citizens: Set<AgentId>; proved: Set<AgentId> }>()

      for (const row of rows) {
        if (row.provider === null) continue
        if (kind !== undefined && row.kind !== kind) continue

        const at = `${row.kind}\u0000${row.provider}`
        const tally = tallies.get(at) ?? { citizens: new Set(), proved: new Set() }
        tally.citizens.add(row.agentId)
        if (row.proved) tally.proved.add(row.agentId)
        tallies.set(at, tally)
      }

      return [...tallies.entries()]
        .map(([at, tally]) => {
          const [tallyKind = '', provider = ''] = at.split('\u0000')
          return {
            kind: tallyKind as Account['kind'],
            provider,
            citizens: tally.citizens.size,
            proved: tally.proved.size,
          }
        })
        .sort(
          (a, b) =>
            b.proved - a.proved || b.citizens - a.citizens || (a.provider < b.provider ? -1 : 1),
        )
    },

    /**
     * Providers that produced no account (`#298`), which this register no longer
     * has any way to know about (`#1036`).
     *
     * **Seeded and never computed.** Those verdicts are `account_walks` rows
     * now, so the tally is a join across two tables and a correlated `exists` —
     * reproducing it here would be a second implementation of a query whose
     * whole point is that there is one. What it produces is asserted in
     * `packages/db/src/storage/provider-reports.test.ts`, against a real
     * database, where both tables actually are. Nothing in `apps/api` reaches
     * this by filing a report either: that write left the port with the
     * `report` member `#1036` removed, and goes to the walk store. A test about
     * what this read *publishes* therefore states its own row with {@link
     * FakeAccountRegister.trouble}.
     */
    async troubles(kind) {
      return tallies.filter((tally) => kind === undefined || tally.kind === kind)
    },

    async prefer(agentId, accountId) {
      const row = own(agentId, accountId)
      if (row === undefined) return { outcome: 'not_found' }
      if (row.kind === 'mailbox') return { outcome: 'mail_has_no_preference' }

      for (const other of rows) {
        if (other.agentId === agentId && other.kind === row.kind) other.preferred = false
      }
      row.preferred = true
      return { outcome: 'updated', account: strip(row) }
    },

    proveDirectly(agentId, account) {
      const row = {
        ...blank(agentId, account.kind, account.identifier),
        ...account,
        agentId,
        id: randomUUID(),
        kind: account.kind as AccountKind,
        proved: true,
        provedAt: account.provedAt ?? currentTime(),
        /**
         * **The fake holds the invariant the check constraint holds** (`#520`): a
         * proved row names what read it. Defaulting to `rung` rather than leaving
         * null, because a test that wanted a generic proof says so and every other
         * one is standing in for a verdict.
         *
         * This is the line the fixture comment above is about — the fake diverging
         * from production by one field is how the mailbox defect got through, and a
         * null here would be a state the database refuses.
         */
        provedBy: account.provedBy ?? 'rung',
      }
      rows.push(row)
      return strip(row)
    },

    trouble(tally) {
      tallies.push(tally)
    },

    claimForAnother(kind, identifier) {
      elsewhere.add(key(kind, identifier))
    },

    claimedElsewhere(kind, identifier) {
      return elsewhere.has(key(kind, identifier))
    },

    holder(accountId) {
      const row = rows.find((one) => one.id === accountId)
      if (row === undefined) return undefined
      return {
        agentId: row.agentId,
        kind: String(row.kind),
        identifier: row.identifier,
        provider: row.provider,
      }
    },
  }
}

export function fakeAccounts(
  register: FakeAccountRegister = fakeAccountRegister(),
): AccountDependencies {
  return {
    register,
    resolution: resolutionOver(register),
    proofs: { proofs: fakeAccountProofs(register), challengeDomain: 'challenge.example' },
  }
}

/**
 * The two generic proofs, in memory (`#520`).
 *
 * **Built over whichever register the test is using**, on the reason
 * {@link resolutionOver} gives: a proof that lands has to be visible in the
 * register afterwards without the test saying so twice, because that is what the
 * real wiring does — one transaction spends the proof and records the account.
 *
 * **`provider-mail` refuses unless the register holds a proved mailbox.** That is
 * the fake's one real rule and it is the rule production has: the forwarded
 * message is evidence only because it arrived from an address the Colony verified.
 * A fixture that skipped it would let the tests pass a path production refuses,
 * which is the divergence this file's own comments are about.
 */
export function fakeAccountProofs(register: FakeAccountRegister): AccountProofs {
  type Row = {
    id: string
    agentId: AgentId
    kind: string
    identifier: string
    method: 'provider-mail' | 'provider-post'
    provider: string | null
    secret: string
    fromAddress: string | null
    verifiedAt: string | null
    expiresAt: string
  }
  const rows: Row[] = []

  const provedMailboxOf = async (agentId: AgentId): Promise<string | undefined> => {
    const held = await register.list(agentId)

    return held.find((account) => account.kind === 'mailbox' && account.proved)?.identifier
  }

  const record = async (row: Row): Promise<void> => {
    row.verifiedAt = new Date().toISOString()
    register.proveDirectly(row.agentId, {
      kind: row.kind as AccountKind,
      identifier: row.identifier,
      // Possession and nothing more, exactly as storage records it.
      capabilities: [],
      provedBy: row.method,
      ...(row.provider === null ? {} : { provider: row.provider }),
    })
  }

  return {
    async mint(agentId, input) {
      const open = rows.filter(
        (row) =>
          row.agentId === agentId &&
          row.verifiedAt === null &&
          row.expiresAt > new Date().toISOString(),
      ).length
      if (open >= MAX_OPEN_ACCOUNT_PROOFS) return { outcome: 'too-many-open', open }

      if (register.claimedElsewhere(input.kind, input.identifier)) {
        return { outcome: 'already-proved-by-another' }
      }

      let fromAddress: string | null = null
      if (input.method === 'provider-mail') {
        const mailbox = await provedMailboxOf(agentId)
        if (mailbox === undefined) return { outcome: 'no-proved-mailbox' }
        fromAddress = mailbox
      }

      const row: Row = {
        id: randomUUID(),
        agentId,
        kind: input.kind,
        identifier: input.identifier,
        method: input.method,
        provider: input.provider ?? null,
        secret: `kol_acct_${randomUUID().replaceAll('-', '')}`,
        fromAddress,
        verifiedAt: null,
        expiresAt: new Date(Date.now() + ACCOUNT_PROOF_LIFETIME_MS).toISOString(),
      }
      rows.push(row)

      return {
        outcome: 'minted',
        proof: {
          id: row.id,
          kind: row.kind as AccountKind,
          identifier: row.identifier,
          method: row.method,
          secret: row.secret,
          token: row.method === 'provider-mail' ? row.secret : null,
          expiresAt: row.expiresAt as Timestamp,
        },
      }
    },

    async open(agentId, id) {
      const row = rows.find(
        (candidate) =>
          candidate.id === id &&
          candidate.agentId === agentId &&
          candidate.verifiedAt === null &&
          candidate.expiresAt > new Date().toISOString(),
      )

      if (row === undefined) return undefined

      return {
        id: row.id,
        agentId: row.agentId,
        kind: row.kind as AccountKind,
        identifier: row.identifier,
        method: row.method,
        provider: row.provider,
        secret: row.secret,
      }
    },

    async redeemPost(agentId, id, _url) {
      const row = rows.find(
        (candidate) =>
          candidate.id === id &&
          candidate.agentId === agentId &&
          candidate.method === 'provider-post' &&
          candidate.verifiedAt === null &&
          candidate.expiresAt > new Date().toISOString(),
      )

      if (row === undefined) return { outcome: 'no-open-proof' }
      if (register.claimedElsewhere(row.kind, row.identifier)) {
        return { outcome: 'already-proved-by-another' }
      }

      await record(row)

      return {
        outcome: 'proved',
        kind: row.kind as AccountKind,
        identifier: row.identifier,
        /** Carried since `#907`: the walk ask is keyed on it and cannot ask for it. */
        provider: row.provider,
      }
    },

    async inbound(token, from) {
      const row = rows.find(
        (candidate) => candidate.secret === token && candidate.method === 'provider-mail',
      )

      if (row === undefined) return { outcome: 'unknown_token' }
      if (row.verifiedAt !== null) return { outcome: 'already_received' }
      if (row.fromAddress?.toLowerCase() !== from.toLowerCase()) {
        return { outcome: 'sender_mismatch' }
      }
      if (row.expiresAt <= new Date().toISOString()) return { outcome: 'expired' }

      await record(row)

      return { outcome: 'accepted', kind: row.kind as AccountKind, identifier: row.identifier }
    },
  }
}

/**
 * The task listing's narrow read, over whichever register the test is using
 * (`#151`).
 *
 * Built from the register rather than kept separately, so a test that proves an
 * account through the fixture sees it in the listing without saying so twice —
 * which is what the real wiring does too.
 *
 * **`reach` is always false here, and it is a fake rather than a claim**
 * (`#299`). Production reads it from the mail model; owning one would make this
 * fixture a second mailbox implementation, and the property it would assert is
 * D-047's, which is tested against a real database in `packages/db`. What this
 * fixture is good for is the half that is not mail: `preferred` is the
 * register's flag, unconditionally, on every kind.
 */
export function resolutionOver(register: AccountRegister): AccountResolution {
  return {
    async heldByKind(agentId, kinds) {
      const resolved = new Map<string, readonly HeldAccount[]>()

      for (const kind of kinds) {
        const held = await register.list(agentId, kind as AccountKind)
        resolved.set(
          kind,
          held
            .filter((account) => account.status === 'in-use')
            .map((account) => ({
              identifier: account.identifier,
              proved: account.proved,
              preferred: account.preferred,
              // The register's own flag, so a test that turns matching off sees it
              // turned off — `#523`'s one rule the fake could silently not hold.
              forWork: account.forWork,
              reach: false,
            }))
            .sort((left, right) => Number(right.preferred) - Number(left.preferred)),
        )
      }

      return resolved
    },
  }
}
