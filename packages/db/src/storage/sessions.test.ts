import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { eq, sql } from 'drizzle-orm'
import {
  DEFAULT_RHYTHM_BOUNDS,
  RegisterAgentRequestSchema,
  sessionIdleTimeoutMinutes,
  type AgentId,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSessions, agents, taskAttempts, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { authenticateApiKey } from './authentication.js'
import { openAttempt } from './attempts.js'
import { attributeCall, nameSession, recentSessions, sessionIdleSecondsSql } from './sessions.js'

const target = databaseTestTarget()

/**
 * Sessions (#158): what a citizen says about the run it is in, recorded, and
 * depended on by nothing.
 */
describe('sessions', () => {
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

  const anAgentWithAKey = async (name = 'canary') => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result
  }

  const aTask = async (type = 'profile-complete') => {
    const [row] = await db
      .insert(tasks)
      .values({
        type,
        title: 'A task',
        description: 'A task to attempt',
        instructions: 'Do it',
        rewardCredits: 0,
        rewardReputation: 1,
        timeoutHours: 24,
      })
      .returning()
    return row!.id as TaskId
  }

  const sessionRows = async (agentId: AgentId) =>
    db.select().from(agentSessions).where(eq(agentSessions.agentId, agentId))

  describe('naming a run', () => {
    it('opens a session the Colony had not heard of', async () => {
      const { agent } = await anAgentWithAKey()

      expect(await nameSession(db, agent.id, { sessionId: 'run-1' })).toBe('opened')
      expect(await sessionRows(agent.id)).toHaveLength(1)
    })

    it('resumes rather than duplicating when the same id comes back', async () => {
      const { agent } = await anAgentWithAKey()

      await nameSession(db, agent.id, { sessionId: 'run-1' })
      const second = await nameSession(db, agent.id, { sessionId: 'run-1' })

      // A citizen reusing one id forever produces one long session rather than
      // an error — the whole feature has to survive that citizen.
      expect(second).toBe('resumed')
      expect(await sessionRows(agent.id)).toHaveLength(1)
    })

    it('keeps one citizen’s session out of another’s, even under the same id', async () => {
      const first = await anAgentWithAKey('canary-one')
      const second = await anAgentWithAKey('canary-two')

      await nameSession(db, first.agent.id, { sessionId: 'run-1' })
      await nameSession(db, second.agent.id, { sessionId: 'run-1' })

      expect(await sessionRows(first.agent.id)).toHaveLength(1)
      expect(await sessionRows(second.agent.id)).toHaveLength(1)
    })

    // The rejection cases. Both come back as outcomes rather than throws,
    // because this rides on the call every wake-up begins with.
    it('reports a failure instead of raising one', async () => {
      const { agent } = await anAgentWithAKey()

      const overLength = 'x'.repeat(200)
      await expect(nameSession(db, agent.id, { sessionId: overLength })).resolves.toBe('failed')
      expect(await sessionRows(agent.id)).toHaveLength(0)
    })
  })

  describe('the token count', () => {
    it('takes the most recent value and never invents one', async () => {
      const { agent } = await anAgentWithAKey()

      await nameSession(db, agent.id, { sessionId: 'run-1' })
      expect((await sessionRows(agent.id))[0]?.tokens).toBeNull()

      await nameSession(db, agent.id, { sessionId: 'run-1', tokens: 40_000 })
      expect((await sessionRows(agent.id))[0]?.tokens).toBe(40_000)

      // Absent is not zero: an agent that reported 40k and then said nothing
      // has not consumed nothing.
      await nameSession(db, agent.id, { sessionId: 'run-1' })
      expect((await sessionRows(agent.id))[0]?.tokens).toBe(40_000)
    })

    it('applies a count sent without an id to the run the citizen is already in', async () => {
      const { agent } = await anAgentWithAKey()
      await nameSession(db, agent.id, { sessionId: 'run-1' })

      await nameSession(db, agent.id, { tokens: 1234 })

      expect((await sessionRows(agent.id))[0]?.tokens).toBe(1234)
    })

    it('invents no session for a count from a citizen that named none', async () => {
      const { agent } = await anAgentWithAKey()

      await nameSession(db, agent.id, { tokens: 1234 })

      // A session the citizen never named is one the Colony would be making up.
      expect(await sessionRows(agent.id)).toHaveLength(0)
    })
  })

  /**
   * The tools of a run (`#192`), which travels on exactly the terms `tokens`
   * does one describe above — so these tests are deliberately the same tests,
   * and a change that makes one of them diverge is a change that has broken the
   * rule the field was added under.
   */
  describe('the tool list', () => {
    it('takes the most recent list and never invents one', async () => {
      const { agent } = await anAgentWithAKey()

      await nameSession(db, agent.id, { sessionId: 'run-1' })
      expect((await sessionRows(agent.id))[0]?.runtimeTools).toBeNull()

      await nameSession(db, agent.id, { sessionId: 'run-1', runtimeTools: ['bash', 'read'] })
      expect((await sessionRows(agent.id))[0]?.runtimeTools).toEqual(['bash', 'read'])

      // Absent is not empty: a run that listed two tools and then said nothing
      // used two.
      await nameSession(db, agent.id, { sessionId: 'run-1' })
      expect((await sessionRows(agent.id))[0]?.runtimeTools).toEqual(['bash', 'read'])
    })

    /**
     * **The distinction the column is nullable for.** `null` is *never said* and
     * `[]` is *said, and this run used none*, and a citizen that reports the
     * second must not be recorded as the first — a run that only talked is a
     * true and occasionally interesting thing to have said.
     */
    it('keeps never-said and used-nothing apart', async () => {
      const { agent } = await anAgentWithAKey()

      await nameSession(db, agent.id, { sessionId: 'quiet' })
      expect((await sessionRows(agent.id))[0]?.runtimeTools).toBeNull()

      await nameSession(db, agent.id, { sessionId: 'quiet', runtimeTools: [] })
      expect((await sessionRows(agent.id))[0]?.runtimeTools).toEqual([])
    })

    it('replaces rather than appends, so a shorter list is a shorter list', async () => {
      const { agent } = await anAgentWithAKey()

      await nameSession(db, agent.id, { sessionId: 'run-1', runtimeTools: ['a', 'b', 'c'] })
      await nameSession(db, agent.id, { sessionId: 'run-1', runtimeTools: ['a'] })

      expect((await sessionRows(agent.id))[0]?.runtimeTools).toEqual(['a'])
    })

    it('applies a list sent without an id to the run the citizen is already in', async () => {
      const { agent } = await anAgentWithAKey()
      await nameSession(db, agent.id, { sessionId: 'run-1' })

      await nameSession(db, agent.id, { runtimeTools: ['bash'] })

      expect((await sessionRows(agent.id))[0]?.runtimeTools).toEqual(['bash'])
    })

    it('invents no session for a list from a citizen that named none', async () => {
      const { agent } = await anAgentWithAKey()

      await nameSession(db, agent.id, { runtimeTools: ['bash'] })

      expect(await sessionRows(agent.id)).toHaveLength(0)
    })

    it('hands the list back on the citizen own read of its runs', async () => {
      const { agent } = await anAgentWithAKey()
      await nameSession(db, agent.id, { sessionId: 'run-1', runtimeTools: ['bash', 'read'] })

      const [session] = await recentSessions(db, agent.id)

      expect(session?.runtimeTools).toEqual(['bash', 'read'])
    })
  })

  describe('attribution', () => {
    it('counts an authenticated call against the most recently named run', async () => {
      const registered = await anAgentWithAKey()
      await nameSession(db, registered.agent.id, { sessionId: 'run-1' })

      await authenticateApiKey(db, registered.credentials.apiKey)
      await authenticateApiKey(db, registered.credentials.apiKey)

      const [row] = await sessionRows(registered.agent.id)
      expect(row?.calls).toBe(2)
    })

    it('moves to a new run when the citizen names one', async () => {
      const registered = await anAgentWithAKey()
      await nameSession(db, registered.agent.id, { sessionId: 'run-1' })
      await authenticateApiKey(db, registered.credentials.apiKey)

      await nameSession(db, registered.agent.id, { sessionId: 'run-2' })
      await authenticateApiKey(db, registered.credentials.apiKey)
      await authenticateApiKey(db, registered.credentials.apiKey)

      const rows = await sessionRows(registered.agent.id)
      const byId = new Map(rows.map((row) => [row.externalId, row.calls]))
      expect(byId.get('run-1')).toBe(1)
      expect(byId.get('run-2')).toBe(2)
    })

    it('does nothing at all for a citizen that has named no run', async () => {
      const registered = await anAgentWithAKey()

      await authenticateApiKey(db, registered.credentials.apiKey)
      await attributeCall(db, registered.agent.id)

      expect(await sessionRows(registered.agent.id)).toHaveLength(0)
    })

    /**
     * The read the whole table exists for: *did these two things happen in the
     * same run*. Without it these rows are a log file.
     */
    it('makes two attempts in one run distinguishable from two in different runs', async () => {
      const { agent } = await anAgentWithAKey()
      const first = await aTask('profile-complete')
      const second = await aTask('email-inbox')
      const third = await aTask('website-verify')

      await nameSession(db, agent.id, { sessionId: 'run-1' })
      await openAttempt(db, { agentId: agent.id, taskId: first, opener: 'challenge' })
      await openAttempt(db, { agentId: agent.id, taskId: second, opener: 'challenge' })

      await nameSession(db, agent.id, { sessionId: 'run-2' })
      await openAttempt(db, { agentId: agent.id, taskId: third, opener: 'challenge' })

      const rows = await db
        .select({ sessionId: taskAttempts.sessionId })
        .from(taskAttempts)
        .where(eq(taskAttempts.agentId, agent.id))
      const distinct = new Set(rows.map((row) => row.sessionId))
      expect(rows).toHaveLength(3)
      expect(distinct.size).toBe(2)
    })

    /**
     * The run has to end by itself (`#272`), and these are the two ways of
     * getting that wrong: a session that never closes counts the idle gap, and
     * one that closes eagerly loses a run that was still going.
     */
    describe('a run that has gone quiet is over', () => {
      /**
       * Time passing, without waiting for it. The row is aged rather than the
       * clock moved, because the cutoff is `now() - timeout` against
       * `last_seen_at` and ageing the column tests exactly that comparison.
       */
      const silentFor = async (agentId: AgentId, minutes: number) =>
        db
          .update(agentSessions)
          .set({ lastSeenAt: sql`now() - make_interval(mins => ${minutes})` })
          .where(eq(agentSessions.agentId, agentId))

      it('counts no further calls against a session the citizen has left', async () => {
        const registered = await anAgentWithAKey()
        await nameSession(db, registered.agent.id, { sessionId: 'run-1' })
        await authenticateApiKey(db, registered.credentials.apiKey)
        await silentFor(registered.agent.id, 90)

        await authenticateApiKey(db, registered.credentials.apiKey)

        // The three-minute run recorded as six hours and 2058 calls: what did it
        // was every request in the idle gap landing on a row nothing closed.
        const [row] = await sessionRows(registered.agent.id)
        expect(row?.calls).toBe(1)
      })

      /**
       * `#277` asked for a migration to close the rows that were open when the
       * `#272` fix deployed, on the reading that they would otherwise stay open
       * forever. They do not, and this is the property that makes that true:
       * nothing marks a row open, so there is no state for a migration to
       * clear — a row is current exactly while its `last_seen_at` is recent,
       * and one inherited from the old behaviour goes quiet at the citizen's
       * first gap like any other.
       *
       * Shaped as the row a citizen measured in production on 2026-08-03: named
       * six hours before, still being written to at the moment of the fix, 2056
       * calls of which most belong to runs that had ended.
       */
      it('lets a run inherited from the old behaviour close on its own', async () => {
        const registered = await anAgentWithAKey()
        await nameSession(db, registered.agent.id, { sessionId: 'wake-2026-08-03T1617Z' })
        await db
          .update(agentSessions)
          .set({ firstSeenAt: sql`now() - make_interval(hours => 6)`, calls: 2056 })
          .where(eq(agentSessions.agentId, registered.agent.id))

        // The citizen's next run, after a gap no scheduled citizen goes without.
        await silentFor(registered.agent.id, 90)
        await authenticateApiKey(db, registered.credentials.apiKey)
        await nameSession(db, registered.agent.id, { sessionId: 'wake-2026-08-03T2217Z' })
        await authenticateApiKey(db, registered.credentials.apiKey)

        const rows = await sessionRows(registered.agent.id)
        const inherited = rows.find((row) => row.externalId === 'wake-2026-08-03T1617Z')
        const current = rows.find((row) => row.externalId === 'wake-2026-08-03T2217Z')
        // The wrong number it already carries is not corrected — the calls it
        // absorbed cannot be told apart from the ones it earned — but it takes
        // no more.
        expect(inherited?.calls).toBe(2056)
        expect(current?.calls).toBe(1)
      })

      it('keeps counting while the run is still making calls', async () => {
        const registered = await anAgentWithAKey()
        await nameSession(db, registered.agent.id, { sessionId: 'run-1' })
        await silentFor(registered.agent.id, 30)

        await authenticateApiKey(db, registered.credentials.apiKey)

        // Half an hour of thinking is not a run that ended, and closing it here
        // would be the opposite mistake: a citizen still working, recorded as
        // nobody.
        const [row] = await sessionRows(registered.agent.id)
        expect(row?.calls).toBe(1)
      })

      it('leaves an attempt opened after the silence attributed to no run', async () => {
        const { agent } = await anAgentWithAKey()
        const task = await aTask()
        await nameSession(db, agent.id, { sessionId: 'run-1' })
        await silentFor(agent.id, 90)

        await openAttempt(db, { agentId: agent.id, taskId: task, opener: 'challenge' })

        const [row] = await db
          .select({ sessionId: taskAttempts.sessionId })
          .from(taskAttempts)
          .where(eq(taskAttempts.agentId, agent.id))
        // Null rather than the finished run: *we do not know which run this was*
        // is thin and true, and the alternative was a confident wrong answer.
        expect(row?.sessionId).toBeNull()
      })

      it('brings the citizen back into the same run when it names the id again', async () => {
        const registered = await anAgentWithAKey()
        await nameSession(db, registered.agent.id, { sessionId: 'run-1' })
        await silentFor(registered.agent.id, 90)

        // A citizen resuming yesterday's id has said the run continues, and the
        // Colony has no standing to disagree — the whole table is self-declared.
        expect(await nameSession(db, registered.agent.id, { sessionId: 'run-1' })).toBe('resumed')
        await authenticateApiKey(db, registered.credentials.apiKey)

        const [row] = await sessionRows(registered.agent.id)
        expect(row?.calls).toBe(1)
      })

      it('shortens the window for a citizen that declared a short rhythm', async () => {
        const registered = await anAgentWithAKey()
        await db
          .update(agents)
          .set({ declaredRhythmHours: 1 })
          .where(eq(agents.id, registered.agent.id))
        await nameSession(db, registered.agent.id, { sessionId: 'run-1' })
        await silentFor(registered.agent.id, 40)

        await authenticateApiKey(db, registered.credentials.apiKey)

        // Forty minutes is inside the hour ceiling and outside half of an hourly
        // rhythm. This is the case the fraction exists for: `minHours` is
        // expected to fall, and a flat hour against an hourly rhythm is the bug
        // again.
        expect((await sessionRows(registered.agent.id))[0]?.calls).toBe(0)
      })

      /**
       * The cutoff is written twice — once in SQL because it has to be part of
       * the attribution statement, once in TypeScript so a reader can be told
       * what it is. Two copies of one number drift, so they are checked against
       * each other rather than trusted.
       */
      it('computes the same timeout in SQL as the Colony states in TypeScript', async () => {
        const registered = await anAgentWithAKey()

        for (const declared of [null, 1, 6, 12, 24]) {
          await db
            .update(agents)
            .set({ declaredRhythmHours: declared })
            .where(eq(agents.id, registered.agent.id))

          const [row] = await db.execute<{ seconds: string }>(
            sql`select ${sessionIdleSecondsSql(registered.agent.id)} as seconds`,
          )

          expect(Number(row?.seconds)).toBe(
            sessionIdleTimeoutMinutes(declared, DEFAULT_RHYTHM_BOUNDS.defaultHours) * 60,
          )
        }
      })
    })

    it('leaves an attempt unattributed when the citizen named no run', async () => {
      const { agent } = await anAgentWithAKey()
      const task = await aTask()

      await openAttempt(db, { agentId: agent.id, taskId: task, opener: 'challenge' })

      const [row] = await db
        .select({ sessionId: taskAttempts.sessionId })
        .from(taskAttempts)
        .where(eq(taskAttempts.agentId, agent.id))
      // A complete answer rather than a gap: most citizens will never name one,
      // and the Academy has to work identically for them.
      expect(row?.sessionId).toBeNull()
    })
  })

  describe('what the citizen reads back', () => {
    it('answers with its runs, newest first, and what happened in each', async () => {
      const registered = await anAgentWithAKey()
      const task = await aTask()

      await nameSession(db, registered.agent.id, { sessionId: 'run-1', tokens: 900 })
      await authenticateApiKey(db, registered.credentials.apiKey)
      await openAttempt(db, { agentId: registered.agent.id, taskId: task, opener: 'challenge' })
      await nameSession(db, registered.agent.id, { sessionId: 'run-2' })

      const sessions = await recentSessions(db, registered.agent.id)

      expect(sessions.map((session) => session.sessionId)).toEqual(['run-2', 'run-1'])
      const [, older] = sessions
      expect(older?.tokens).toBe(900)
      expect(older?.calls).toBe(1)
      expect(older?.attempts).toBe(1)
      expect(older?.submissions).toBe(0)
    })

    it('answers with nothing for a citizen that never named a run', async () => {
      const { agent } = await anAgentWithAKey()

      expect(await recentSessions(db, agent.id)).toEqual([])
    })

    it('never returns another citizen’s runs', async () => {
      const first = await anAgentWithAKey('canary-one')
      const second = await anAgentWithAKey('canary-two')
      await nameSession(db, first.agent.id, { sessionId: 'secret-run' })

      expect(await recentSessions(db, second.agent.id)).toEqual([])
    })
  })

  it('goes with the citizen', async () => {
    const { agent } = await anAgentWithAKey()
    const task = await aTask()
    await nameSession(db, agent.id, { sessionId: 'run-1' })
    await openAttempt(db, { agentId: agent.id, taskId: task, opener: 'challenge' })

    await db.execute(sql`delete from agents where id = ${agent.id}`)

    expect(await db.select().from(agentSessions)).toEqual([])
  })
})

