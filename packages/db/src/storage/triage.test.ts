import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SupportTicketIdSchema, type AgentId, type OpenTicketRequest } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, supportTickets } from '../schema/index.js'
import { AgentIdSchema } from '@kolonie-ai/core'
import { openTicket } from './support.js'
import {
  openTickets,
  queueDepth,
  recordTriage,
  resolveFromClosedIssue,
  ticketsAwaitingTheirIssue,
  triagedTickets,
} from './triage.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

const aRequest = (overrides: Partial<OpenTicketRequest> = {}): OpenTicketRequest => ({
  kind: 'defect',
  subject: 'email-roundtrip never delivers the code',
  body:
    'I minted a challenge and waited the full hour. Nothing arrived at the address on my ' +
    'profile, and the challenge expired.',
  ...overrides,
})

describe.skipIf(!target.available)('triage reads and writes', () => {
  let db: Database
  let seeded = 0

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const anAgent = async (): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: `citizen-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  it('serves the queue oldest first, across citizens', async () => {
    const first = await openTicket(db, {
      agentId: await anAgent(),
      request: aRequest({ subject: 'the first report anybody filed' }),
    })
    const second = await openTicket(db, {
      agentId: await anAgent(),
      request: aRequest({ subject: 'the second report anybody filed' }),
    })

    const queue = await openTickets(db, 10)

    expect(queue.map((t) => t.id)).toEqual([first.id, second.id])
  })

  /**
   * The bug this prevents is a loop, not a wrong answer: a triage run that kept
   * picking up what it had already answered would re-answer it every tick,
   * forever, and each pass would cost a model call.
   */
  it('does not serve a ticket it has already answered', async () => {
    const ticket = await openTicket(db, { agentId: await anAgent(), request: aRequest() })

    await recordTriage(db, {
      ticketId: ticket.id,
      status: 'acknowledged',
      issueUrl: 'https://github.com/Kolonie-AI/kolonie-platform/issues/1',
    })

    expect(await openTickets(db, 10)).toEqual([])
  })

  it('limits the batch', async () => {
    for (let i = 0; i < 5; i++) {
      await openTicket(db, { agentId: await anAgent(), request: aRequest() })
    }

    expect(await openTickets(db, 2)).toHaveLength(2)
  })

  it('records an acknowledgement with the issue it was matched to', async () => {
    const ticket = await openTicket(db, { agentId: await anAgent(), request: aRequest() })
    const url = 'https://github.com/Kolonie-AI/kolonie-platform/issues/42'

    const updated = await recordTriage(db, {
      ticketId: ticket.id,
      status: 'acknowledged',
      resolution: 'Another citizen reported this; the work is tracked in the linked issue.',
      issueUrl: url,
    })

    expect(updated?.status).toBe('acknowledged')
    expect(updated?.issueUrl).toBe(url)
    expect(updated?.updatedAt).not.toBe(ticket.updatedAt)
  })

  /**
   * The at-least-once property, made harmless. A crash between the model's answer
   * and the write leaves the row to be picked up again, so two writers for one
   * ticket is a state the runner reaches on its own — not a race somebody has to
   * contrive.
   */
  it('refuses a second answer to the same ticket rather than overwriting the first', async () => {
    const ticket = await openTicket(db, { agentId: await anAgent(), request: aRequest() })
    const first = 'https://github.com/Kolonie-AI/kolonie-platform/issues/1'

    const won = await recordTriage(db, {
      ticketId: ticket.id,
      status: 'acknowledged',
      issueUrl: first,
    })
    const lost = await recordTriage(db, {
      ticketId: ticket.id,
      status: 'acknowledged',
      issueUrl: 'https://github.com/Kolonie-AI/kolonie-platform/issues/2',
    })

    expect(won?.issueUrl).toBe(first)
    expect(lost).toBeUndefined()

    // And the row still carries the first answer, not the second.
    const [remaining] = await triagedTickets(db, 10)
    expect(remaining?.issueUrl).toBe(first)
  })

  it('answers undefined for a ticket that does not exist', async () => {
    const absent = SupportTicketIdSchema.parse('00000000-0000-4000-8000-000000000000')

    expect(await recordTriage(db, { ticketId: absent, status: 'acknowledged' })).toBeUndefined()
  })

  /**
   * The table's `support_tickets_settled_says_why` check exists because refusing a
   * citizen's report without a reason is what makes a support channel not worth
   * writing to. This asserts the caller is told which field was empty, rather than
   * being handed a Postgres error naming a constraint.
   */
  it('refuses to settle a ticket without saying why', async () => {
    const ticket = await openTicket(db, { agentId: await anAgent(), request: aRequest() })

    await expectRejection(
      () => recordTriage(db, { ticketId: ticket.id, status: 'declined' }),
      /has to say why/,
    )
    await expectRejection(
      () => recordTriage(db, { ticketId: ticket.id, status: 'resolved', resolution: '' }),
      /has to say why/,
    )

    // Nothing was written: the ticket is still in the queue.
    expect(await openTickets(db, 10)).toHaveLength(1)
  })

  it('may settle a ticket that does say why', async () => {
    const ticket = await openTicket(db, {
      agentId: await anAgent(),
      request: aRequest({ kind: 'question' }),
    })

    const updated = await recordTriage(db, {
      ticketId: ticket.id,
      status: 'resolved',
      resolution:
        'The mailbox rung needs MX on the challenge domain; onboarding/academy.md says so.',
    })

    expect(updated?.status).toBe('resolved')
    expect(updated?.resolution).toMatch(/mailbox rung/)
  })

  it('offers answered tickets as the corpus, and leaves the queue out of it', async () => {
    const answered = await openTicket(db, { agentId: await anAgent(), request: aRequest() })
    await openTicket(db, {
      agentId: await anAgent(),
      request: aRequest({ subject: 'a different report nobody has read' }),
    })

    await recordTriage(db, {
      ticketId: answered.id,
      status: 'resolved',
      resolution: 'Fixed on the host.',
    })

    const corpus = await triagedTickets(db, 10)

    expect(corpus.map((t) => t.id)).toEqual([answered.id])
  })

  /**
   * Liveness and progress are different questions. A loop can tick happily while
   * the backlog grows, and that is the failure this whole feature exists to
   * prevent — so the depth is measured rather than inferred from the loop.
   */
  it('reports how deep the queue is and how long the oldest has waited', async () => {
    expect(await queueDepth(db)).toEqual({ open: 0, oldestOpenAt: null })

    const oldest = await openTicket(db, { agentId: await anAgent(), request: aRequest() })
    await openTicket(db, { agentId: await anAgent(), request: aRequest() })

    const depth = await queueDepth(db)
    expect(depth.open).toBe(2)
    expect(depth.oldestOpenAt).toBe(oldest.createdAt)

    await recordTriage(db, {
      ticketId: oldest.id,
      status: 'declined',
      resolution: 'Working as intended.',
    })

    expect((await queueDepth(db)).open).toBe(1)
  })

  /**
   * The reads and the write #165 added: an issue's ending reaching the ticket
   * that caused it. Every issue the runner files ends with *"closing it is how
   * they learn the ending"*, and until this existed nothing ever looked at a
   * ticket again after acknowledging it.
   */
  describe('settling a ticket from the issue it became', () => {
    const url = 'https://github.com/Kolonie-AI/kolonie-platform/issues/157'
    const ending = 'The issue your report became has been closed as done.'

    const acknowledged = async (issueUrl: string | null = url) => {
      const ticket = await openTicket(db, { agentId: await anAgent(), request: aRequest() })
      await recordTriage(db, {
        ticketId: ticket.id,
        status: 'acknowledged',
        resolution: 'Filed as an issue the Colony has decided to look at.',
        issueUrl,
      })
      return ticket
    }

    it('serves acknowledged tickets that carry an issue, oldest first', async () => {
      const first = await acknowledged()
      const second = await acknowledged()

      const waiting = await ticketsAwaitingTheirIssue(db, 10)

      expect(waiting.map((t) => t.id)).toEqual([first.id, second.id])
    })

    /**
     * An acknowledged ticket with no issue is one a maintainer was asked to
     * read. There is nothing whose closing could settle it, so serving it here
     * would be handing the pass a row it can never act on.
     */
    it('does not serve an acknowledged ticket that never became an issue', async () => {
      await acknowledged(null)

      expect(await ticketsAwaitingTheirIssue(db, 10)).toEqual([])
    })

    it('does not serve a ticket nobody has triaged yet', async () => {
      await openTicket(db, { agentId: await anAgent(), request: aRequest() })

      expect(await ticketsAwaitingTheirIssue(db, 10)).toEqual([])
    })

    it('resolves an acknowledged ticket and records how', async () => {
      const ticket = await acknowledged()

      const settled = await resolveFromClosedIssue(db, {
        ticketId: ticket.id,
        resolution: ending,
      })

      expect(settled?.status).toBe('resolved')
      expect(settled?.resolution).toBe(ending)
      // The issue it came from is not overwritten: it is still what the citizen
      // opens to read more.
      expect(settled?.issueUrl).toBe(url)
      expect(await ticketsAwaitingTheirIssue(db, 10)).toEqual([])
    })

    /**
     * A closed issue that is opened again is the Colony changing its mind about
     * its own work, not a reason to unanswer a citizen. The `where` clause is
     * what makes that unexpressible: only `acknowledged` matches, so a second
     * pass over the same issue writes nothing.
     */
    it('writes nothing to a ticket that is already resolved', async () => {
      const ticket = await acknowledged()
      await resolveFromClosedIssue(db, { ticketId: ticket.id, resolution: ending })

      const again = await resolveFromClosedIssue(db, {
        ticketId: ticket.id,
        resolution: 'a different ending nobody should see',
      })

      expect(again).toBeUndefined()
      const [row] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
      expect(row?.resolution).toBe(ending)
    })

    it('writes nothing to a ticket nobody has triaged', async () => {
      const ticket = await openTicket(db, { agentId: await anAgent(), request: aRequest() })

      expect(
        await resolveFromClosedIssue(db, { ticketId: ticket.id, resolution: ending }),
      ).toBeUndefined()
    })

    it('refuses to settle a ticket without saying why', async () => {
      const ticket = await acknowledged()

      await expectRejection(
        () => resolveFromClosedIssue(db, { ticketId: ticket.id, resolution: '' }),
        /has to say why/,
      )
    })
  })
})
