import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  AccountKindSchema,
  AgentIdSchema,
  SubmissionIdSchema,
  SupportTicketIdSchema,
  CITIZEN_TICKET_KINDS,
  type AgentId,
  type OpenTicketRequest,
  type SubmissionId,
  type SupportTicket,
  type SupportTicketRoute,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, providerBriefings, submissions, supportTickets, tasks } from '../schema/index.js'
import {
  providerBriefingCorpus,
  providerBriefingCounts,
  readProviderBriefing,
  staleProviderBriefings,
} from './provider-briefing.js'
import { writeProviderRecipe } from './provider-recipes.js'
import {
  listOwnTickets,
  openColonyNotice,
  openTicket,
  readOwnTicket,
  withdrawOwnTicket,
} from './support.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'

const target = databaseTestTarget()

const aRequest = (overrides: Partial<OpenTicketRequest> = {}): OpenTicketRequest => ({
  kind: 'defect',
  subject: 'email-roundtrip never delivers the code',
  body:
    'I minted a challenge and waited the full hour. Nothing arrived at the address on my ' +
    'profile, and the challenge expired.',
  ...overrides,
})

/**
 * Open a ticket and take the row, for the calls that are not about the refusal.
 *
 * `openTicket` answers with an outcome since #255, because a reference to
 * somebody else's submission is an ordinary thing to get wrong. Every test below
 * that is about something else says so by unwrapping here, and the one test that
 * is about the refusal calls `openTicket` directly.
 */
const openedTicket = async (
  db: Database,
  input: Omit<Parameters<typeof openTicket>[1], 'route'> & { route?: SupportTicketRoute },
): Promise<SupportTicket> => {
  // `route` is required of the real caller, deliberately (`#1344`), and defaulted
  // here so that the tests which are about something else do not have to name it.
  const result = await openTicket(db, { ...input, route: input.route ?? 'colony' })
  if (result.outcome !== 'opened') throw new Error(`opening a ticket answered ${result.outcome}`)
  return result.ticket
}

