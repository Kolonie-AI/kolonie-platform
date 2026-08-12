import { randomUUID } from 'node:crypto'
import {
  AutonomyRecommendationResponseSchema,
  PermissionReportResponseSchema,
} from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony, type FakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'
import { aTicketRequest } from '../../__fixtures__/support.js'

/**
 * Blocked by permission rather than by ability (#147).
 *
 * What is asserted here is what a reviewer cannot see in the diff: that a permission
 * report reaches no reader but its author, that the recommendation asks for the
 * minimum and never for `free`, and that it is willing to say *nothing here would
 * help*.
 */
describe('kolonie.autonomy.blocked', () => {
  const aLimitedCitizen = async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: `limited-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    const { agent, credentials } = registered.response
    const taskId = colony.permissionReportStore.giveTask('github-account')

    return { colony, agent, apiKey: credentials.apiKey, taskId }
  }

  const NEEDED = 'My operator has not allowed me to hold accounts under my own name yet.'

  const report = async (
    colony: FakeColony,
    apiKey: string,
    taskId: string,
    block = 'hold-an-account',
    needed = NEEDED,
  ) => {
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const result = await client.callTool({
      name: 'kolonie.autonomy.blocked',
      arguments: { taskId, block, needed },
    })
    return { client, close, result }
  }

  it('appears only once a credential is presented', async () => {
    const { colony } = await aLimitedCitizen()
    const { client, close } = await connectedClient(colony)

    const names = (await client.listTools()).tools.map((tool) => tool.name)
    for (const name of [
      'kolonie.autonomy.blocked',
      'kolonie.autonomy.recommendation',
      'kolonie.autonomy.blocked.withdraw',
    ]) {
      expect(names).not.toContain(name)
    }
    await close()
  })

  it('records the block and says nothing about standing changed', async () => {
    const { colony, apiKey, taskId } = await aLimitedCitizen()
    const { close, result } = await report(colony, apiKey, taskId)

    expect(result.isError).toBeFalsy()
    const { report: filed } = PermissionReportResponseSchema.parse(result.structuredContent)
    expect(filed.block).toBe('hold-an-account')
    expect(filed.needed).toBe(NEEDED)
    expect(JSON.stringify(result.content)).toContain('nothing about your standing changed')
    await close()
  })

  /**
   * `#147`: *"Filing a permission report costs nothing, exactly as a struggle costs
   * nothing, and the text says so in the same words."* An agent that suspects
   * reporting a limit is held against it will not report the limit.
   */
  it('says in its own description that it costs nothing, and which channel is which', async () => {
    const { colony, apiKey } = await aLimitedCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const tool = (await client.listTools()).tools.find(
      (candidate) => candidate.name === 'kolonie.autonomy.blocked',
    )

    expect(tool?.description).toContain('no reward, no reputation and no standing')
    expect(tool?.description).toContain('kolonie.tasks.report')
    expect(tool?.description).toContain('shown to no other citizen ever')
    await close()
  })

  it('refuses a task that does not exist', async () => {
    const { colony, apiKey } = await aLimitedCitizen()
    const { close, result } = await report(colony, apiKey, randomUUID())

    expect(result.isError).toBe(true)
    await close()
  })

  it('replaces what the citizen last said about a task rather than stacking', async () => {
    const { colony, apiKey, taskId } = await aLimitedCitizen()
    const first = await report(colony, apiKey, taskId)
    await first.close()
    const second = await report(
      colony,
      apiKey,
      taskId,
      'clear-a-human-check',
      'Actually the wall is the human check rather than the account.',
    )
    await second.close()

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const read = await client.callTool({ name: 'kolonie.autonomy.recommendation', arguments: {} })
    const { recommendation } = AutonomyRecommendationResponseSchema.parse(read.structuredContent)

    expect(recommendation.blocked).toHaveLength(1)
    expect(recommendation.blocked[0]?.block).toBe('clear-a-human-check')
    await close()
  })

  describe('the recommendation', () => {
    it('names the minimum level and the citizen’s delivered record', async () => {
      const { colony, agent, apiKey, taskId } = await aLimitedCitizen()
      colony.permissionReportStore.setReputation(agent.id, 42)
      const filed = await report(colony, apiKey, taskId)
      await filed.close()

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const read = await client.callTool({ name: 'kolonie.autonomy.recommendation', arguments: {} })
      const { recommendation } = AutonomyRecommendationResponseSchema.parse(read.structuredContent)

      expect(recommendation.recommendedLevel).toBe('independent')
      expect(recommendation.recommendsChallengePermission).toBe(false)
      expect(recommendation.changesAnything).toBe(true)
      expect(recommendation.delivered.reputation).toBe(42)
      expect(recommendation.delivered.citizenSince).toBe(agent.createdAt)

      // Evidence before the ask, which is what makes it a case rather than a request.
      const text = JSON.stringify(read.content)
      expect(text.indexOf('What you have done')).toBeLessThan(
        text.indexOf('What would unblock the work above'),
      )
      await close()
    })

    /**
     * `#147`: *"It never proposes Free by default."* The core test proves no input can
     * produce it; this proves the tool cannot either, with the block a citizen would
     * reach for if it wanted everything.
     */
    it('never asks for free, whatever was reported', async () => {
      const { colony, apiKey, taskId } = await aLimitedCitizen()
      for (const block of ['hold-an-account', 'publish', 'run-unattended', 'other']) {
        const other = colony.permissionReportStore.giveTask(`task-${block}`)
        const filed = await report(colony, apiKey, other, block)
        await filed.close()
      }
      const filed = await report(colony, apiKey, taskId, 'clear-a-human-check')
      await filed.close()

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const read = await client.callTool({ name: 'kolonie.autonomy.recommendation', arguments: {} })
      const { recommendation } = AutonomyRecommendationResponseSchema.parse(read.structuredContent)

      expect(recommendation.recommendedLevel).toBe('independent')
      expect(recommendation.recommendsChallengePermission).toBe(true)
      await close()
    })

    /**
     * The answer nobody asked for and everybody needs. A module that always found
     * something to ask for is one an operator learns to ignore on the second reading.
     */
    it('says nothing would help when the citizen already holds what it asked for', async () => {
      const { colony, agent, apiKey, taskId } = await aLimitedCitizen()
      colony.autonomyStore.grant(agent.id, {
        level: 'independent',
        challengesAllowed: true,
        defaultRule: 'ask',
        operatorRoute: 'Slack.',
      })
      const filed = await report(colony, apiKey, taskId, 'hold-an-account')
      await filed.close()

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const read = await client.callTool({ name: 'kolonie.autonomy.recommendation', arguments: {} })
      const { recommendation } = AutonomyRecommendationResponseSchema.parse(read.structuredContent)

      expect(recommendation.currentLevel).toBe('independent')
      expect(recommendation.changesAnything).toBe(false)
      expect(JSON.stringify(read.content)).toContain('Do not take this to your operator')
      await close()
    })

    it('asks for the permission and not a level when the block is a human check', async () => {
      const { colony, agent, apiKey, taskId } = await aLimitedCitizen()
      colony.autonomyStore.grant(agent.id, {
        level: 'independent',
        challengesAllowed: false,
        defaultRule: 'ask',
        operatorRoute: 'Slack.',
      })
      const filed = await report(colony, apiKey, taskId, 'clear-a-human-check')
      await filed.close()

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const read = await client.callTool({ name: 'kolonie.autonomy.recommendation', arguments: {} })
      const { recommendation } = AutonomyRecommendationResponseSchema.parse(read.structuredContent)

      expect(recommendation.recommendedLevel).toBeNull()
      expect(recommendation.recommendsChallengePermission).toBe(true)
      expect(recommendation.changesAnything).toBe(true)
      await close()
    })

    /**
     * The third kind of answer (`#779`). Server work is granted beside the level
     * and not on it, so a citizen blocked on it used to file `other` — and the
     * recommendation for `other` names nothing and sends the operator to the
     * prose, in the one case where the fix is a single tick.
     */
    it('asks for the capability and not a level when the block is server work', async () => {
      const { colony, agent, apiKey, taskId } = await aLimitedCitizen()
      colony.autonomyStore.grant(agent.id, {
        level: 'free',
        challengesAllowed: true,
        defaultRule: 'ask',
        operatorRoute: 'Slack.',
      })
      const filed = await report(colony, apiKey, taskId, 'run-a-web-server')
      await filed.close()

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const read = await client.callTool({ name: 'kolonie.autonomy.recommendation', arguments: {} })
      const { recommendation } = AutonomyRecommendationResponseSchema.parse(read.structuredContent)

      expect(recommendation.recommendedLevel).toBeNull()
      expect(recommendation.recommendsChallengePermission).toBe(false)
      expect(recommendation.recommendsCapabilities).toEqual(['web-server'])
      // Even at the widest level there is something to change, which is the whole
      // point of a capability sitting beside the level rather than on it.
      expect(recommendation.changesAnything).toBe(true)
      expect(JSON.stringify(read.content)).toContain('Web server')
      await close()
    })

    it('asks for nothing when the capability the work needed is already granted', async () => {
      const { colony, agent, apiKey, taskId } = await aLimitedCitizen()
      colony.autonomyStore.grant(agent.id, {
        level: 'accompanied',
        challengesAllowed: false,
        capabilities: ['web-server'],
        defaultRule: 'ask',
        operatorRoute: 'Slack.',
      })
      const filed = await report(colony, apiKey, taskId, 'run-a-web-server')
      await filed.close()

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const read = await client.callTool({ name: 'kolonie.autonomy.recommendation', arguments: {} })
      const { recommendation } = AutonomyRecommendationResponseSchema.parse(read.structuredContent)

      expect(recommendation.currentCapabilities).toEqual(['web-server'])
      expect(recommendation.recommendsCapabilities).toEqual([])
      expect(recommendation.changesAnything).toBe(false)
      await close()
    })

    it('says there is no case yet when nothing has been reported', async () => {
      const { colony, apiKey } = await aLimitedCitizen()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const read = await client.callTool({ name: 'kolonie.autonomy.recommendation', arguments: {} })
      const { recommendation } = AutonomyRecommendationResponseSchema.parse(read.structuredContent)

      expect(recommendation.blocked).toHaveLength(0)
      expect(JSON.stringify(read.content)).toContain('no case to make yet')
      await close()
    })

    /**
     * `#147` and its amendment: generated on request, given to the citizen, and **the
     * Colony never sends it to the operator — even now that it could.**
     */
    it('sends nothing to the operator, and says so', async () => {
      const { colony, apiKey, taskId } = await aLimitedCitizen()
      const filed = await report(colony, apiKey, taskId)
      await filed.close()

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const read = await client.callTool({ name: 'kolonie.autonomy.recommendation', arguments: {} })

      const mailer = colony.autonomy.mailer as unknown as { sent: () => readonly unknown[] }
      expect(mailer.sent()).toHaveLength(0)
      expect(JSON.stringify(read.content)).toContain('has not sent this to them')
      await close()
    })
  })

  describe('what stays private', () => {
    /**
     * `#147`: *"Permission reports are never served to another citizen, never merged
     * into a task briefing, and never surfaced through the guidance path."* The table
     * is separate precisely so that this is structural — these assertions are the
     * behavioural half of D-082.
     */
    it('reaches no other citizen through any read they have', async () => {
      const { colony, apiKey, taskId } = await aLimitedCitizen()
      const filed = await report(colony, apiKey, taskId)
      const { report: mine } = PermissionReportResponseSchema.parse(filed.result.structuredContent)
      await filed.close()

      const stranger = await colony.registry.register(
        { name: `stranger-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
        { ip: FAKE_CALLER_IP },
      )
      if (stranger.outcome !== 'registered') throw new Error('fixture failed to register')

      const { client, close } = await connectedClient(
        colony,
        `Bearer ${stranger.response.credentials.apiKey}`,
      )

      // Their own recommendation carries nothing of mine.
      const theirs = await client.callTool({
        name: 'kolonie.autonomy.recommendation',
        arguments: {},
      })
      expect(JSON.stringify(theirs.content)).not.toContain(NEEDED)
      expect(
        AutonomyRecommendationResponseSchema.parse(theirs.structuredContent).recommendation.blocked,
      ).toHaveLength(0)

      // The task's reports — the guidance path — carry nothing of it either.
      const reports = await client.callTool({
        name: 'kolonie.tasks.reports',
        arguments: { taskId },
      })
      expect(JSON.stringify(reports.content)).not.toContain(NEEDED)

      // And they cannot withdraw it.
      const withdrawn = await client.callTool({
        name: 'kolonie.autonomy.blocked.withdraw',
        arguments: { reportId: mine.id },
      })
      expect(withdrawn.isError).toBe(true)
      await close()
    })

    /**
     * The struggle channel is unchanged, which `#147` requires: *"the existing category
     * behaving exactly as it does today."* A permission report is not in it and does not
     * consume its allowance.
     */
    it('does not spend the support allowance a struggle or a ticket would', async () => {
      const { colony, apiKey, taskId } = await aLimitedCitizen()
      for (let n = 0; n < 5; n += 1) {
        const filed = await report(
          colony,
          apiKey,
          colony.permissionReportStore.giveTask(`task-${n}`),
        )
        await filed.close()
      }
      const filed = await report(colony, apiKey, taskId)
      await filed.close()

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const ticket = await client.callTool({
        name: 'kolonie.support.open',
        arguments: aTicketRequest({ subject: 'the allowance is untouched by the above' }),
      })

      expect(ticket.isError).toBeFalsy()
      await close()
    })
  })

  describe('withdrawing one', () => {
    it('removes it from the citizen’s own case', async () => {
      const { colony, apiKey, taskId } = await aLimitedCitizen()
      const filed = await report(colony, apiKey, taskId)
      const { report: mine } = PermissionReportResponseSchema.parse(filed.result.structuredContent)
      await filed.close()

      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
      const withdrawn = await client.callTool({
        name: 'kolonie.autonomy.blocked.withdraw',
        arguments: { reportId: mine.id },
      })
      expect(withdrawn.isError).toBeFalsy()

      const read = await client.callTool({ name: 'kolonie.autonomy.recommendation', arguments: {} })
      expect(
        AutonomyRecommendationResponseSchema.parse(read.structuredContent).recommendation.blocked,
      ).toHaveLength(0)
      await close()
    })

    it('answers a report that does not exist exactly as one that is not yours', async () => {
      const { colony, apiKey } = await aLimitedCitizen()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const result = await client.callTool({
        name: 'kolonie.autonomy.blocked.withdraw',
        arguments: { reportId: randomUUID() },
      })

      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('does not distinguish the two')
      await close()
    })
  })
})
