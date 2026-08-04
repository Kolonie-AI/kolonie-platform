import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, authorityEvents, ledgerEntries } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import {
  accountFundingSource,
  creditBalance,
  externalVolume,
  fundingSourceForDeposit,
  overrideCreditFundingSource,
  setAccountFundingSource,
} from './funding.js'

const target = databaseTestTarget()

describe('whose money it was', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw', status: 'citizen' })
      .returning({ id: agents.id })
    return row!.id as AgentId
  }

  const creditsOf = (agentId: AgentId) =>
    db.select().from(ledgerEntries).where(eq(ledgerEntries.agentId, agentId))

  describe('the credit', () => {
    it('records the source on every entry of the booking', async () => {
      const sponsor = await anAgent('sponsor')
      const steward = await anAgent('steward')

      await db.transaction((tx) =>
        creditBalance(tx, {
          agentId: sponsor,
          amount: 50_000,
          source: 'external',
          actorId: steward,
          reference: `deposit:${sponsor}`,
        }),
      )

      const rows = await db.select().from(ledgerEntries)
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(row.fundingSource).toBe('external')
        expect(row.type).toBe('balance_credit')
      }
    })

    /**
     * The constraint, both directions. A credit without a source is money whose
     * origin nobody can reconstruct; a source on anything else is an accounting
     * fact attached to an event it is not about.
     */
    it('refuses a balance credit that does not say whose money it was', async () => {
      const sponsor = await anAgent('sponsor')

      await expectRejection(
        () =>
          db.insert(ledgerEntries).values([
            {
              transactionId: crypto.randomUUID(),
              accountKind: 'agent' as const,
              agentId: sponsor,
              amount: 100,
              type: 'balance_credit' as const,
              reference: 'no-source',
            },
          ]),
        /ledger_entries_funding_source_iff_credit/,
      )
    })

    it('refuses a source on an entry that is not a balance credit', async () => {
      const sponsor = await anAgent('sponsor')

      await expectRejection(
        () =>
          db.insert(ledgerEntries).values([
            {
              transactionId: crypto.randomUUID(),
              accountKind: 'agent' as const,
              agentId: sponsor,
              amount: 100,
              type: 'task_reward' as const,
              fundingSource: 'external' as const,
              reference: 'wrong-place',
            },
          ]),
        /ledger_entries_funding_source_iff_credit/,
      )
    })

    it('refuses a credit that moves money the wrong way', async () => {
      const sponsor = await anAgent('sponsor')

      await expect(
        db.transaction((tx) =>
          creditBalance(tx, {
            agentId: sponsor,
            amount: -1,
            source: 'bootstrap',
            actorId: null,
            reference: 'backwards',
          }),
        ),
      ).rejects.toThrow(/must be positive/)
    })
  })

  describe('the account default', () => {
    it('is null until a steward says, which is not the same as unclassified', async () => {
      const sponsor = await anAgent('sponsor')

      expect(await accountFundingSource(db, sponsor)).toBeNull()
      expect(await fundingSourceForDeposit(db, sponsor)).toBe('unclassified')
    })

    it('is what a deposit inherits once it is set', async () => {
      const sponsor = await anAgent('sponsor')
      const steward = await anAgent('steward')
      await db.transaction((tx) =>
        setAccountFundingSource(tx, { agentId: sponsor, source: 'bootstrap', actorId: steward }),
      )

      expect(await fundingSourceForDeposit(db, sponsor)).toBe('bootstrap')
    })

    it('writes an audit row naming who decided', async () => {
      const sponsor = await anAgent('sponsor')
      const steward = await anAgent('steward')

      await db.transaction((tx) =>
        setAccountFundingSource(tx, { agentId: sponsor, source: 'external', actorId: steward }),
      )

      const [event] = await db
        .select()
        .from(authorityEvents)
        .where(eq(authorityEvents.action, 'funding-source-set'))
      expect(event?.actorId).toBe(steward)
      expect(event?.subjectAgentId).toBe(sponsor)
    })
  })

  describe('the override', () => {
    it('moves every entry of the booking together', async () => {
      const sponsor = await anAgent('sponsor')
      const steward = await anAgent('steward')
      await db.transaction((tx) =>
        creditBalance(tx, {
          agentId: sponsor,
          amount: 500,
          source: 'bootstrap',
          actorId: steward,
          reference: `deposit:${sponsor}`,
        }),
      )
      const [entry] = await creditsOf(sponsor)

      const moved = await db.transaction((tx) =>
        overrideCreditFundingSource(tx, {
          transactionId: entry!.transactionId,
          source: 'external',
          actorId: steward,
        }),
      )

      expect(moved).toBe(2)
      for (const row of await db.select().from(ledgerEntries)) {
        expect(row.fundingSource).toBe('external')
      }
    })

    it('writes an audit row', async () => {
      const sponsor = await anAgent('sponsor')
      const steward = await anAgent('steward')
      await db.transaction((tx) =>
        creditBalance(tx, {
          agentId: sponsor,
          amount: 500,
          source: 'bootstrap',
          actorId: steward,
          reference: `deposit:${sponsor}`,
        }),
      )
      const [entry] = await creditsOf(sponsor)

      await db.transaction((tx) =>
        overrideCreditFundingSource(tx, {
          transactionId: entry!.transactionId,
          source: 'external',
          actorId: steward,
        }),
      )

      const [event] = await db
        .select()
        .from(authorityEvents)
        .where(eq(authorityEvents.action, 'funding-source-overridden'))
      expect(event?.actorId).toBe(steward)
      expect(event?.subjectAgentId).toBe(sponsor)
    })
  })

  describe('the external figure', () => {
    const creditAs = async (source: 'bootstrap' | 'external' | 'unclassified', amount: number) => {
      const sponsor = await anAgent(`sponsor-${source}-${amount}`)
      await db.transaction((tx) =>
        creditBalance(tx, {
          agentId: sponsor,
          amount,
          source,
          actorId: null,
          reference: `deposit:${sponsor}`,
        }),
      )
    }

    it('sums only what somebody else paid for', async () => {
      await creditAs('external', 300)
      await creditAs('external', 200)
      await creditAs('bootstrap', 10_000)

      expect(await externalVolume(db)).toBe(500)
    })

    /**
     * Excluded rather than counted optimistically: a credit nobody has
     * classified is not evidence of external demand, and counting it would make
     * the curve the coin is priced off flatter to exactly the extent the
     * bookkeeping was behind.
     */
    it('excludes what nobody has classified', async () => {
      await creditAs('external', 100)
      await creditAs('unclassified', 900)

      expect(await externalVolume(db)).toBe(100)
    })

    it('is held in no table', async () => {
      const columns = await db.execute<{ column_name: string }>(
        sql`select column_name from information_schema.columns
             where table_schema = 'public'
               and (column_name like '%external_volume%' or column_name like '%volume_total%')`,
      )
      expect([...columns]).toEqual([])
    })
  })

  /**
   * The rule that keeps this an accounting fact: nothing about reputation,
   * skills or quest mechanics may read it. The moment it gates something a
   * citizen can see, the incentive to misclassify has been created.
   *
   * Checked over the source rather than by exercising a path, because the
   * failure is the *existence* of a reader and no test of a code path can find
   * one that has not been written yet. Same technique as
   * `bare-identifiers.test.ts`.
   */
  it('is read by nothing outside accounting', async () => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const allowed = new Set([
      // Accounting itself, and the three schema files that declare the column.
      'funding.ts',
      'funding.test.ts',
      'ledger.ts',
      'agents.ts',
      'enums.ts',
      // Names the enum in a comment counting how many the schema has. Not a
      // reader — nothing branches on the value — and excluded by name rather
      // than by loosening the pattern, so a real reader still fails this.
      'migrate.test.ts',
      /**
       * The deposit path **writes** it, and writing is what this rule is for
       * (`#219`): a credit that reaches the ledger from outside the Colony is
       * exactly the entry whose origin nobody could reconstruct afterwards.
       * Nothing here branches on the value — the write is a constant,
       * `external`, and the test beside it asserts that constant rather than
       * reading the column back to decide anything.
       */
      'deposits.ts',
      'deposits.test.ts',
      /**
       * The operator's CLI **writes** it and nothing more (`#316`), which is the
       * same exemption `deposits.ts` holds one door along. The value is the
       * operator's own `--source`, passed straight to `creditBalance`: nothing
       * here branches on it, and the command refuses to run without one rather
       * than choosing a value of its own.
       */
      'admin.ts',
    ])
    const found: string[] = []

    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = `${directory}${entry.name}`
        if (entry.isDirectory()) {
          await walk(`${path}/`)
          continue
        }
        if (!entry.name.endsWith('.ts') || allowed.has(entry.name)) continue
        const source = await readFile(path, 'utf8')
        if (/fundingSource|funding_source/.test(source)) found.push(entry.name)
      }
    }

    await walk(root)

    expect(found).toEqual([])
  })
})
