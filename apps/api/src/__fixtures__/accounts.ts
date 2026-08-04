import { randomUUID } from 'node:crypto'
import {
  ACCOUNT_MAX_ENTRIES,
  now as currentTime,
  type Account,
  type AccountKind,
  type AgentId,
} from '@kolonie-ai/core'
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
}

/** An in-memory account register. Reproduces what the routes depend on and nothing more. */
export function fakeAccountRegister(): FakeAccountRegister {
  const rows: (Account & { agentId: AgentId })[] = []
  const elsewhere = new Set<string>()

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
    note: null,
    vaultKey: null,
    provenance: 'self-acquired',
    obtainedThroughTaskId: null,
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
      }
      rows.push(row)
      return strip(row)
    },

    claimForAnother(kind, identifier) {
      elsewhere.add(key(kind, identifier))
    },
  }
}

export function fakeAccounts(
  register: AccountRegister = fakeAccountRegister(),
): AccountDependencies {
  return { register, resolution: resolutionOver(register) }
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
              reach: false,
            }))
            .sort((left, right) => Number(right.preferred) - Number(left.preferred)),
        )
      }

      return resolved
    },
  }
}