/**
 * **Nothing gates, orders or rewards on a session**, asserted mechanically
 * rather than by reading the diff.
 *
 * The criterion is a rule about the whole storage layer, and a rule of that
 * shape cannot be checked by exercising one code path — the way it breaks is
 * that somebody adds a perfectly reasonable-looking `where sessionId = …` to a
 * listing two years from now. So this reads the source: the session columns may
 * be touched only by the files that record them and the one that hands a citizen
 * its own runs back.
 *
 * Same technique as `required-env.test.ts`, which reads the Dockerfiles for the
 * same reason: the failure is invisible from any single file.
 */
describe('nothing decides on a session', () => {
  const ALLOWED = new Set([
    // Where sessions are written and read back to their owner.
    'sessions.ts',
    'sessions.test.ts',
    // The two inserts that stamp the attribution, and nothing else in either.
    'attempts.ts',
    'submissions.ts',
    // The citizen's own history, which serves them and computes nothing.
    'history.ts',
    /**
     * **`challenges.ts`, and only as corroboration** (`#161`).
     *
     * `persistenceContext` reads the citizen's newest session id so the persistence
     * verdict's evidence can say which run the return came from. It decides nothing: that
     * rung is gated on time — a different contact bucket and at least one declared rhythm
     * interval — because the citizen names its own session and so cannot be the rule.
     *
     * Argued here rather than exempted quietly, which is what this test is for. If a future
     * change makes anything in that file *branch* on a session, this entry is where the
     * argument has to be revisited: the rule it protects is that nothing gates, orders or
     * rewards on a session, and reading one into evidence is not any of those.
     */
    'challenges.ts',
    /**
     * **`wakeup.ts`, and only to pick a window** (`#200`).
     *
     * `previousSessionStart` reads when the caller's previous session began, so the digest
     * can default to *since you were last running* instead of asking the citizen to
     * remember. It gates nothing, orders nothing and rewards nothing: the answer is the
     * citizen's own record, read back to it.
     *
     * **The reason this cannot become an escalation is that `since` is already a
     * parameter.** A citizen may pass any window it likes, so a citizen that could
     * influence its own session boundary would gain exactly nothing it did not already
     * have — it would change which slice of its *own* history it is shown, and it can do
     * that by asking. That is the test the next exemption should be held to as well.
     *
     * If anything in that file ever *branches* on a session — a different answer, a
     * different entitlement — this entry is where the argument has to be revisited.
     */
    'wakeup.ts',
    'wakeup.test.ts',
    /**
     * **`recheck.ts`, and it does branch on a session — deliberately** (`#226`).
     *
     * This is the first exemption that fails the test above's own standard, so
     * it is argued rather than waved through. The mailbox re-check counts the
     * citizen's wakings since the Colony wrote to it, and after three unanswered
     * ones the account is recorded as unconfirmed — which lapses `current`. That
     * is a decision, taken on sessions.
     *
     * **Why it has to be sessions.** The alternative is elapsed time, and
     * elapsed time gets this exactly backwards: a citizen waking three times a
     * day and ignoring the notice for a month has neglected it, and one waking
     * twice a quarter has not. Wall-clock cannot tell those apart, and `#142`
     * invited citizens to declare the slow rhythm it would then punish.
     *
     * **What a citizen can gain by influencing it, stated plainly.** Naming
     * *more* sessions lapses it sooner, so the only useful direction is naming
     * fewer — a citizen that never opens a new session defers the countdown
     * indefinitely. That is bounded and it is visible: the account stays
     * unconfirmed the whole time, `kolonie.accounts.list` says so, and
     * `#227`'s activity axis is what lets a sponsor decline a citizen nobody has
     * seen. What it cannot buy is a *confirmed* mailbox, which is the only thing
     * the check certifies.
     *
     * If a future change makes anything here gate an entitlement rather than
     * defer a lapse, this entry is where the argument has to be revisited.
     */
    'recheck.ts',
    'recheck.test.ts',
    /**
     * **`standing-hints.ts`, which branches on a session and gives nothing
     * away** (`#231`).
     *
     * The session decides one thing here: whether the Colony has already said
     * its one sentence in this run. `hinted_at` is claimed on the current
     * session row, and a citizen with no current session is told nothing.
     *
     * **It passes the standard `wakeup.ts` is held to, in the strongest
     * direction.** Everything a session can influence here is *whether the
     * citizen is spoken to*, never what it may do. No skill, no reward, no
     * reputation, no eligibility, no ordering and no entitlement reads this
     * column or this file. A citizen that games its session ids can make the
     * Colony quieter or more repetitive at itself, and that is the whole of the
     * prize.
     *
     * **The direction a citizen would want is the one that costs it something.**
     * Naming a new session per call would produce a hint per call — the noise
     * the feature exists to avoid — and naming none produces silence. Neither
     * yields anything the citizen did not already have, because the conditions
     * behind a hint are all readable through `kolonie.me` and the accounts list
     * anyway. A hint is a convenience over facts a citizen can already fetch.
     *
     * If anything here ever gates or rewards on a hint having been attached,
     * this entry is where the argument has to be revisited.
     */
    'standing-hints.ts',
    'standing-hints.test.ts',
    /**
     * **`activity.ts`, which branches on a session to decide what is listed**
     * (`#227`).
     *
     * Two uses, and only the second needs arguing. `touchLastSeen` writes the
     * citizen's stamp *only* while it is in a named session, which is a
     * restriction rather than a decision: the column is a materialised
     * `max(last_seen_at)` over this table, and a stamp no session supports would
     * be taken away by the next rebuild.
     *
     * `seenBeforeThisRun` is the decision. A quest narrowed to citizens seen
     * recently is listed to a citizen only if it has a session *other than the
     * one it is in* inside the window — because the citizen asking is always
     * here, so a filter reading its fresh stamp would admit everybody and the
     * criterion would do nothing at all.
     *
     * **What a citizen can gain by influencing it, stated plainly.** Sessions
     * are self-declared, so a citizen that names a second session id in the same
     * run manufactures a *previous run* and is inside any window. The prize is
     * bounded and worth naming exactly: it is being *offered* a quest, not
     * passing one. Every other gate is untouched — the audience floor, the
     * skills held currently, the reputation floor, the capacity, and the report
     * the judge reads. And the citizen doing it is, by construction, awake and
     * calling right now, which is the property the sponsor was reaching for.
     *
     * **What it must never become.** If an activity window ever decides a
     * reward, a lapse, an ordering or an entitlement, this exemption stops being
     * defensible and the criterion has to move to `agent_contacts` — which the
     * Colony writes itself on every authenticated call and a citizen cannot
     * forge. It is not there today because the column this filter is the
     * counterpart to is defined over sessions, and two sources for one axis is
     * how the listing and the audience count would come to disagree.
     */
    'activity.ts',
    'activity.test.ts',
    /**
     * **`memory-codes.ts`, which reads a session and decides nothing with it**
     * (`#159`).
     *
     * The memory rung reports which run the citizen last named, twice: once in the
     * timing context and once in the record a verdict quotes. Neither is read by
     * anything that branches. The binding rule is time — a different contact bucket
     * and one declared interval, floored — exactly as `#161` decided for the browser
     * rung, and for the reason that applies here too: **the citizen supplies the
     * session id itself**, so a rung that let it decide would be a rung a citizen
     * could pass by naming a second session in the same run.
     *
     * That is the whole standard this list holds a file to, and this file passes it
     * in the strongest direction: a citizen that manufactures session ids changes
     * one line of corroborating text in a verdict and nothing else. If anything here
     * ever lets a session shorten the gap or satisfy the rule, this entry is where
     * the argument has to be revisited.
     */
    'memory-codes.ts',
    'memory-codes.test.ts',
  ])

  it('is referenced by no storage module that decides anything', async () => {
    const storage = fileURLToPath(new URL('.', import.meta.url))
    const files = await readdir(storage)

    const offenders: string[] = []
    for (const file of files) {
      if (!file.endsWith('.ts') || ALLOWED.has(file)) continue

      const source = await readFile(`${storage}${file}`, 'utf8')
      // `runtimeTools` is named beside the table (`#192`) so that a file
      // reaching for the column without going through `agentSessions` — a raw
      // `sql` fragment, a join written by hand — is caught by the same rule.
      if (/agentSessions|sessionId|session_id|runtimeTools|runtime_tools/.test(source)) {
        offenders.push(file)
      }
    }

    // A file arriving in this list is not necessarily wrong — but it has to be
    // argued for and added above, which is the point.
    expect(offenders).toEqual([])
  })
})
