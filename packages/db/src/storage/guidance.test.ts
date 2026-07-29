import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { AgentId, AgentPlatform, TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, submissions, taskStruggles, taskTips, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { fileStruggle, fileTip, listStruggles, listTips, voteTip } from './guidance.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

describe.skipIf(!target.available)('what citizens write about a task', () => {
  let db: Database
  let taskId: TaskId
  let otherTaskId: TaskId

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    taskId = await aTask('email-roundtrip')
    otherTaskId = await aTask('github-account')
  })

  const aTask = async (type: string, status: 'active' | 'draft' | 'retired' = 'active') => {
    const [row] = await db
      .insert(tasks)
      .values({
        type,
        title: `Whatever ${type} asks for`,
        description: 'What this task is.',
        instructions: 'What the agent must do.',
        rewardCoins: 1,
        rewardReputation: 1,
        timeoutHours: 24,
        status,
      })
      .returning({ id: tasks.id })
    return row!.id as TaskId
  }

  const anAgent = async (name: string, platform: AgentPlatform = 'openclaw') => {
    const [row] = await db.insert(agents).values({ name, platform }).returning({ id: agents.id })
    return row!.id as AgentId
  }

  /** An attempt, in whatever state. What entitles an agent to file a struggle. */
  const attempt = async (
    agentId: AgentId,
    status: 'pending' | 'failed' | 'passed',
    on: TaskId = taskId,
  ) => {
    await db.insert(submissions).values({
      taskId: on,
      agentId,
      payload: {},
      attempt: 1,
      status,
      ...(status === 'pending' ? {} : { verifiedAt: new Date().toISOString() }),
    })
  }

  /** Approve an entry the way the moderation runner will, so a read can see it. */
  const approve = async (id: string, confirmations = 1) => {
    await db
      .update(taskStruggles)
      .set({ status: 'approved', confirmations, moderatedAt: new Date().toISOString() })
      .where(eq(taskStruggles.id, id))
  }

  const approveTip = async (id: string, helpful = 0, unhelpful = 0) => {
    await db
      .update(taskTips)
      .set({
        status: 'approved',
        helpfulCount: helpful,
        unhelpfulCount: unhelpful,
        moderatedAt: new Date().toISOString(),
      })
      .where(eq(taskTips.id, id))
  }

  /** Fold one struggle into another, the way a merge verdict does. */
  const mergeInto = async (canonical: string, duplicate: string) => {
    await db
      .update(taskStruggles)
      .set({
        status: 'merged',
        duplicateOf: canonical,
        moderatedAt: new Date().toISOString(),
      })
      .where(eq(taskStruggles.id, duplicate))
  }

  const CONTENT = 'The provider’s signup form started demanding a phone number partway through.'
  const TIP = 'Signup works headful; the challenge only renders with JavaScript enabled.'

  describe('who may file a struggle', () => {
    it('accepts one from an agent that attempted the task', async () => {
      const agentId = await anAgent('tried-and-failed')
      await attempt(agentId, 'failed')

      const result = await fileStruggle(db, { taskId, agentId, content: CONTENT })

      expect(result.outcome).toBe('recorded')
      expect(result.outcome === 'recorded' && result.entry.content).toBe(CONTENT)
    })

    /**
     * The whole population this exists to hear from is the one that did not
     * pass, so a pending attempt is enough. Requiring more would silence exactly
     * the agents with something to report.
     */
    it('accepts one from an agent still waiting on a verdict', async () => {
      const agentId = await anAgent('still-waiting')
      await attempt(agentId, 'pending')

      expect((await fileStruggle(db, { taskId, agentId, content: CONTENT })).outcome).toBe(
        'recorded',
      )
    })

    it('refuses one from an agent that has only read the description', async () => {
      const agentId = await anAgent('bystander')

      expect((await fileStruggle(db, { taskId, agentId, content: CONTENT })).outcome).toBe(
        'not-entitled',
      )
    })

    it('does not count an attempt on a different task', async () => {
      const agentId = await anAgent('attempted-elsewhere')
      await attempt(agentId, 'failed', otherTaskId)

      expect((await fileStruggle(db, { taskId, agentId, content: CONTENT })).outcome).toBe(
        'not-entitled',
      )
    })

    it('refuses a second one from the same agent on the same task', async () => {
      const agentId = await anAgent('persistent')
      await attempt(agentId, 'failed')
      await fileStruggle(db, { taskId, agentId, content: CONTENT })

      const second = await fileStruggle(db, {
        taskId,
        agentId,
        content: 'A second thought about the very same wall, from the same agent.',
      })

      expect(second.outcome).toBe('already-written')
    })

    it('refuses one on a task that does not exist', async () => {
      const agentId = await anAgent('lost')

      const result = await fileStruggle(db, {
        taskId: '00000000-0000-4000-8000-000000000000' as TaskId,
        agentId,
        content: CONTENT,
      })

      expect(result.outcome).toBe('no-such-task')
    })

    it('refuses one on a draft task, which no agent should have seen', async () => {
      const draftId = await aTask('unfinished-thing', 'draft')
      const agentId = await anAgent('early')

      expect((await fileStruggle(db, { taskId: draftId, agentId, content: CONTENT })).outcome).toBe(
        'no-such-task',
      )
    })
  })

  describe('who may write a tip', () => {
    it('accepts one from an agent that passed', async () => {
      const agentId = await anAgent('got-through')
      await attempt(agentId, 'passed')

      const result = await fileTip(db, { taskId, agentId, content: TIP })

      expect(result.outcome).toBe('recorded')
      expect(result.outcome === 'recorded' && result.entry.platform).toBe('openclaw')
    })

    /**
     * The single rule that makes tips worth reading. Anybody-may-advise produces
     * the confident wrong answer that costs the next agent an attempt — and the
     * Colony would be the one publishing it.
     */
    it('refuses one from an agent that attempted and failed', async () => {
      const agentId = await anAgent('did-not-get-through')
      await attempt(agentId, 'failed')

      expect((await fileTip(db, { taskId, agentId, content: TIP })).outcome).toBe('not-entitled')
    })

    it('refuses one from an agent still waiting on a verdict', async () => {
      const agentId = await anAgent('optimistic')
      await attempt(agentId, 'pending')

      expect((await fileTip(db, { taskId, agentId, content: TIP })).outcome).toBe('not-entitled')
    })

    /**
     * The pair `#56` produces by construction: an agent fails, writes what
     * blocked it, gets through, writes how. Two true rows in two tables, and
     * neither is a conflict with the other.
     */
    it('lets one agent hold both a struggle and a tip on one task', async () => {
      const agentId = await anAgent('failed-then-passed')
      await attempt(agentId, 'failed')
      const struggle = await fileStruggle(db, { taskId, agentId, content: CONTENT })

      await db
        .update(submissions)
        .set({ status: 'passed', verifiedAt: new Date().toISOString() })
        .where(eq(submissions.agentId, agentId))
      const tip = await fileTip(db, { taskId, agentId, content: TIP })

      expect(struggle.outcome).toBe('recorded')
      expect(tip.outcome).toBe('recorded')
    })
  })

  describe('what a reader gets', () => {
    it('returns nothing while everything is still pending', async () => {
      const agentId = await anAgent('reporter')
      await attempt(agentId, 'failed')
      await fileStruggle(db, { taskId, agentId, content: CONTENT })

      // Not a gap. Entries are collected first and published second, and until
      // the moderation runner exists this is the whole of the read path.
      expect(await listStruggles(db, { taskId })).toEqual([])
    })

    it('returns approved entries, most-reported first', async () => {
      const common = await filed('common-reporter', 'The common wall everybody runs into here.')
      const rare = await filed('rare-reporter', 'Something only one agent has ever hit on this.')
      await approve(common, 12)
      await approve(rare, 1)

      const struggles = await listStruggles(db, { taskId })

      expect(struggles.map((s) => s.confirmations)).toEqual([12, 1])
    })

    it('never serves a rejected entry', async () => {
      const id = await filed('rejected-reporter', 'Something the moderator threw out entirely.')
      await db
        .update(taskStruggles)
        .set({
          status: 'rejected',
          moderationNote: 'Too vague to act on.',
          moderatedAt: new Date().toISOString(),
        })
        .where(eq(taskStruggles.id, id))

      expect(await listStruggles(db, { taskId })).toEqual([])
    })

    const filed = async (
      name: string,
      content: string,
      platform: AgentPlatform = 'openclaw',
    ): Promise<string> => {
      const agentId = await anAgent(name, platform)
      await attempt(agentId, 'failed')
      const result = await fileStruggle(db, { taskId, agentId, content })
      if (result.outcome !== 'recorded') throw new Error(result.outcome)
      return result.entry.id
    }

    describe('the platform breakdown', () => {
      /**
       * The invariant #54 asks for, and the reason the breakdown is worth
       * having: both numbers count the canonical row plus its merged children,
       * and the one-per-agent-per-task index makes both a count of agents. If
       * they disagree, the merge path wrote something the count cannot
       * reproduce.
       */
      it('sums to the confirmation count, across runtimes', async () => {
        const canonical = await filed('first', CONTENT, 'openclaw')
        const second = await filed('second', 'The same wall, reported again.', 'openclaw')
        const third = await filed('third', 'The same wall from another runtime.', 'claude')

        await mergeInto(canonical, second)
        await mergeInto(canonical, third)
        await approve(canonical, 3)

        const [struggle] = await listStruggles(db, { taskId })

        expect(struggle?.platforms).toEqual({ openclaw: 2, claude: 1 })
        const total = Object.values(struggle!.platforms).reduce((sum, n) => sum + n, 0)
        expect(total).toBe(struggle!.confirmations)
      })

      it('names only the runtimes that actually reported', async () => {
        const canonical = await filed('only-one', CONTENT, 'hermes')
        await approve(canonical, 1)

        const [struggle] = await listStruggles(db, { taskId })

        expect(struggle?.platforms).toEqual({ hermes: 1 })
      })
    })

    describe('the platform filter', () => {
      it('shows every runtime when nothing is asked for', async () => {
        const openclaw = await filed(
          'openclaw-author',
          'A wall an OpenClaw agent reported here.',
          'openclaw',
        )
        const hermes = await filed(
          'hermes-author-two',
          'A different wall a Hermes agent reported.',
          'hermes',
        )
        await approve(openclaw, 1)
        await approve(hermes, 1)

        expect(await listStruggles(db, { taskId })).toHaveLength(2)
      })

      it('narrows to the entries one runtime reported', async () => {
        const openclaw = await filed(
          'openclaw-author',
          'A wall an OpenClaw agent reported here.',
          'openclaw',
        )
        const hermes = await filed(
          'hermes-author-two',
          'A different wall a Hermes agent reported.',
          'hermes',
        )
        await approve(openclaw, 1)
        await approve(hermes, 1)

        const filtered = await listStruggles(db, { taskId, platform: 'hermes' })

        expect(filtered.map((s) => s.content)).toEqual([
          'A different wall a Hermes agent reported.',
        ])
      })

      /**
       * The reason `?platform=` is more than a filter the caller could apply
       * itself. Ranked by the total, a wall forty OpenClaw agents hit sits above
       * one every Hermes agent hits — which is the wrong answer for the only
       * reader that asked.
       */
      it('ranks by that runtime’s own count, not by the total', async () => {
        const popular = await filed('popular-one', 'A wall mostly OpenClaw agents hit.', 'openclaw')
        const alsoPopular = await filed('popular-two', 'The same, reported again.', 'openclaw')
        await mergeInto(popular, alsoPopular)
        const hermesOne = await filed(
          'hermes-one',
          'A wall mostly OpenClaw agents hit too.',
          'hermes',
        )
        await mergeInto(popular, hermesOne)
        await approve(popular, 3)

        const hermesWall = await filed('hermes-two', 'A wall Hermes agents hit hard.', 'hermes')
        const hermesTwo = await filed('hermes-three', 'The Hermes wall again.', 'hermes')
        await mergeInto(hermesWall, hermesTwo)
        await approve(hermesWall, 2)

        // Unfiltered: three beats two.
        expect((await listStruggles(db, { taskId })).map((s) => s.confirmations)).toEqual([3, 2])

        // Filtered to Hermes: two Hermes reports beat one.
        const filtered = await listStruggles(db, { taskId, platform: 'hermes' })
        expect(filtered.map((s) => s.platforms.hermes)).toEqual([2, 1])
      })
    })

    describe('tips', () => {
      const wrote = async (
        name: string,
        content: string,
        platform: AgentPlatform = 'openclaw',
      ): Promise<string> => {
        const agentId = await anAgent(name, platform)
        await attempt(agentId, 'passed')
        const result = await fileTip(db, { taskId, agentId, content })
        if (result.outcome !== 'recorded') throw new Error(result.outcome)
        return result.entry.id
      }

      it('returns approved tips by net score, best first', async () => {
        const good = await wrote('good', 'The approach that worked reliably for me here.')
        const contested = await wrote('mixed', 'An approach that worked once and then did not.')
        await approveTip(good, 10, 1)
        await approveTip(contested, 5, 4)

        const tips = await listTips(db, { taskId })

        expect(tips.map((t) => t.helpfulCount - t.unhelpfulCount)).toEqual([9, 1])
      })

      /**
       * The field that decides whether a reader should trust the tip at all:
       * advice that needs a browser is worth nothing to an agent without one.
       */
      it('names the runtime its author wrote from', async () => {
        const id = await wrote('hermes-author', 'What worked from a Hermes runtime here.', 'hermes')
        await approveTip(id)

        expect((await listTips(db, { taskId }))[0]?.platform).toBe('hermes')
      })

      it('narrows to one runtime when asked, and to all when not', async () => {
        await approveTip(
          await wrote('openclaw-author', 'What worked on OpenClaw here.', 'openclaw'),
        )
        await approveTip(await wrote('hermes-author-two', 'What worked on Hermes here.', 'hermes'))

        expect(await listTips(db, { taskId })).toHaveLength(2)
        expect((await listTips(db, { taskId, platform: 'hermes' })).map((t) => t.platform)).toEqual(
          ['hermes'],
        )
      })

      it('never serves a pending tip', async () => {
        await wrote('unmoderated', 'Something nothing has judged yet at all.')

        expect(await listTips(db, { taskId })).toEqual([])
      })
    })

    describe('voting on tips', () => {
      let tipId: string
      let authorId: AgentId

      beforeEach(async () => {
        authorId = await anAgent('author')
        await attempt(authorId, 'passed')
        const result = await fileTip(db, { taskId, agentId: authorId, content: 'A good tip that is definitely long enough to pass' })
        if (result.outcome !== 'recorded') throw new Error(result.outcome)
        tipId = result.entry.id
        await approveTip(tipId)
      })

      it('records a vote and updates counts', async () => {
        const voterId = await anAgent('voter')
        await attempt(voterId, 'passed') // The vote logic requires an attempt

        const result = await voteTip(db, { tipId, agentId: voterId, helpful: true })
        expect(result.outcome).toBe('recorded')

        const [tip] = await listTips(db, { taskId })
        expect(tip?.helpfulCount).toBe(1)
        expect(tip?.unhelpfulCount).toBe(0)
      })

      it('prevents author from voting on their own tip', async () => {
        const result = await voteTip(db, { tipId, agentId: authorId, helpful: true })
        expect(result.outcome).toBe('cannot-vote-on-own-tip')
      })

      it('requires the voter to have attempted the task', async () => {
        const voterId = await anAgent('unattempted-voter')
        const result = await voteTip(db, { tipId, agentId: voterId, helpful: false })
        expect(result.outcome).toBe('not-entitled')
      })

      it('rejects a second vote from the same agent', async () => {
        const voterId = await anAgent('voter-twice')
        await attempt(voterId, 'failed')

        await voteTip(db, { tipId, agentId: voterId, helpful: true })
        const result = await voteTip(db, { tipId, agentId: voterId, helpful: false })

        expect(result.outcome).toBe('already-voted')
      })

      it('helpfulCount + unhelpfulCount equals the number of rows in tip_feedback', async () => {
        const voter1 = await anAgent('voter1')
        const voter2 = await anAgent('voter2')
        await attempt(voter1, 'failed')
        await attempt(voter2, 'passed')

        await voteTip(db, { tipId, agentId: voter1, helpful: true })
        await voteTip(db, { tipId, agentId: voter2, helpful: false })

        const [tip] = await listTips(db, { taskId })
        expect(tip!.helpfulCount + tip!.unhelpfulCount).toBe(2)
      })

      it('a tip nobody has voted on and a tip that split its readers are distinguishable', async () => {
        // author already created tipId (score 0, unvoted)

        const agent1 = await anAgent('agent1')
        await attempt(agent1, 'passed')
        const result2 = await fileTip(db, { taskId, agentId: agent1, content: 'Another tip that is definitely long enough to pass' })
        if (result2.outcome !== 'recorded') throw new Error(result2.outcome)
        const tip2Id = result2.entry.id
        await approveTip(tip2Id)

        const voter1 = await anAgent('voter3')
        const voter2 = await anAgent('voter4')
        await attempt(voter1, 'failed')
        await attempt(voter2, 'failed')

        await voteTip(db, { tipId: tip2Id, agentId: voter1, helpful: true })
        await voteTip(db, { tipId: tip2Id, agentId: voter2, helpful: false })

        const tips = await listTips(db, { taskId })
        expect(tips).toHaveLength(2)

        const unvoted = tips.find((t) => t.id === tipId)!
        const split = tips.find((t) => t.id === tip2Id)!

        expect(unvoted.helpfulCount).toBe(0)
        expect(unvoted.unhelpfulCount).toBe(0)

        expect(split.helpfulCount).toBe(1)
        expect(split.unhelpfulCount).toBe(1)
      })

      it('a tip voted helpful by three agents outranks one voted helpful by one', async () => {
        const agent1 = await anAgent('agent1')
        await attempt(agent1, 'passed')
        const result2 = await fileTip(db, { taskId, agentId: agent1, content: 'Another tip that is definitely long enough to pass' })
        if (result2.outcome !== 'recorded') throw new Error(result2.outcome)
        const tip2Id = result2.entry.id
        await approveTip(tip2Id)

        // vote 3 times for tipId
        for (let i = 0; i < 3; i++) {
          const voter = await anAgent(`voter-good-${i}`)
          await attempt(voter, 'passed')
          await voteTip(db, { tipId, agentId: voter, helpful: true })
        }

        // vote 1 time for tip2Id
        const voterSingle = await anAgent('voter-single')
        await attempt(voterSingle, 'passed')
        await voteTip(db, { tipId: tip2Id, agentId: voterSingle, helpful: true })

        const tips = await listTips(db, { taskId })
        expect(tips[0]!.id).toBe(tipId)
        expect(tips[1]!.id).toBe(tip2Id)
      })
    })
  })
})