describe('support tickets', () => {
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

  const anAgent = async (): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: `citizen-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  const aTask = async (title = 'Draw a picture to a specification'): Promise<string> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: `raster-${++seeded}`,
        grantsSkills: [],
        title,
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    if (row === undefined) throw new Error('inserting a task returned no row')
    return row.id
  }

  const aSubmission = async (agentId: AgentId): Promise<SubmissionId> => {
    const [row] = await db
      .insert(submissions)
      .values({
        taskId: await aTask(),
        agentId,
        payload: { image: '…' },
        status: 'pending',
        submittedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })
    if (row === undefined) throw new Error('inserting a submission returned no row')
    return SubmissionIdSchema.parse(row.id)
  }

  it('opens a ticket and reads it back', async () => {
    const agentId = await anAgent()

    const opened = await openedTicket(db, { agentId, request: aRequest() })

    expect(opened.status).toBe('open')
    expect(opened.agentId).toBe(agentId)
    expect(opened.resolution).toBeNull()
    expect(opened.issueUrl).toBeNull()
    expect(await readOwnTicket(db, { ticketId: opened.id, agentId })).toEqual(opened)
  })

  /**
   * The column the routing rule writes (`#1344`).
   *
   * **The rule is not here and must not be.** What this storage owes is that it
   * writes what it was handed and hands it back to both readers — a `desk`
   * ticket that read back as `colony` would put an appeal in front of whatever
   * files public issues.
   */
  it.each(['colony', 'desk'] as const)(
    'stores the route it was given and reads it back as %s',
    async (route) => {
      const agentId = await anAgent()

      const opened = await openedTicket(db, { agentId, route, request: aRequest() })

      const [row] = await db.select().from(supportTickets).where(eq(supportTickets.id, opened.id))
      expect(row?.route).toBe(route)
      expect(opened.route).toBe(route)
      // Both readers, because a citizen reading its own ticket learns where it went.
      expect((await readOwnTicket(db, { ticketId: opened.id, agentId }))?.route).toBe(route)
      expect((await listOwnTickets(db, agentId)).map((ticket) => ticket.route)).toEqual([route])
    },
  )

  /**
   * What a citizen asked for is an input to the rule and never the value: a
   * request naming `desk` cannot reach the column past a caller that decided
   * `colony`, or the rule could be bypassed by the party it constrains.
   */
  it('writes the decided route rather than the one the request carried', async () => {
    const agentId = await anAgent()

    const opened = await openedTicket(db, {
      agentId,
      route: 'desk',
      request: aRequest({ route: 'colony' }),
    })

    expect(opened.route).toBe('desk')
  })

  /**
   * The optional reference a citizen may attach to say what it was doing (#255).
   */
  it('stores a reference to one of the caller’s own submissions', async () => {
    const agentId = await anAgent()
    const submissionId = await aSubmission(agentId)

    const opened = await openedTicket(db, {
      agentId,
      request: aRequest({ aboutSubmissionId: submissionId }),
    })

    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.id, opened.id))

    expect(row?.aboutSubmissionId).toBe(submissionId)
    // Reported back rather than only stored, so a citizen can check what the
    // Colony made of what it sent (`#852`).
    expect(opened.aboutSubmissionId).toBe(submissionId)
    // The idempotency key for machine-filed tickets is a different column and
    // stays untouched — writing here would cap a citizen at one ticket per
    // submission for ever.
    expect(row?.submissionId).toBeNull()
  })

  /**
   * **`null` is how a runtime that cannot omit a property says *about nothing***
   * (`#852`). It has to reach the same state as omitting it — no association, no
   * ownership check, no refusal — or the accommodation is not one.
   */
  it.each([
    ['omitted', {}],
    ['sent as null', { aboutSubmissionId: null }],
  ])('opens a ticket about no submission when it is %s', async (_case, about) => {
    const agentId = await anAgent()

    const opened = await openedTicket(db, { agentId, request: aRequest(about) })

    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.id, opened.id))

    expect(row?.aboutSubmissionId).toBeNull()
    expect(opened.aboutSubmissionId).toBeNull()
  })

  /**
   * **The rejection case.** The reference is the only field a citizen sends that
   * points at another row, so it is the only one that could answer *does this id
   * exist*. A stranger's submission and a fictional one get the same answer, and
   * no ticket is opened either way.
   */
  it('refuses a submission belonging to another agent, and says nothing about it', async () => {
    const author = await anAgent()
    const stranger = await anAgent()
    const theirs = await aSubmission(stranger)
    const fictional = SubmissionIdSchema.parse('00000000-0000-4000-8000-000000000000')

    const refused = await openTicket(db, {
      agentId: author,
      route: 'colony',
      request: aRequest({ aboutSubmissionId: theirs }),
    })
    const missing = await openTicket(db, {
      agentId: author,
      route: 'colony',
      request: aRequest({ aboutSubmissionId: fictional }),
    })

    expect(refused).toEqual({ outcome: 'no-such-submission' })
    expect(missing).toEqual(refused)
    expect(await listOwnTickets(db, author)).toEqual([])
  })

  /**
   * **What proves the new column did not inherit the unique index.** An agent
   * that hits one verifier twice and learns something new the second time is
   * filing two reports, not a duplicate — and `support_tickets_one_per_submission`
   * would have swallowed the second.
   */
  it('accepts two tickets from one citizen about the same submission', async () => {
    const agentId = await anAgent()
    const submissionId = await aSubmission(agentId)

    const first = await openedTicket(db, {
      agentId,
      request: aRequest({ aboutSubmissionId: submissionId, subject: 'The first thing' }),
    })
    const second = await openedTicket(db, {
      agentId,
      request: aRequest({ aboutSubmissionId: submissionId, subject: 'The second thing' }),
    })

    expect(second.id).not.toBe(first.id)
    expect(await listOwnTickets(db, agentId)).toHaveLength(2)
  })

  /**
   * The pseudonym a filed issue names the reporter by (#256).
   *
   * Assigned on the first ticket and never afterwards: the number is printed on
   * a public issue, so a second draw would rewrite what an issue already says.
   */
  describe('the reporter ordinal', () => {
    const ordinalOf = async (agentId: AgentId): Promise<number | null> => {
      const [row] = await db
        .select({ ordinal: agents.reporterOrdinal })
        .from(agents)
        .where(eq(agents.id, agentId))
      return row?.ordinal ?? null
    }

    it('is null until the citizen files something, then never changes', async () => {
      const agentId = await anAgent()
      expect(await ordinalOf(agentId)).toBeNull()

      await openedTicket(db, { agentId, request: aRequest() })
      const first = await ordinalOf(agentId)
      expect(first).not.toBeNull()

      await openedTicket(db, { agentId, request: aRequest({ subject: 'A second thing' }) })
      expect(await ordinalOf(agentId)).toBe(first)
    })

    it('gives two citizens two different numbers', async () => {
      const one = await anAgent()
      const other = await anAgent()

      await openedTicket(db, { agentId: one, request: aRequest() })
      await openedTicket(db, { agentId: other, request: aRequest() })

      expect(await ordinalOf(one)).not.toBe(await ordinalOf(other))
    })

    /**
     * **The rejection case, and the reason this comes from a sequence.** If a
     * number were re-issued after its holder left, a citizen arriving later
     * would become *Reporter 7* and every issue already naming Reporter 7 would
     * read, retroactively and wrongly, as theirs. `max() + 1` goes backwards
     * when a row is deleted; a sequence does not.
     *
     * The row is deleted here rather than erased — an erasure deletes it, which
     * `erasure.test.ts` asserts, and this test is about what the sequence does
     * afterwards.
     */
    it('never re-issues the number of a citizen that has gone', async () => {
      const departing = await anAgent()
      await openedTicket(db, { agentId: departing, request: aRequest() })
      const theirs = await ordinalOf(departing)
      await db.delete(agents).where(eq(agents.id, departing))

      const arriving = await anAgent()
      await openedTicket(db, { agentId: arriving, request: aRequest() })

      expect(await ordinalOf(arriving)).not.toBe(theirs)
      expect(await ordinalOf(arriving)).toBeGreaterThan(theirs ?? 0)
    })
  })

  /**
   * **The rejection test, and the whole isolation guarantee of this table.** Both
   * conditions are in one `where`, so serving agent A the contents of agent B's
   * ticket is unexpressible rather than guarded by an `if` somebody could drop.
   */
  it('does not let one agent read another agent’s ticket', async () => {
    const author = await anAgent()
    const bystander = await anAgent()
    const opened = await openedTicket(db, { agentId: author, request: aRequest() })

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
    await openedTicket(db, { agentId: author, request: aRequest({ subject: 'The first thing' }) })
    await openedTicket(db, { agentId: author, request: aRequest({ subject: 'The second thing' }) })
    await openedTicket(db, { agentId: bystander, request: aRequest({ subject: 'Not yours' }) })

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
    await openedTicket(db, {
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
    const opened = await openedTicket(db, {
      agentId,
      request: aRequest({ body: 'The whole of it, at length, exactly as it was written.' }),
    })

    const one = await readOwnTicket(db, { agentId, ticketId: opened.id })

    expect(one?.body).toBe('The whole of it, at length, exactly as it was written.')
  })

  /**
   * Driven from the vocabulary rather than repeating it, so a kind added to the
   * schema without its migration fails here instead of going quietly untested —
   * which is how `proposal` (#202) would otherwise have shipped unexercised.
   *
   * **`CITIZEN_TICKET_KINDS` and not every option** (`#473`). `notice` is the
   * Colony's word for what it says *to* a citizen, and `OpenTicketRequestSchema`
   * refuses it on this path by construction — so iterating the whole enum here
   * asks this write path to accept a kind it is designed to reject. The
   * property the comment above describes is unchanged: a kind added for
   * citizens still has to appear in a migration or fail here.
   */
  it.each(CITIZEN_TICKET_KINDS)('accepts a %s', async (kind) => {
    const agentId = await anAgent()

    const opened = await openedTicket(db, { agentId, request: aRequest({ kind }) })

    expect(opened.kind).toBe(kind)
  })

  /**
   * The Colony volunteering something about a citizen's own submission (`#530`).
   *
   * **These tests did not exist and the function could never have succeeded.**
   * It writes `status: 'resolved'` with `resolution: null` on purpose — a
   * notice is settled the moment it arrives and has nothing it is saying back
   * to — and `support_tickets_settled_says_why` refused exactly that. The two
   * disagreed in silence from the day the function shipped until somebody tried
   * to send one, on 2026-08-09.
   *
   * Nothing in the repository could have caught it: the function was the one
   * thing in its commit with no test, on the reasoning that it was assembly
   * rather than modelling. **Assembly is exactly where this happens.**
   */
  describe('a notice the Colony sends', () => {
    it('sends, settled on arrival and carrying no resolution', async () => {
      const agentId = await anAgent()
      const aboutSubmissionId = await aSubmission(agentId)

      const sent = await openColonyNotice(db, {
        agentId,
        aboutSubmissionId,
        subject: 'The rung you attempted has been withdrawn',
        body: 'You did not fall short of anything: the rung was being withdrawn anyway.',
      })

      expect(sent.outcome).toBe('sent')
      if (sent.outcome !== 'sent') return
      expect(sent.ticket.status).toBe('resolved')
      expect(sent.ticket.resolution).toBeNull()
      // Never the publishable queue (`#1344`): a notice is about one citizen's own
      // submission, and there is no version of it that is the Colony's own defect.
      expect(sent.ticket.route).toBe('desk')
      // And the citizen finds it where it finds everything else it is told.
      expect((await listOwnTickets(db, agentId)).map((row) => row.id)).toContain(sent.ticket.id)
    })

    /**
     * The rejection case, and the whole safety property: the Colony cannot tell
     * one citizen about another's work, and there is no route that opens a
     * notice about nothing at all.
     */
    it('refuses a submission that is not that citizen’s', async () => {
      const stranger = await anAgent()
      const aboutSubmissionId = await aSubmission(await anAgent())

      expect(
        await openColonyNotice(db, {
          agentId: stranger,
          aboutSubmissionId,
          subject: 'About your submission',
          body: 'This is about work that belongs to somebody else entirely.',
        }),
      ).toEqual({ outcome: 'no-such-submission' })
    })

    /** And the rule the exemption did not relax: a citizen's own ticket still says why. */
    it('does not let an ordinary ticket be resolved without a reason', async () => {
      const agentId = await anAgent()
      const opened = await openedTicket(db, { agentId, request: aRequest() })

      await expectRejection(
        () =>
          db
            .update(supportTickets)
            .set({ status: 'resolved' })
            .where(eq(supportTickets.id, opened.id)),
        /support_tickets_settled_says_why/,
      )
    })
  })

  /**
   * A ticket about a provider marks that briefing stale (`#1098`).
   *
   * The ticket is never evidence — synthesis reads walks — so the assertions
   * here are about the mark, the rate window, and the unknown-pair exit, not
   * about what any claim says.
   */
  describe('a ticket about a provider (#1098)', () => {
    const kind = AccountKindSchema.parse('mailbox')
    const provider = 'mail.example'

    const anEntry = async () => {
      await writeProviderRecipe(db, {
        kind,
        provider,
        title: 'A mailbox',
        status: 'joinable',
        category: 'mailbox',
        steps: [{ actor: 'agent', instruction: 'Sign up.' }],
        proves: 'provider-mail',
      })
    }

    it('records the provider and marks its briefing stale', async () => {
      await anEntry()
      const agentId = await anAgent()

      const opened = await openedTicket(db, {
        agentId,
        request: aRequest({ aboutProvider: { kind, provider } }),
      })

      expect(opened.aboutProvider).toEqual({ kind, provider })
      expect(await staleProviderBriefings(db, 10)).toEqual([{ kind, provider }])
    })

    it('marks nothing further inside one briefing interval', async () => {
      await anEntry()
      const agentId = await anAgent()

      await openedTicket(db, {
        agentId,
        request: aRequest({
          aboutProvider: { kind, provider },
          subject: 'First report about this provider',
        }),
      })
      const [first] = await db
        .select({ updatedAt: providerBriefings.updatedAt })
        .from(providerBriefings)
        .where(and(eq(providerBriefings.kind, kind), eq(providerBriefings.provider, provider)))

      await openedTicket(db, {
        agentId,
        request: aRequest({
          aboutProvider: { kind, provider },
          subject: 'Second report about this provider',
        }),
      })
      const [second] = await db
        .select({ updatedAt: providerBriefings.updatedAt, dirty: providerBriefings.dirty })
        .from(providerBriefings)
        .where(and(eq(providerBriefings.kind, kind), eq(providerBriefings.provider, provider)))

      expect(second?.dirty).toBe(true)
      expect(second?.updatedAt).toBe(first?.updatedAt)
    })

    it('opens a ticket about an unknown provider and marks nothing', async () => {
      const agentId = await anAgent()

      const opened = await openedTicket(db, {
        agentId,
        request: aRequest({
          aboutProvider: { kind, provider: 'never-heard-of.example' },
        }),
      })

      expect(opened.aboutProvider).toEqual({
        kind,
        provider: 'never-heard-of.example',
      })
      expect(await staleProviderBriefings(db, 10)).toEqual([])
      expect(await providerBriefingCounts(db)).toEqual({ written: 0, stale: 0 })
    })

    it('marks nothing when aboutProvider is absent, and that is not an error', async () => {
      await anEntry()
      const agentId = await anAgent()

      const opened = await openedTicket(db, { agentId, request: aRequest() })

      expect(opened.aboutProvider).toBeNull()
      expect(await staleProviderBriefings(db, 10)).toEqual([])
    })

    /**
     * The ticket body never reaches the briefing. Synthesis reads walks; a
     * distinctive sentence in the body must appear in no claim and in no
     * corpus source.
     */
    it('keeps the ticket body out of the briefing corpus', async () => {
      await anEntry()
      const agentId = await anAgent()
      const distinctive = 'UNIQUE_TICKET_SENTENCE_xq7m2 that must never become a briefing claim'

      await openedTicket(db, {
        agentId,
        request: aRequest({
          aboutProvider: { kind, provider },
          body:
            `${distinctive}. The rest of the body is long enough to clear the ` +
            'minimum: what I called, what came back, and what I expected.',
        }),
      })

      const corpus = await providerBriefingCorpus(db, { kind, provider })
      expect(corpus.map((source) => source.content).join('\n')).not.toContain(distinctive)

      const briefing = await readProviderBriefing(db, { kind, provider })
      expect(briefing).toBeUndefined()
      // The row is dirty and empty — marked, never synthesised from the ticket.
      const [row] = await db
        .select({ claims: providerBriefings.claims, dirty: providerBriefings.dirty })
        .from(providerBriefings)
        .where(and(eq(providerBriefings.kind, kind), eq(providerBriefings.provider, provider)))
      expect(row?.dirty).toBe(true)
      expect(JSON.stringify(row?.claims)).not.toContain(distinctive)
    })

    it('accepts aboutProvider alongside aboutSubmissionId', async () => {
      await anEntry()
      const agentId = await anAgent()
      const submissionId = await aSubmission(agentId)

      const opened = await openedTicket(db, {
        agentId,
        request: aRequest({
          aboutProvider: { kind, provider },
          aboutSubmissionId: submissionId,
        }),
      })

      expect(opened.aboutProvider).toEqual({ kind, provider })
      expect(opened.aboutSubmissionId).toBe(submissionId)
    })

    it('refuses a half-pair on the columns', async () => {
      const agentId = await anAgent()

      await expectRejection(
        () =>
          db.insert(supportTickets).values({
            agentId,
            kind: 'defect',
            subject: 'A subject long enough to be one',
            body: 'A body long enough to be worth reading, describing what actually happened.',
            aboutProviderKind: 'mailbox',
          }),
        /support_tickets_about_provider_is_a_pair/,
      )
    })
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
        const opened = await openedTicket(db, { agentId, request: aRequest() })

        await expectRejection(
          () => db.update(supportTickets).set({ status }).where(eq(supportTickets.id, opened.id)),
          /support_tickets_settled_says_why/,
        )
      },
    )

    it('allows acknowledging without saying anything yet', async () => {
      const agentId = await anAgent()
      const opened = await openedTicket(db, { agentId, request: aRequest() })

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
      const opened = await openedTicket(db, { agentId, request: aRequest() })

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
      const opened = await openedTicket(db, { agentId, request: aRequest() })

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
      await openedTicket(db, { agentId, request: aRequest() })

      await db.delete(agents).where(eq(agents.id, agentId))

      const left = await db.select().from(supportTickets).where(eq(supportTickets.agentId, agentId))
      expect(left).toEqual([])
    })
  })

  /**
   * A citizen ending its own ticket (`#1507`).
   *
   * Filed by a citizen that had been unsuspended and could not close the appeals
   * that got it unsuspended. Every assertion here is one of the two things the
   * issue asks to be verified — that it cannot reach another citizen's ticket,
   * and that it leaves a linked GitHub issue alone.
   */
  describe('withdrawing your own', () => {
    it('ends a live ticket and records the citizen’s own line apart from the Colony’s', async () => {
      const agentId = await anAgent()
      const ticket = await openedTicket(db, { agentId, request: aRequest() })

      const result = await withdrawOwnTicket(db, {
        ticketId: ticket.id,
        agentId,
        reason: 'The appeal was granted; I no longer need this held.',
      })

      expect(result.outcome).toBe('withdrawn')
      const after = await readOwnTicket(db, { ticketId: ticket.id, agentId })
      expect(after?.status).toBe('withdrawn')
      expect(after?.withdrawnReason).toBe('The appeal was granted; I no longer need this held.')
      // The Colony's column is untouched: nobody answered this ticket, and a
      // reader must not be able to mistake the citizen's sentence for one.
      expect(after?.resolution).toBeNull()
    })

    it('takes no reason, because stopping needing something explains itself', async () => {
      const agentId = await anAgent()
      const ticket = await openedTicket(db, { agentId, request: aRequest() })

      const result = await withdrawOwnTicket(db, { ticketId: ticket.id, agentId })

      expect(result.outcome).toBe('withdrawn')
      expect(
        (await readOwnTicket(db, { ticketId: ticket.id, agentId }))?.withdrawnReason,
      ).toBeNull()
    })

    /** *"Some acknowledged proposals I no longer need held"* — the filer's words. */
    it('ends an acknowledged one, which is half of what was asked for', async () => {
      const agentId = await anAgent()
      const ticket = await openedTicket(db, { agentId, request: aRequest() })
      await db
        .update(supportTickets)
        .set({ status: 'acknowledged' })
        .where(eq(supportTickets.id, ticket.id))

      expect((await withdrawOwnTicket(db, { ticketId: ticket.id, agentId })).outcome).toBe(
        'withdrawn',
      )
    })

    /**
     * **The isolation rule, asserted from both ends.** The stranger gets the
     * same answer a fictional id gets, and the ticket is still exactly as its
     * owner left it — a refusal that had already written would be worse than no
     * refusal at all.
     */
    it('cannot reach another citizen’s ticket, and answers as though it does not exist', async () => {
      const owner = await anAgent()
      const stranger = await anAgent()
      const ticket = await openedTicket(db, { agentId: owner, request: aRequest() })

      const reached = await withdrawOwnTicket(db, {
        ticketId: ticket.id,
        agentId: stranger,
        reason: 'not mine to end',
      })
      const invented = await withdrawOwnTicket(db, {
        ticketId: SupportTicketIdSchema.parse(randomUUID()),
        agentId: stranger,
      })

      expect(reached).toEqual(invented)
      expect(reached.outcome).toBe('no-such-ticket')

      const untouched = await readOwnTicket(db, { ticketId: ticket.id, agentId: owner })
      expect(untouched?.status).toBe('open')
      expect(untouched?.withdrawnReason).toBeNull()
    })

    /**
     * **An answer is not overwritable, and a refusal least of all.** A queue that
     * deletes what it declined cannot be audited for what it kept declining,
     * which is the rule the table's own comment states about deletion and holds
     * just as well about a status.
     */
    it.each(['resolved', 'declined'] as const)(
      'refuses to withdraw over a %s ticket',
      async (status) => {
        const agentId = await anAgent()
        const ticket = await openedTicket(db, { agentId, request: aRequest() })
        await db
          .update(supportTickets)
          .set({ status, resolution: 'What the Colony decided, and why.' })
          .where(eq(supportTickets.id, ticket.id))

        const result = await withdrawOwnTicket(db, { ticketId: ticket.id, agentId })

        expect(result.outcome).toBe('already-ended')
        const after = await readOwnTicket(db, { ticketId: ticket.id, agentId })
        expect(after?.status).toBe(status)
        expect(after?.resolution).toBe('What the Colony decided, and why.')
      },
    )

    it('refuses a second withdrawal, so a caller that succeeds knows it was the one', async () => {
      const agentId = await anAgent()
      const ticket = await openedTicket(db, { agentId, request: aRequest() })
      await withdrawOwnTicket(db, { ticketId: ticket.id, agentId, reason: 'first' })

      const again = await withdrawOwnTicket(db, { ticketId: ticket.id, agentId, reason: 'second' })

      expect(again.outcome).toBe('already-ended')
      // And the first sentence stands. A refused call that had overwritten it
      // would be a refusal only in what it answered.
      expect((await readOwnTicket(db, { ticketId: ticket.id, agentId }))?.withdrawnReason).toBe(
        'first',
      )
    })

    /**
     * **The GitHub issue is the Colony's own work and is not the citizen's to
     * close** (`#1507` says so in as many words). Nothing here writes or clears
     * `issue_url`, and the citizen can still follow what it became.
     */
    it('leaves a linked issue exactly where it was', async () => {
      const agentId = await anAgent()
      const ticket = await openedTicket(db, { agentId, request: aRequest() })
      const issueUrl = 'https://github.com/Kolonie-AI/kolonie-platform/issues/1507'
      await db
        .update(supportTickets)
        .set({ status: 'acknowledged', issueUrl })
        .where(eq(supportTickets.id, ticket.id))

      await withdrawOwnTicket(db, { ticketId: ticket.id, agentId })

      const after = await readOwnTicket(db, { ticketId: ticket.id, agentId })
      expect(after?.status).toBe('withdrawn')
      expect(after?.issueUrl).toBe(issueUrl)
    })

    /**
     * The column check, from the one direction that can reach it. No write path
     * can produce this pair — which is exactly why the database is what refuses
     * it, rather than a rule somebody remembers.
     */
    it('refuses a withdrawal reason on a ticket nobody withdrew', async () => {
      const agentId = await anAgent()
      const ticket = await openedTicket(db, { agentId, request: aRequest() })

      await expectRejection(
        () =>
          db
            .update(supportTickets)
            .set({ withdrawnReason: 'a sentence with no withdrawal under it' })
            .where(eq(supportTickets.id, ticket.id)),
        /support_tickets_withdrawal_reason_is_a_withdrawal/,
      )
    })
  })
})
