import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  type AgentId,
  type OpenTicketRequest,
  type SupportTicket,
  type SupportTicketRoute,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, supportTickets } from '../schema/index.js'
import { openTicket } from './support.js'
import {
  answerDeskTicket,
  deskDepth,
  deskTicket,
  deskTickets,
  promoteToColony,
} from './support-desk.js'
import { openTickets } from './triage.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'

const target = databaseTestTarget()

const aRequest = (overrides: Partial<OpenTicketRequest> = {}): OpenTicketRequest => ({
  kind: 'objection',
  subject: 'my walk was refused and I cannot see why',
  body:
    'I filed a walk report for a provider nobody had written up, and the prose was refused ' +
    'without a reason I can read anywhere.',
  ...overrides,
})

describe('the maintainers desk', () => {
  let db: Database
  let seeded = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const anAgent = async (name?: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: name ?? `citizen-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  const opened = async (
    agentId: AgentId,
    route: SupportTicketRoute,
    overrides: Partial<OpenTicketRequest> = {},
  ): Promise<SupportTicket> => {
    const result = await openTicket(db, { agentId, request: aRequest(overrides), route })
    if (result.outcome !== 'opened') throw new Error(`opening a ticket answered ${result.outcome}`)
    return result.ticket
  }

  /** Backdate a ticket, so the orderings have something to sort. */
  const openedAt = async (ticket: SupportTicket, iso: string): Promise<void> => {
    await db.update(supportTickets).set({ createdAt: iso }).where(eq(supportTickets.id, ticket.id))
  }

  describe('the queue', () => {
    it('lists desk tickets and leaves the colony queue alone', async () => {
      const agentId = await anAgent()
      const mine = await opened(agentId, 'desk')
      await opened(agentId, 'colony')

      const rows = await deskTickets(db)

      expect(rows.map((row) => row.id)).toEqual([mine.id])
    })

    it('carries who opened it and how they stand', async () => {
      const agentId = await anAgent('appellant')
      await db.update(agents).set({ status: 'suspended' }).where(eq(agents.id, agentId))
      await opened(agentId, 'desk')

      const [row] = await deskTickets(db)

      expect(row?.agentName).toBe('appellant')
      // The reason standing is on the row at all: a desk ticket from a suspended
      // citizen is an appeal, and the queue should read as one without being
      // opened.
      expect(row?.agentStatus).toBe('suspended')
    })

    it('puts what is unanswered first, and the oldest of it at the top', async () => {
      const agentId = await anAgent()

      const answered = await opened(agentId, 'desk', { subject: 'answered long ago xx' })
      await openedAt(answered, '2026-01-01T00:00:00.000Z')
      await answerDeskTicket(db, {
        ticketId: answered.id,
        status: 'resolved',
        resolution: 'Fixed in #1',
      })

      const newest = await opened(agentId, 'desk', { subject: 'opened this morning' })
      await openedAt(newest, '2026-08-19T09:00:00.000Z')

      const oldest = await opened(agentId, 'desk', { subject: 'waiting a fortnight' })
      await openedAt(oldest, '2026-08-05T09:00:00.000Z')

      const rows = await deskTickets(db)

      // The settled one is oldest of the three and still last: sorting purely by
      // age would make this page stop being a queue.
      expect(rows.map((row) => row.id)).toEqual([oldest.id, newest.id, answered.id])
    })

    it('keeps an acknowledged ticket among the unanswered', async () => {
      const agentId = await anAgent()
      const ticket = await opened(agentId, 'desk')
      await answerDeskTicket(db, { ticketId: ticket.id, status: 'acknowledged' })

      const [row] = await deskTickets(db)

      expect(row?.answered).toBe(false)
    })
  })

  describe('one ticket', () => {
    it('carries the body, which the queue does not', async () => {
      const agentId = await anAgent()
      const ticket = await opened(agentId, 'desk')

      const detail = await deskTicket(db, ticket.id)

      expect(detail?.body).toBe(ticket.body)
    })

    it('answers nothing for a colony ticket, exactly as for one that is not there', async () => {
      const agentId = await anAgent()
      const colony = await opened(agentId, 'colony')

      expect(await deskTicket(db, colony.id)).toBeUndefined()
    })
  })

  describe('answering', () => {
    it('writes the answer and settles the ticket', async () => {
      const agentId = await anAgent()
      const ticket = await opened(agentId, 'desk')

      const answered = await answerDeskTicket(db, {
        ticketId: ticket.id,
        status: 'resolved',
        resolution: 'Lifted by hand, and #1339 stops it recurring.',
      })

      expect(answered?.status).toBe('resolved')
      expect(answered?.resolution).toBe('Lifted by hand, and #1339 stops it recurring.')
      expect(answered?.answered).toBe(true)
    })

    it('refuses to settle a ticket without saying why', async () => {
      const agentId = await anAgent()
      const ticket = await opened(agentId, 'desk')

      await expectRejection(
        () => answerDeskTicket(db, { ticketId: ticket.id, status: 'declined', resolution: '   ' }),
        /has to say why/,
      )
    })

    it('acknowledges without words, and keeps the ones already written', async () => {
      const agentId = await anAgent()
      const ticket = await opened(agentId, 'desk')
      await answerDeskTicket(db, {
        ticketId: ticket.id,
        status: 'resolved',
        resolution: 'The answer the citizen has already read.',
      })

      const again = await answerDeskTicket(db, { ticketId: ticket.id, status: 'acknowledged' })

      expect(again?.status).toBe('acknowledged')
      expect(again?.resolution).toBe('The answer the citizen has already read.')
    })

    it('lets a maintainer correct themselves', async () => {
      const agentId = await anAgent()
      const ticket = await opened(agentId, 'desk')
      await answerDeskTicket(db, {
        ticketId: ticket.id,
        status: 'resolved',
        resolution: 'Answered too quickly.',
      })

      const corrected = await answerDeskTicket(db, {
        ticketId: ticket.id,
        status: 'declined',
        resolution: 'On reflection the Colony will not act, and here is why.',
      })

      expect(corrected?.status).toBe('declined')
    })

    it('will not answer a colony ticket', async () => {
      const agentId = await anAgent()
      const colony = await opened(agentId, 'colony')

      const answered = await answerDeskTicket(db, {
        ticketId: colony.id,
        status: 'resolved',
        resolution: 'Not this desks to answer.',
      })

      expect(answered).toBeUndefined()
      const [row] = await db
        .select({ status: supportTickets.status })
        .from(supportTickets)
        .where(eq(supportTickets.id, colony.id))
      expect(row?.status).toBe('open')
    })
  })

  describe('promoting to the colony queue', () => {
    it('puts the ticket back in front of triage', async () => {
      const agentId = await anAgent()
      const ticket = await opened(agentId, 'desk')
      await answerDeskTicket(db, { ticketId: ticket.id, status: 'acknowledged' })

      expect(await promoteToColony(db, ticket.id)).toBe(true)

      // Not merely routed: `openTickets` reads `open`, so a ticket promoted while
      // acknowledged would sit on the colony route being read by nothing.
      const queue = await openTickets(db, 10)
      expect(queue.map((each) => each.id)).toEqual([ticket.id])
      expect(await deskTicket(db, ticket.id)).toBeUndefined()
    })

    it('keeps whatever the maintainer had already written', async () => {
      const agentId = await anAgent()
      const ticket = await opened(agentId, 'desk')
      await answerDeskTicket(db, {
        ticketId: ticket.id,
        status: 'acknowledged',
        resolution: 'Looking at it.',
      })

      await promoteToColony(db, ticket.id)

      const [row] = await db
        .select({ resolution: supportTickets.resolution })
        .from(supportTickets)
        .where(eq(supportTickets.id, ticket.id))
      expect(row?.resolution).toBe('Looking at it.')
    })

    it('is one-directional: a colony ticket cannot be promoted again', async () => {
      const agentId = await anAgent()
      const colony = await opened(agentId, 'colony')

      expect(await promoteToColony(db, colony.id)).toBe(false)
    })
  })

  describe('what the backend index counts', () => {
    it('counts nothing when the desk is empty', async () => {
      expect(await deskDepth(db)).toEqual({ unanswered: 0, oldestOpenedAt: null })
    })

    it('counts what is open and acknowledged, and dates the oldest of them', async () => {
      const agentId = await anAgent()

      const oldest = await opened(agentId, 'desk', { subject: 'the one that has waited' })
      await openedAt(oldest, '2026-08-01T00:00:00.000Z')

      const acknowledged = await opened(agentId, 'desk', { subject: 'read but not finished' })
      await openedAt(acknowledged, '2026-08-10T00:00:00.000Z')
      await answerDeskTicket(db, { ticketId: acknowledged.id, status: 'acknowledged' })

      const settled = await opened(agentId, 'desk', { subject: 'finished with entirely' })
      await openedAt(settled, '2026-07-01T00:00:00.000Z')
      await answerDeskTicket(db, {
        ticketId: settled.id,
        status: 'resolved',
        resolution: 'Answered.',
      })

      await opened(agentId, 'colony')

      expect(await deskDepth(db)).toEqual({
        unanswered: 2,
        oldestOpenedAt: '2026-08-01T00:00:00.000Z',
      })
    })
  })
})
