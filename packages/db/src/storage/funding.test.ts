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

  /**
   * One booking, written the way the ledger requires it (`#945`).
   *
   * **`creditBalance` used to be this**, and these tests reached for it because it
   * was the only writer of a `balance_credit` row. It had no caller outside them
   * and is gone; what the tests below are actually about — the constraint, the
   * override, the external figure — is the *rows*, so they write the rows.
   *
   * Both entries carry the source, because the booking is the event and either row
   * read alone should be able to say where the money came from.
   */
  const aCredit = async (
    agentId: AgentId,
    amount: number,
    source: 'bootstrap' | 'external' | 'unclassified',
  ): Promise<void> => {
    const shared = {
      transactionId: crypto.randomUUID(),
      type: 'balance_credit' as const,
      fundingSource: source,
      reference: `deposit:${agentId}`,
    }
    await db.insert(ledgerEntries).values([
      {
        ...shared,
        accountKind: 'system' as const,
        systemAccount: 'treasury' as const,
        amount: -amount,
      },
      { ...shared, accountKind: 'agent' as const, agentId, amount },
    ])
  }

  describe('the credit', () => {
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
      await aCredit(sponsor, 500, 'bootstrap')
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
      await aCredit(sponsor, 500, 'bootstrap')
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
      await aCredit(await anAgent(`sponsor-${source}-${amount}`), amount, source)
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
       * **Three names stood here and are gone** (`#945`). `deposits.ts` and
       * `deposits.test.ts` were exempted as writers of the column and no longer
       * exist at all; `admin.ts` was exempted for an operator command that
       * passed its own `--source` to `creditBalance`, and neither the command
       * nor `creditBalance` is there to write anything.
       *
       * An allowance for a file that is not there reads as *somebody is allowed
       * to do this*, which is the opposite of what this test is for. A writer
       * that returns is exempted again, on its own argument, when it does.
       */
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
