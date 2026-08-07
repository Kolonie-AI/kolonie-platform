import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../client.js'
import { agents, supportTickets } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  BACKEND_SECTION_ROWS,
  backendSections,
  recentRegistrations,
  waitingTickets,
} from './backend-sections.js'

const target = databaseTestTarget()

/**
 * `#487`. Two questions the maintainer asks daily had no surface at all.
 *
 * The properties worth a real database are the two orderings and the cap, and
 * they are worth it because **each is wrong in a way that reads as right**: a
 * registrations list read oldest-first shows the Colony's first week forever,
 * and a support queue read newest-first buries the ticket that has waited
 * longest — which is the only one whose age is a defect.
 */
describe('the two sections on /backend', () => {
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

  /** An agent that registered at a stated moment. */
  const arrived = async (name: string, at: string, path: 'mcp' | 'web' = 'mcp') => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'other', registrationPath: path, createdAt: at })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id
  }

  /** A ticket opened at a stated moment. */
  const ticket = async (
    subject: string,
    at: string,
    status: 'open' | 'resolved' = 'open',
    agentId?: string,
  ) => {
    const id = agentId ?? (await arrived(`author-${subject}`, at))
    await db.insert(supportTickets).values({
      agentId: id,
      kind: 'question',
      subject,
      body: 'the body, which this section deliberately never selects',
      status,
      createdAt: at,
      ...(status === 'resolved' ? { resolution: 'answered' } : {}),
    })
  }

  describe('who arrived', () => {
    it('answers newest first', async () => {
      await arrived('oldest', '2026-01-01T00:00:00Z')
      await arrived('middle', '2026-05-01T00:00:00Z')
      await arrived('newest', '2026-08-01T00:00:00Z')

      const rows = await recentRegistrations(db)

      expect(rows.map((row) => row.name)).toEqual(['newest', 'middle', 'oldest'])
    })

    /**
     * Twenty is one screen: enough rows to see a gap in, few enough to read
     * without scrolling. A caller-supplied limit would make this a query
     * interface over `agents`, which is a different thing.
     */
    it('stops at twenty', async () => {
      for (let n = 0; n < 25; n++) {
        await arrived(
          `agent-${String(n).padStart(2, '0')}`,
          `2026-0${(n % 8) + 1}-01T00:00:0${n % 10}Z`,
        )
      }

      const rows = await recentRegistrations(db)

      expect(rows).toHaveLength(BACKEND_SECTION_ROWS)
      expect(BACKEND_SECTION_ROWS).toBe(20)
    })

    /**
     * **Name, timestamp and registration path. Nothing else.** The line is
     * deliberate — `/numbers` is otherwise entirely aggregates, and showing
     * individuals is defensible only for facts already visible about an agent.
     */
    it('carries three fields and no fourth', async () => {
      await arrived('somebody', '2026-08-01T00:00:00Z', 'web')

      const [row] = await recentRegistrations(db)

      expect(Object.keys(row ?? {}).sort()).toEqual(['name', 'path', 'registeredAt'])
      expect(row?.path).toBe('web')
    })

    it('says nothing rather than failing when there are none', async () => {
      expect(await recentRegistrations(db)).toEqual([])
    })
  })

  describe('what is waiting', () => {
    /**
     * The one ordering that puts the ticket that has waited longest at the top.
     * Read newest-first it would be at the bottom, under everything that arrived
     * after it — which is the failure this section exists to end.
     */
    it('answers oldest first', async () => {
      await ticket('the newest of the three', '2026-08-01T00:00:00Z')
      await ticket('the oldest of the three', '2026-01-01T00:00:00Z')
      await ticket('the middle of the three', '2026-05-01T00:00:00Z')

      const rows = await waitingTickets(db)

      expect(rows.map((row) => row.subject)).toEqual([
        'the oldest of the three',
        'the middle of the three',
        'the newest of the three',
      ])
    })

    it('shows only what is open', async () => {
      await ticket('this one is still waiting', '2026-01-01T00:00:00Z')
      await ticket('this one was answered', '2026-01-02T00:00:00Z', 'resolved')

      const rows = await waitingTickets(db)

      expect(rows.map((row) => row.subject)).toEqual(['this one is still waiting'])
    })

    it('stops at twenty', async () => {
      for (let n = 0; n < 25; n++) {
        await ticket(
          `a ticket waiting, number ${String(n).padStart(2, '0')}`,
          `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`,
        )
      }

      expect(await waitingTickets(db)).toHaveLength(BACKEND_SECTION_ROWS)
    })

    /**
     * **The body is never selected.** This section makes the queue visible;
     * answering a ticket is its own issue with its own argument, and a body on a
     * dashboard is how a queue gets answered carelessly.
     */
    it('carries the subject and never the body', async () => {
      await ticket('a subject long enough to be one', '2026-01-01T00:00:00Z')

      const [row] = await waitingTickets(db)

      expect(Object.keys(row ?? {}).sort()).toEqual(['openedAt', 'status', 'subject'])
    })

    it('says nothing rather than failing when the queue is empty', async () => {
      expect(await waitingTickets(db)).toEqual([])
    })
  })

  /**
   * **Two moments and not one.** These are two live queries and were not
   * computed with `ColonyNumbers`; one page-wide timestamp would be claiming
   * they were. `AGENTS.md` §7 applies to a page that reprints itself, and the
   * honest version of it here is per-section.
   */
  it('gives each section its own moment', async () => {
    await arrived('somebody', '2026-08-01T00:00:00Z')
    await ticket('something is waiting here', '2026-01-01T00:00:00Z')

    const sections = await backendSections(db)

    expect(sections.registrations.computedAt).toEqual(expect.any(String))
    expect(sections.tickets.computedAt).toEqual(expect.any(String))
    // Two, because a ticket needs an author and an author is an agent — the
    // arrivals list holds `somebody` and the ticket's author both.
    expect(sections.registrations.rows).toHaveLength(2)
    expect(sections.tickets.rows).toHaveLength(1)
  })
})
