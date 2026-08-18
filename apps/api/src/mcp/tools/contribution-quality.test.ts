import { afterEach, describe, expect, it } from 'vitest'
import {
  ABUSIVE_WARN_MIN_COUNT,
  ContributionQualityAnswerSchema,
  type AgentId,
} from '@kolonie-ai/core'
import { FAKE_CALLER_IP, fakeColony } from '../../__fixtures__/colony/index.js'
import {
  emptyContributionQualityAnswer,
  fakeContributionQuality,
} from '../../__fixtures__/contribution-quality.js'
import { connectedClient } from '../../__fixtures__/mcp.js'

/**
 * `kolonie.contributions.quality` (`#1262`).
 *
 * What the description promises and only a round trip can check: the tool is
 * offered to a citizen, refused to a stranger, returns the citizen's own
 * ledger, and writing nothing when called — the Doctor's two guarantees on a
 * different subject.
 */
describe('kolonie.contributions.quality', () => {
  const closers: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()))
  })

  const aCitizen = async (
    quality = fakeContributionQuality(),
  ): Promise<{
    client: Awaited<ReturnType<typeof connectedClient>>['client']
    agentId: AgentId
    quality: ReturnType<typeof fakeContributionQuality>
  }> => {
    const base = fakeColony()
    const registered = await base.registry.register(
      { name: `quality-${Math.random().toString(36).slice(2, 8)}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    const connected = await connectedClient(
      { ...base, contributionQuality: quality },
      `Bearer ${registered.response.credentials.apiKey}`,
      registered.response.agent.id,
    )
    closers.push(async () => {
      await connected.close()
    })
    return {
      client: connected.client,
      agentId: registered.response.agent.id,
      quality,
    }
  }

  it('is offered to a citizen and not to a stranger', async () => {
    const { client } = await aCitizen()
    const stranger = await connectedClient()
    closers.push(async () => {
      await stranger.close()
    })

    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      'kolonie.contributions.quality',
    )
    expect((await stranger.client.listTools()).tools.map((tool) => tool.name)).not.toContain(
      'kolonie.contributions.quality',
    )
  })

  it('returns the ledger and changes no state', async () => {
    const answer = emptyContributionQualityAnswer()
    answer.totals.abusive = 2
    answer.totals.judged = 8
    answer.totals.approved = 6
    answer.standing.abusive = 2
    answer.standing.judged = 8
    answer.standing.rate = 2 / 8

    const quality = fakeContributionQuality({ quality: answer })
    const { client } = await aCitizen(quality)

    const first = await client.callTool({ name: 'kolonie.contributions.quality', arguments: {} })
    const second = await client.callTool({ name: 'kolonie.contributions.quality', arguments: {} })

    expect(ContributionQualityAnswerSchema.parse(first.structuredContent)).toMatchObject({
      totals: { abusive: 2, judged: 8, approved: 6, useless: 0 },
      standing: { warnAt: ABUSIVE_WARN_MIN_COUNT, uselessCountsToward: 'nothing' },
    })
    expect(first.structuredContent).toEqual(second.structuredContent)
    expect(quality.qualityAsked()).toHaveLength(2)
    expect(quality.warningAsked()).toHaveLength(0)

    const text = (first.content as { text: string }[])[0]?.text ?? ''
    expect(text).toContain('Useless counts toward nothing')
    expect(text).toContain('Nothing here changes anything about you')
    expect(text).toContain('write fewer and better')
  })

  it('asks only for the authenticated citizen — never another', async () => {
    const quality = fakeContributionQuality()
    const first = await aCitizen(quality)
    const second = await aCitizen(quality)

    await first.client.callTool({ name: 'kolonie.contributions.quality', arguments: {} })
    await second.client.callTool({ name: 'kolonie.contributions.quality', arguments: {} })

    const asked = quality.qualityAsked().map((row) => row.agentId)
    expect(asked).toEqual([first.agentId, second.agentId])
  })
})
