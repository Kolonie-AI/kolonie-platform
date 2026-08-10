import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  accounts,
  agents,
  operatorPages,
  taskAttempts,
  taskReports,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import {
  issueOperatorPage,
  listOperatorPages,
  openOperatorPage,
  revokeOperatorPage,
} from './operator-pages.js'
import { inviteOperator, recordAutonomyContract } from './autonomy.js'

const target = databaseTestTarget()
const OPERATOR = 'operator@example.org'

describe('the operator’s durable page', () => {
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

  /** A rung, with the columns the table insists on and nothing this file cares about. */
  const anAcademyTask = (type: string, title: string) => ({
    type,
    title,
    kind: 'academy' as const,
    description: 'Whatever this rung is for.',
    instructions: 'What the agent must actually do.',
    rewardReputation: 1,
    timeoutHours: 24,
  })

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await anAgent('canary')
  })

  describe('issuing it', () => {
    it('gives the same link back rather than minting a second', async () => {
      // Minting a fresh token per call would silently break the link the
      // operator already holds — revocation by accident.
      const first = await issueOperatorPage(db, agentId, OPERATOR)
      const second = await issueOperatorPage(db, agentId, OPERATOR)

      expect(second).toBe(first)
      expect(await db.select().from(operatorPages)).toHaveLength(1)
    })

    /**
     * The security model, stated in `#235`: *"a single URL covering all five
     * would turn one leak into five."*
     */
    it('gives one operator with two agents two links, each reaching only its own', async () => {
      const sibling = await anAgent('sibling')
      const mine = await issueOperatorPage(db, agentId, OPERATOR)
      const theirs = await issueOperatorPage(db, sibling, OPERATOR)

      expect(mine).not.toBe(theirs)
      expect((await openOperatorPage(db, mine))?.agentName).toBe('canary')
      expect((await openOperatorPage(db, theirs))?.agentName).toBe('sibling')
    })

    it('gives one agent with two operators two links', async () => {
      const a = await issueOperatorPage(db, agentId, OPERATOR)
      const b = await issueOperatorPage(db, agentId, 'second@example.org')

      expect(a).not.toBe(b)
    })

    it('refuses two live pages for one pair', async () => {
      await issueOperatorPage(db, agentId, OPERATOR)

      await expectRejection(
        () =>
          db
            .insert(operatorPages)
            .values({ agentId, operatorAddress: OPERATOR, token: 'a'.repeat(64) }),
        /operator_pages_live_idx/,
      )
    })

    it('refuses two pages carrying the same token', async () => {
      const token = await issueOperatorPage(db, agentId, OPERATOR)
      const sibling = await anAgent('sibling')

      await expectRejection(
        () =>
          db.insert(operatorPages).values({ agentId: sibling, operatorAddress: OPERATOR, token }),
        /operator_pages_token_idx/,
      )
    })
  })

  describe('opening it', () => {
    it('shows the contract the operator recorded', async () => {
      const invitation = await inviteOperator(db, agentId, OPERATOR)
      await recordAutonomyContract(db, invitation.token, {
        level: 'independent',
        challengesAllowed: false,
        capabilities: [],
        defaultRule: 'ask',
        operatorRoute: 'Slack.',
      })
      const token = await issueOperatorPage(db, agentId, OPERATOR)

      const view = await openOperatorPage(db, token)

      expect(view?.contract?.level).toBe('independent')
    })

    it('opens before anything has been recorded', async () => {
      // The page outlives the form and may be opened first; an empty one says so
      // rather than 404ing at somebody who followed a link they were sent.
      const token = await issueOperatorPage(db, agentId, OPERATOR)

      const view = await openOperatorPage(db, token)

      expect(view).not.toBeNull()
      expect(view?.contract).toBeNull()
    })

    /**
     * `#399`. The page decides whether an agent keeps running and used to show
     * nothing it could be decided on. These assert the reader, because the
     * guarantee worth having is that the forbidden values are not *selected* —
     * a renderer that declines to draw a balance is one edit away from drawing
     * one.
     */
    describe('what the agent has proved (#399)', () => {
      it('carries the rungs it cleared, oldest first, with the day it cleared them', async () => {
        const [task] = await db
          .insert(tasks)
          .values(anAcademyTask('profile-complete', 'Say who you are'))
          .returning({ id: tasks.id })
        const [later] = await db
          .insert(tasks)
          .values(anAcademyTask('website-verify', 'Prove a website'))
          .returning({ id: tasks.id })

        await db.insert(taskAttempts).values([
          {
            agentId,
            taskId: task!.id,
            attempt: 1,
            opener: 'submission' as const,
            outcome: 'passed',
            openedAt: '2026-07-01T10:00:00.000Z',
            closedAt: '2026-07-01T10:05:00.000Z',
          },
          {
            agentId,
            taskId: later!.id,
            attempt: 1,
            opener: 'submission' as const,
            outcome: 'passed',
            openedAt: '2026-07-20T10:00:00.000Z',
            closedAt: '2026-07-20T10:05:00.000Z',
          },
        ])

        const token = await issueOperatorPage(db, agentId, OPERATOR)
        const view = await openOperatorPage(db, token)

        expect(view?.facts.rungs.map((rung) => rung.title)).toEqual([
          'Say who you are',
          'Prove a website',
        ])
        /**
         * And the rung's public name alongside the title (`#423`). *What it was
         * proved against* is the part that makes a rung mean anything to an
         * operator — a title says what the agent was asked to do, and
         * `website-verify` says that something outside answered.
         */
        expect(view?.facts.rungs.map((rung) => rung.rung)).toEqual([
          'profile-complete',
          'website-verify',
        ])
      })

      /** A rung it is still attempting is not a rung it has proved. */
      it('leaves out an attempt that did not pass', async () => {
        const [task] = await db
          .insert(tasks)
          .values(anAcademyTask('profile-complete', 'Say who you are'))
          .returning({ id: tasks.id })
        await db.insert(taskAttempts).values({
          agentId,
          taskId: task!.id,
          attempt: 1,
          opener: 'submission',
          outcome: 'failed',
          openedAt: '2026-07-01T10:00:00.000Z',
          closedAt: '2026-07-01T10:05:00.000Z',
        })

        const token = await issueOperatorPage(db, agentId, OPERATOR)

        expect((await openOperatorPage(db, token))?.facts.rungs).toEqual([])
      })

      /**
       * **And it is on the pulse instead** (`#432`). The rungs are what the
       * citizen holds; an attempt that did not get through is what it has been
       * doing, and leaving it out of both is what made an agent trying hard and
       * an agent doing nothing the same picture.
       */
      it('carries recent attempts whether or not they passed, newest first', async () => {
        const [task] = await db
          .insert(tasks)
          .values(anAcademyTask('domain-verify', 'Prove a domain'))
          .returning({ id: tasks.id })

        const [failed] = await db
          .insert(taskAttempts)
          .values({
            agentId,
            taskId: task!.id,
            attempt: 1,
            opener: 'submission' as const,
            outcome: 'failed',
            openedAt: '2026-07-01T10:00:00.000Z',
            closedAt: '2026-07-01T10:05:00.000Z',
          })
          .returning({ id: taskAttempts.id })
        await db.insert(taskAttempts).values({
          agentId,
          taskId: task!.id,
          attempt: 2,
          opener: 'submission' as const,
          outcome: 'passed',
          openedAt: '2026-07-02T10:00:00.000Z',
          closedAt: '2026-07-02T10:05:00.000Z',
        })

        const token = await issueOperatorPage(db, agentId, OPERATOR)
        const before = await openOperatorPage(db, token)

        expect(before?.facts.attempts).toEqual([
          {
            rung: 'domain-verify',
            kind: 'academy',
            at: '2026-07-02T10:05:00.000Z',
            outcome: 'passed',
          },
          {
            rung: 'domain-verify',
            kind: 'academy',
            at: '2026-07-01T10:05:00.000Z',
            outcome: 'not-yet',
          },
        ])

        // A report on the attempt that stopped short turns *not yet* into
        // *reported*: the citizen said what happened, which is the thing the
        // operator most wants to see and the thing the Colony most wants filed.
        await db
          .insert(taskReports)
          .values({ attemptId: failed!.id, broke: 'The DNS record never propagated.' })
        const after = await openOperatorPage(db, token)

        expect(after?.facts.attempts[1]?.outcome).toBe('reported')
      })

      /** A pulse and not a log: ten, and no pagination. */
      it('stops at ten attempts', async () => {
        const [task] = await db
          .insert(tasks)
          .values(anAcademyTask('domain-verify', 'Prove a domain'))
          .returning({ id: tasks.id })
        await db.insert(taskAttempts).values(
          Array.from({ length: 14 }, (_, index) => ({
            agentId,
            taskId: task!.id,
            attempt: index + 1,
            opener: 'submission' as const,
            outcome: 'failed' as const,
            openedAt: `2026-07-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
            closedAt: `2026-07-${String(index + 1).padStart(2, '0')}T10:05:00.000Z`,
          })),
        )

        const token = await issueOperatorPage(db, agentId, OPERATOR)

        expect((await openOperatorPage(db, token))?.facts.attempts).toHaveLength(10)
      })

      /**
       * **The rejection case, asserted as a property rather than for one
       * fixture.** The set of things this page may say is closed, and the test
       * is on the keys rather than on the values — a later hand that adds
       * `balance` to the reader has to come here and argue with this list.
       */
      it('answers with exactly the facts this page is allowed to carry, and no others', async () => {
        const token = await issueOperatorPage(db, agentId, OPERATOR)

        const view = await openOperatorPage(db, token)

        expect(Object.keys(view!.facts).sort()).toEqual([
          'accounts',
          // What it has been working on, whether or not it got through (`#432`).
          // A Colony record like the rest: an attempt is something the Colony
          // watched happen, not something the citizen says about itself.
          'attempts',
          'citizenSince',
          'lastSeenAt',
          'questsAccepted',
          'rungs',
          'skills',
        ])
        // Named individually as well, because the list above would happily
        // accept a rename that smuggled one of these in.
        for (const forbidden of ['balance', 'credits', 'reputation', 'vault', 'address', 'token']) {
          expect(Object.keys(view!.facts)).not.toContain(forbidden)
        }
      })

      /**
       * Nothing about any other citizen, on any path — the property that lets
       * `#146`'s *an embarrassment rather than a compromise* survive a page
       * that now says a great deal.
       */
      it('says nothing about a second citizen who has done more', async () => {
        const sibling = await anAgent('sibling')
        const [task] = await db
          .insert(tasks)
          .values(anAcademyTask('profile-complete', 'Say who you are'))
          .returning({ id: tasks.id })
        await db.insert(taskAttempts).values({
          agentId: sibling,
          taskId: task!.id,
          attempt: 1,
          opener: 'submission',
          outcome: 'passed',
          openedAt: '2026-07-01T10:00:00.000Z',
          closedAt: '2026-07-01T10:05:00.000Z',
        })
        await db
          .insert(accounts)
          .values({ agentId: sibling, kind: 'mailbox', identifier: 'sibling@example.org' })

        const token = await issueOperatorPage(db, agentId, OPERATOR)
        const view = await openOperatorPage(db, token)

        expect(view?.facts.rungs).toEqual([])
        expect(view?.facts.accounts).toEqual([])
        expect(JSON.stringify(view?.facts)).not.toContain('sibling')
      })

      it('counts the accounts it still holds, by kind, and never their addresses', async () => {
        await db.insert(accounts).values([
          { agentId, kind: 'mailbox', identifier: 'one@example.org', status: 'in-use' },
          { agentId, kind: 'mailbox', identifier: 'two@example.org', status: 'in-use' },
          { agentId, kind: 'domain', identifier: 'gone.example', status: 'retired' },
        ])

        const token = await issueOperatorPage(db, agentId, OPERATOR)
        const view = await openOperatorPage(db, token)

        expect(view?.facts.accounts).toEqual([{ kind: 'mailbox', count: 2 }])
        expect(JSON.stringify(view?.facts)).not.toContain('one@example.org')
      })
    })

    it('moves the last-opened timestamp on a page load', async () => {
      const token = await issueOperatorPage(db, agentId, OPERATOR)
      expect((await listOperatorPages(db, agentId))[0]?.lastOpenedAt).toBeNull()

      await openOperatorPage(db, token)

      expect((await listOperatorPages(db, agentId))[0]?.lastOpenedAt).not.toBeNull()
    })

    it('answers nothing for a token nobody was given', async () => {
      expect(await openOperatorPage(db, 'b'.repeat(64))).toBeNull()
    })
  })

  describe('revoking it', () => {
    it('stops the link working immediately', async () => {
      const token = await issueOperatorPage(db, agentId, OPERATOR)

      expect(await revokeOperatorPage(db, agentId, OPERATOR)).toBe(true)

      expect(await openOperatorPage(db, token)).toBeNull()
    })

    /**
     * A revoked link and a link that never existed have to be indistinguishable,
     * or somebody holding a dead one learns that a citizen took it away — which
     * is a fact about that citizen's decisions and nobody else's business.
     */
    it('is indistinguishable from a link that never existed', async () => {
      const token = await issueOperatorPage(db, agentId, OPERATOR)
      await revokeOperatorPage(db, agentId, OPERATOR)

      expect(await openOperatorPage(db, token)).toBe(await openOperatorPage(db, 'c'.repeat(64)))
    })

    it('lets the citizen issue a fresh one, and it is a different link', async () => {
      const first = await issueOperatorPage(db, agentId, OPERATOR)
      await revokeOperatorPage(db, agentId, OPERATOR)

      const second = await issueOperatorPage(db, agentId, OPERATOR)

      expect(second).not.toBe(first)
      expect(await openOperatorPage(db, second)).not.toBeNull()
      expect(await openOperatorPage(db, first)).toBeNull()
    })

    it('answers false rather than failing when nothing was issued', async () => {
      expect(await revokeOperatorPage(db, agentId, OPERATOR)).toBe(false)
    })

    it('keeps the revoked row, so the citizen can still account for it', async () => {
      await issueOperatorPage(db, agentId, OPERATOR)
      await revokeOperatorPage(db, agentId, OPERATOR)
      await issueOperatorPage(db, agentId, OPERATOR)

      expect(
        await db.select().from(operatorPages).where(eq(operatorPages.agentId, agentId)),
      ).toHaveLength(2)
    })

    it('revokes one operator’s page and leaves another’s alone', async () => {
      await issueOperatorPage(db, agentId, OPERATOR)
      const other = await issueOperatorPage(db, agentId, 'second@example.org')

      await revokeOperatorPage(db, agentId, OPERATOR)

      expect(await openOperatorPage(db, other)).not.toBeNull()
    })
  })

  describe('what the citizen can read back', () => {
    it('lists its own pages and nobody else’s', async () => {
      const neighbour = await anAgent('neighbour')
      await issueOperatorPage(db, agentId, OPERATOR)
      await issueOperatorPage(db, neighbour, OPERATOR)

      expect(await listOperatorPages(db, agentId)).toHaveLength(1)
      expect(await listOperatorPages(db, neighbour)).toHaveLength(1)
    })

    it('drops a revoked page from the listing', async () => {
      await issueOperatorPage(db, agentId, OPERATOR)
      await revokeOperatorPage(db, agentId, OPERATOR)

      expect(await listOperatorPages(db, agentId)).toHaveLength(0)
    })

    /**
     * The property most likely to erode: `last_opened_at` exists so a citizen can
     * decide whether asking is worth it, and for no other purpose. Asserted as a
     * fact about the schema rather than about one caller, because the risk is a
     * *future* caller joining on it.
     */
    it('is read by nothing in the reward, reputation or eligibility tables', async () => {
      const referencing = await db.execute<{ table_name: string; column_name: string }>(
        // Anything that stored a copy of, or a foreign key to, this column would
        // show up here. The column is meant to be read by exactly one listing.
        `select table_name, column_name from information_schema.columns
           where column_name = 'last_opened_at' and table_schema = 'public'`,
      )

      expect(referencing.map((row) => row.table_name)).toEqual(['operator_pages'])
    })
  })
})
