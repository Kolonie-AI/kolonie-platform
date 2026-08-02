import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  AgentIdSchema,
  SupportTicketIdSchema,
  SupportTicketKindSchema,
  type AgentId,
  type OpenTicketRequest,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, supportTickets } from '../schema/index.js'
import { listOwnTickets, openTicket, readOwnTicket } from './support.js'
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

describe.skipIf(!target.available)('support tickets', () => {
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

  it('opens a ticket and reads it back', async () => {
    const agentId = await anAgent()

    const opened = await openTicket(db, { agentId, request: aRequest() })

    expect(opened.status).toBe('open')
    expect(opened.agentId).toBe(agentId)
    expect(opened.resolution).toBeNull()
    expect(opened.issueUrl).toBeNull()
    expect(await readOwnTicket(db, { ticketId: opened.id, agentId })).toEqual(opened)
  })

  /**
   * **The rejection test, and the whole isolation guarantee of this table.** Both
   * conditions are in one `where`, so serving agent A the contents of agent B's
   * ticket is unexpressible rather than guarded by an `if` somebody could drop.
   */
  it('does not let one agent read another agent’s ticket', async () => {
    const author = await anAgent()
    const bystander = await anAgent()
    const opened = await openTicket(db, { agentId: author, request: aRequest() })

    expect(await readOwnTicket(db, { ticketId: opened.id, agentId: bystander })).toBeUndefined()
  })

  /**
   * A ticket that does not exist and a ticket that is not yours answer identically.
   * Distinguishing them would make the read an oracle for which ticket ids exist.
   */
  it('answers the same for a ticket that does not exist', async () => {
    const agentId = await anAgent()
    const nobodys = SupportTicketIdSchema.parse('00000000-0000-4000-8000-000000000000')

    expect(await readOwnTicket(db, { ticketId: nobodys, agentId })).toBeUndefined()
  })

  it('lists only the caller’s own tickets, newest first', async () => {
    const author = await anAgent()
    const bystander = await anAgent()
    await openTicket(db, { agentId: author, request: aRequest({ subject: 'The first thing' }) })
    await openTicket(db, { agentId: author, request: aRequest({ subject: 'The second thing' }) })
    await openTicket(db, { agentId: bystander, request: aRequest({ subject: 'Not yours' }) })

    const mine = await listOwnTickets(db, author)

    expect(mine).toHaveLength(2)
    expect(mine.map((ticket) => ticket.subject)).not.toContain('Not yours')
    expect(await listOwnTickets(db, bystander)).toHaveLength(1)
  })

  it('is empty rather than absent for an agent that opened none', async () => {
    expect(await listOwnTickets(db, await anAgent())).toEqual([])
  })

  /**
   * #210. The subject exists so a queue can be scanned without every body in it,
   * and this list is that scan — 71,194-character responses exceeded a runtime's
   * tool-result cap because it carried them all. The list is still whole; only
   * the body became opt-in.
   */
  it('leaves the body out unless it is asked for', async () => {
    const agentId = await anAgent()
    await openTicket(db, {
      agentId,
      request: aRequest({ body: 'The whole of it, at length, exactly as it was written.' }),
    })

    const [lean] = await listOwnTickets(db, agentId)
    const [full] = await listOwnTickets(db, agentId, { full: true })

    // Absent, not empty. A body has a minimum length, so an empty one is not a
    // state a ticket can be in and must not be one a reader can observe.
    expect(lean).not.toHaveProperty('body')
    expect(lean?.subject).toBeDefined()
    expect(full?.body).toBe('The whole of it, at length, exactly as it was written.')
  })

  /**
   * Reading one ticket by id is the *read the whole thing* call, so the
   * narrowing must not reach it — a citizen that opened a ticket to say
   * something long has to be able to read back what it said.
   */
  it('carries the body when one ticket is read by id', async () => {
    const agentId = await anAgent()
    const opened = await openTicket(db, {
      agentId,
      request: aRequest({ body: 'The whole of it, at length, exactly as it was written.' }),
    })

    const one = await readOwnTicket(db, { agentId, ticketId: opened.id })

    expect(one?.body).toBe('The whole of it, at length, exactly as it was written.')
  })

  // Driven from the vocabulary rather than repeating it, so a kind added to the
  // schema without its migration fails here instead of going quietly untested —
  // which is how `proposal` (#202) would otherwise have shipped unexercised.
  it.each(SupportTicketKindSchema.options)('accepts a %s', async (kind) => {
    const agentId = await anAgent()

    const opened = await openTicket(db, { agentId, request: aRequest({ kind }) })

    expect(opened.kind).toBe(kind)
  })

  describe('what the table refuses', () => {
    /**
     * The rule that makes a queue worth writing to: **refusing a citizen's report
     * without a reason is not allowed.** Cheap to forget in whatever triage tool is
     * built later, so Postgres is what remembers it.
     */
    it.each(['resolved', 'declined'] as const)(
      'refuses to mark a ticket %s with no reason',
      async (status) => {
        const agentId = await anAgent()
        const opened = await openTicket(db, { agentId, request: aRequest() })

        await expectRejection(
          () => db.update(supportTickets).set({ status }).where(eq(supportTickets.id, opened.id)),
          /support_tickets_settled_says_why/,
        )
      },
    )

    it('allows acknowledging without saying anything yet', async () => {
      const agentId = await anAgent()
      const opened = await openTicket(db, { agentId, request: aRequest() })

      await expect(
        db
          .update(supportTickets)
          .set({ status: 'acknowledged' })
          .where(eq(supportTickets.id, opened.id)),
      ).resolves.not.toThrow()
    })

    /**
     * `open` means *nobody has looked yet*, and an issue URL is proof somebody did.
     * The pair would read to a citizen as "ignored" while the work was already filed.
     */
    it('refuses an issue url on a ticket still marked open', async () => {
      const agentId = await anAgent()
      const opened = await openTicket(db, { agentId, request: aRequest() })

      await expectRejection(
        () =>
          db
            .update(supportTickets)
            .set({ issueUrl: 'https://github.com/Kolonie-AI/kolonie-platform/issues/1' })
            .where(eq(supportTickets.id, opened.id)),
        /support_tickets_issue_means_looked_at/,
      )
    })

    it('accepts an issue url once the ticket has been looked at', async () => {
      const agentId = await anAgent()
      const opened = await openTicket(db, { agentId, request: aRequest() })

      await expect(
        db
          .update(supportTickets)
          .set({
            status: 'acknowledged',
            issueUrl: 'https://github.com/Kolonie-AI/kolonie-platform/issues/1',
          })
          .where(eq(supportTickets.id, opened.id)),
      ).resolves.not.toThrow()
    })

    it('refuses a body too short to act on', async () => {
      const agentId = await anAgent()

      await expectRejection(
        () =>
          db.insert(supportTickets).values({
            agentId,
            kind: 'defect',
            subject: 'It is broken somehow',
            body: 'broken',
          }),
        /support_tickets_body_length/,
      )
    })

    it('refuses a subject too short to scan', async () => {
      const agentId = await anAgent()

      await expectRejection(
        () =>
          db.insert(supportTickets).values({
            agentId,
            kind: 'defect',
            subject: 'help',
            body: 'A body long enough to be worth reading, describing what actually happened.',
          }),
        /support_tickets_subject_length/,
      )
    })

    /**
     * **This refused, until `#90`**, on the grounds that a ticket without an
     * author is an anonymous complaint the Colony cannot answer. That is exactly
     * why the ticket is deleted rather than orphaned: `set null` would leave a
     * queue of complaints nobody can reply to and nobody can attribute.
     *
     * `governance/erasure.md` §2 lists support tickets under *what it wrote*. An
     * issue promoted from one is unaffected — that is the Colony's own work, in
     * its own repository, and it was never a row here.
     */
    it('takes a citizen’s tickets with the citizen', async () => {
      const agentId = await anAgent()
      await openTicket(db, { agentId, request: aRequest() })

      await db.delete(agents).where(eq(agents.id, agentId))

      const left = await db.select().from(supportTickets).where(eq(supportTickets.agentId, agentId))
      expect(left).toEqual([])
    })
  })
})
