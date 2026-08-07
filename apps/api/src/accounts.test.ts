import { describe, expect, it } from 'vitest'
import { AccountKindSchema, type Account } from '@kolonie-ai/core'
import { equippedFor, heldAccountsOf, type HeldAccount } from './accounts.js'

/**
 * **`preferred` is the citizen's ordering on every kind, and the reach address is
 * its own answer** (`#299`, D-050).
 *
 * The task listing wrote the reach address into `preferred` for mailboxes, so one
 * field name meant the citizen's preference on six kinds and the Colony's
 * obligation on the seventh. `kolonie.accounts.list` tells the citizen the
 * opposite in as many words — *"preferred is yours, not the Colony's"* — and a
 * citizen comparing the two surfaces for the same mailbox is what reported it.
 *
 * **These are unit tests of a pure function because that is the gap the defect
 * came through.** `apps/api` runs against a fake register, the fake had no
 * mailbox model, and the one line that differed between it and production was the
 * line that was wrong. A function taking rows and a reach address is the part both
 * wirings can be held to without a database.
 */
describe('the accounts a task listing offers', () => {
  const account = (
    identifier: string,
    fields: Partial<Pick<Account, 'kind' | 'proved' | 'preferred' | 'status'>> = {},
  ): Account => ({
    id: crypto.randomUUID(),
    kind: fields.kind ?? AccountKindSchema.parse('mailbox'),
    identifier,
    proved: fields.proved ?? true,
    // The pair `#520` requires: a proved row names what read it, and these rows
    // stand in for rung-proved ones.
    provedBy: (fields.proved ?? true) ? 'rung' : null,
    forWork: true,
    attestable: false,
    capabilities: [],
    status: fields.status ?? 'in-use',
    preferred: fields.preferred ?? false,
    note: null,
    vaultKey: null,
    provider: null,
    provenance: 'self-acquired',
    obtainedThroughTaskId: null,
    provedAt: null,
    confirmedAt: null,
    unconfirmedSince: null,
    createdAt: '2026-08-04T00:00:00.000Z',
  })

  it('reports the reach mailbox as reach and not as the citizen’s preference', () => {
    const held = heldAccountsOf(
      [account('written-to@example.org'), account('the-other@example.org')],
      'written-to@example.org',
    )

    expect(held).toEqual([
      {
        identifier: 'written-to@example.org',
        proved: true,
        preferred: false,
        reach: true,
        forWork: true,
      },
      {
        identifier: 'the-other@example.org',
        proved: true,
        preferred: false,
        reach: false,
        forWork: true,
      },
    ])
  })

  /**
   * The contradiction the citizen measured, from the other side: `accounts.list`
   * said `preferred:false` for a mailbox and `tasks.list` said `preferred:true`
   * for the same one. Whatever the reach address is, this field now answers the
   * register.
   */
  it('agrees with the register about preferred, whichever mailbox the Colony writes to', () => {
    const rows = [account('written-to@example.org'), account('chosen@example.org')]

    for (const reach of ['written-to@example.org', 'chosen@example.org', null]) {
      const held = heldAccountsOf(rows, reach)

      expect(held.map((entry) => entry.preferred)).toEqual([false, false])
    }
  })

  it('matches the reach address without regard to case, as the mail model does', () => {
    const held = heldAccountsOf([account('Written-To@Example.org')], 'written-to@example.org')

    expect(held[0]?.reach).toBe(true)
  })

  /**
   * **`reach` is false on every kind that is not mail**, and the caller is what
   * decides that: *primary* is a preference for a GitHub account and there is
   * nothing on the other end of a reach address (D-050). The listing passes null
   * for those kinds, which is what this asserts.
   */
  it('reports no reach address when the caller has none to give', () => {
    const held = heldAccountsOf(
      [
        account('@handle', { kind: AccountKindSchema.parse('social'), preferred: true }),
        account('@spare', { kind: AccountKindSchema.parse('social') }),
      ],
      null,
    )

    expect(held.map((entry) => entry.reach)).toEqual([false, false])
    expect(held.map((entry) => entry.preferred)).toEqual([true, false])
  })

  it('offers the reach address first, then the citizen’s preference', () => {
    const held = heldAccountsOf(
      [
        account('third@example.org'),
        account('preferred@example.org', { preferred: true }),
        account('reach@example.org'),
      ],
      'reach@example.org',
    )

    expect(held.map((entry) => entry.identifier)).toEqual([
      'reach@example.org',
      'preferred@example.org',
      'third@example.org',
    ])
  })

  it('omits what the citizen retired or lost, and keeps an unproved one marked', () => {
    const held = heldAccountsOf(
      [
        account('gone@example.org', { status: 'retired' }),
        account('stolen@example.org', { status: 'lost' }),
        account('fresh@example.org', { proved: false }),
      ],
      null,
    )

    expect(held).toEqual([
      {
        identifier: 'fresh@example.org',
        proved: false,
        preferred: false,
        reach: false,
        forWork: true,
      },
    ])
  })
})

/**
 * Which work a citizen is equipped for (`#523`).
 *
 * **A pure function under test**, on the argument the file's own header makes: the
 * defect that reached a citizen was one line differing between a fake and production,
 * and a predicate taking a resolved map is the part both wirings can be held to.
 */
describe('being equipped for work', () => {
  const held = (
    entries: Record<string, { proved?: boolean; forWork?: boolean }[]>,
  ): ReadonlyMap<string, readonly HeldAccount[]> =>
    new Map(
      Object.entries(entries).map(([kind, rows]) => [
        kind,
        rows.map((row, index) => ({
          identifier: `${kind}-${index}`,
          proved: row.proved ?? true,
          preferred: false,
          reach: false,
          forWork: row.forWork ?? true,
        })),
      ]),
    )

  it('needs every kind a task names, not any of them', () => {
    const one = held({ mailbox: [{}] })

    expect(equippedFor(['mailbox'], one)).toBe(true)
    // *Any* would answer a question nobody asked: an agent filtering for what fits
    // does not want the one it is half-equipped for at the top of the list.
    expect(equippedFor(['mailbox', 'github'], one)).toBe(false)
  })

  it('matches nothing on an account the citizen only declared', () => {
    // An asserted account is not a qualification, which is the same rule that keeps a
    // declared account from ever satisfying a verifier.
    expect(equippedFor(['trello'], held({ trello: [{ proved: false }] }))).toBe(false)
  })

  it('does not care which proof read it', () => {
    /**
     * **A rung and a generic proof are different strengths and both are possession**
     * (`#520`), which is the whole of what a match is about. A filter that preferred
     * rung-proved accounts would quietly make the generic proofs worth less than the
     * register says they are — so the method is not read here at all.
     */
    expect(equippedFor(['trello'], held({ trello: [{ proved: true }] }))).toBe(true)
  })

  it('matches nothing on an account taken out of matching', () => {
    expect(equippedFor(['trello'], held({ trello: [{ forWork: false }] }))).toBe(false)
    // And one of two is enough, because the citizen only withdrew the one.
    expect(equippedFor(['trello'], held({ trello: [{ forWork: false }, {}] }))).toBe(true)
  })

  it('is satisfied by a task that names no account at all', () => {
    // Which keeps the filter from being a gate on the whole Academy: most rungs name
    // no account, and every one of them stays visible under the narrowing.
    expect(equippedFor([], held({}))).toBe(true)
  })
})
