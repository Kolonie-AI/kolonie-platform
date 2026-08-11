import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { WEB_SERVER_PATH_PREFIX, WEB_SERVER_SEPARATION_MS, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, webServerChallenges } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import {
  asChallenge,
  mintWebServerChallenge,
  openWebServerChallenges,
  probeFor,
  recordWebServerProbe,
  type WebServerChallengeRow,
} from './web-server.js'

const target = databaseTestTarget()
const ORIGIN = 'https://example.org:8443'

/**
 * The `web-server` rung's storage (#244), against a real database.
 *
 * **The disclosure rule is what this file exists for.** Everything else here is
 * ordinary challenge-table behaviour; the thing that would silently destroy the
 * rung is the second path leaking early, and that is a property of one function
 * with three branches rather than of anything a reviewer would notice in a diff.
 */
describe('the web-server rung (#244)', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id as AgentId
  }

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await anAgent('server-runner')
  })

  const mint = async (machineIsSolelyMine = true): Promise<WebServerChallengeRow> => {
    const result = await mintWebServerChallenge(db, {
      agentId,
      origin: ORIGIN,
      machineIsSolelyMine,
    })
    if (result.outcome === 'too-many') throw new Error('unexpected too-many')
    return result.row
  }

  describe('the disclosure rule', () => {
    it('names the first path and nothing about the second', async () => {
      const row = await mint()
      const shown = asChallenge(row)

      expect(shown.probe?.which).toBe('first')
      expect(shown.probe?.path).toBe(row.firstPath)
      expect(shown.probe?.nonce).toBe(row.firstNonce)

      /**
       * The assertion the rung stands on. A citizen holding both paths at once
       * could prepare two static files and walk away, which is precisely the
       * thing two probes exist to rule out.
       */
      const serialised = JSON.stringify(shown)
      expect(serialised).not.toContain(row.secondPath)
      expect(serialised).not.toContain(row.secondNonce)
      expect(shown.secondOpensAt).toBeNull()
    })

    it('names nothing at all while the separation has not elapsed', async () => {
      const row = await mint()
      await recordWebServerProbe(db, {
        challengeId: row.id,
        which: 'first',
        at: new Date().toISOString(),
      })

      const [served] = await openWebServerChallenges(db, agentId)
      const shown = asChallenge(served as WebServerChallengeRow)

      expect(shown.firstServed).toBe(true)
      // Not a failure and not the second probe: the correct answer for the whole
      // hour is "keep the server running".
      expect(shown.probe).toBeNull()
      expect(shown.secondOpensAt).not.toBeNull()
      expect(JSON.stringify(shown)).not.toContain(row.secondPath)
    })

    it('names the second only once the first is served and the hour has passed', async () => {
      const row = await mint()
      const anHourAgo = new Date(Date.now() - WEB_SERVER_SEPARATION_MS - 1000).toISOString()
      await recordWebServerProbe(db, { challengeId: row.id, which: 'first', at: anHourAgo })

      const [served] = await openWebServerChallenges(db, agentId)
      const shown = asChallenge(served as WebServerChallengeRow)

      expect(shown.probe?.which).toBe('second')
      expect(shown.probe?.path).toBe(row.secondPath)
      expect(shown.probe?.nonce).toBe(row.secondNonce)
    })

    it('names nothing once both are served, or once it has expired', async () => {
      const row = await mint()
      const anHourAgo = new Date(Date.now() - WEB_SERVER_SEPARATION_MS - 1000).toISOString()
      await recordWebServerProbe(db, { challengeId: row.id, which: 'first', at: anHourAgo })
      await recordWebServerProbe(db, {
        challengeId: row.id,
        which: 'second',
        at: new Date().toISOString(),
      })

      const [done] = await db
        .select()
        .from(webServerChallenges)
        .where(eq(webServerChallenges.id, row.id))
      expect(done?.secondServedAt).not.toBeNull()

      const expired: WebServerChallengeRow = {
        ...row,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }
      expect(probeFor(expired)).toBeNull()
    })

    it('puts every path under the documented prefix, so one handler can serve them all', async () => {
      const row = await mint()
      expect(row.firstPath.startsWith(WEB_SERVER_PATH_PREFIX)).toBe(true)
      expect(row.secondPath.startsWith(WEB_SERVER_PATH_PREFIX)).toBe(true)
      expect(row.firstPath).not.toBe(row.secondPath)
    })
  })

  describe('minting', () => {
    it('hands back the open one rather than resetting the hour already waited', async () => {
      const first = await mint()
      const anHourAgo = new Date(Date.now() - WEB_SERVER_SEPARATION_MS - 1000).toISOString()
      await recordWebServerProbe(db, { challengeId: first.id, which: 'first', at: anHourAgo })

      const again = await mintWebServerChallenge(db, {
        agentId,
        origin: ORIGIN,
        machineIsSolelyMine: true,
      })

      expect(again.outcome).toBe('already-open')
      if (again.outcome === 'already-open') {
        expect(again.row.id).toBe(first.id)
        // The progress is intact: the second probe is still the one on offer.
        expect(probeFor(again.row)?.which).toBe('second')
      }
    })

    /**
     * `#717`. The rule above is right about accidents and locked a citizen out
     * entirely when its origin died: the open challenge could never be
     * completed, every fresh mint handed back its probe, and waiting the
     * challenge out was the only remedy.
     */
    it('abandons the open one and starts over when replacement is explicit', async () => {
      const first = await mint()
      const anHourAgo = new Date(Date.now() - WEB_SERVER_SEPARATION_MS - 1000).toISOString()
      await recordWebServerProbe(db, { challengeId: first.id, which: 'first', at: anHourAgo })

      const replaced = await mintWebServerChallenge(db, {
        agentId,
        origin: 'https://a-tunnel-that-answers.example',
        machineIsSolelyMine: true,
        replace: true,
      })

      expect(replaced.outcome).toBe('minted')
      if (replaced.outcome !== 'minted') throw new Error('expected a fresh challenge')
      expect(replaced.row.id).not.toBe(first.id)
      expect(replaced.row.origin).toBe('https://a-tunnel-that-answers.example')
      // The separation is asked for again from the beginning, which is the price
      // and the reason it is never the default.
      expect(replaced.row.firstServedAt).toBeNull()
      expect(probeFor(replaced.row)?.which).toBe('first')
    })

    it('leaves exactly the replacement open afterwards', async () => {
      await mint()
      const replaced = await mintWebServerChallenge(db, {
        agentId,
        origin: ORIGIN,
        machineIsSolelyMine: true,
        replace: true,
      })
      if (replaced.outcome !== 'minted') throw new Error('expected a fresh challenge')

      const standing = await openWebServerChallenges(db, agentId)

      expect(standing.map((row) => row.id)).toEqual([replaced.row.id])
    })

    /**
     * The rejection case this must not break: an ordinary repeat is how a
     * citizen asks *what is next*, and it must never reset the clock.
     */
    it('still hands back the open one when replacement was not asked for', async () => {
      const first = await mint()

      const again = await mintWebServerChallenge(db, {
        agentId,
        origin: ORIGIN,
        machineIsSolelyMine: true,
        replace: false,
      })

      expect(again.outcome).toBe('already-open')
      if (again.outcome !== 'already-open') throw new Error('expected the open challenge')
      expect(again.row.id).toBe(first.id)
    })

    it('records the declaration, because it is what decided whether to ask a person', async () => {
      const row = await mint(false)
      expect(row.machineIsSolelyMine).toBe(false)
    })
  })

  describe('recording a probe', () => {
    it('is idempotent, so a redelivered verdict cannot restart the separation', async () => {
      const row = await mint()
      const first = new Date(Date.now() - WEB_SERVER_SEPARATION_MS - 1000).toISOString()

      expect(
        await recordWebServerProbe(db, { challengeId: row.id, which: 'first', at: first }),
      ).toBe(true)
      expect(
        await recordWebServerProbe(db, {
          challengeId: row.id,
          which: 'first',
          at: new Date().toISOString(),
        }),
      ).toBe(false)

      const [stored] = await openWebServerChallenges(db, agentId)
      // Still an hour ago. A replay that moved this forward would silently ask
      // the citizen to wait another hour for work it had already done.
      expect(probeFor(stored as WebServerChallengeRow)?.which).toBe('second')
    })

    it('refuses a second probe with no first, at the database', async () => {
      const row = await mint()
      await expectRejection(
        () =>
          db
            .update(webServerChallenges)
            .set({ secondServedAt: new Date().toISOString() })
            .where(eq(webServerChallenges.id, row.id)),
        /web_server_challenges_second_after_first/,
      )
    })
  })

  it('leaves with the citizen', async () => {
    await mint()
    await db.delete(agents).where(eq(agents.id, agentId))
    expect(await db.select().from(webServerChallenges)).toEqual([])
  })

  /**
   * `#244` forbids hosting-provider heuristics and requires the reason to be
   * stated. Asserted as the absence it is: a column that existed would be used,
   * so the guarantee is that none exists.
   */
  it('records nothing about where the server runs', async () => {
    await mint()
    const [row] = await db.select().from(webServerChallenges)
    const columns = Object.keys(row ?? {})

    for (const forbidden of ['ip', 'address', 'headers', 'server', 'provider', 'asn', 'host']) {
      expect(columns.some((column) => column.toLowerCase().includes(forbidden))).toBe(false)
    }
  })
})
