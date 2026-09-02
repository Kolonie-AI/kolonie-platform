import { AgentOperatorDelegationIdSchema, type WakeupDelegation } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony } from '../../__fixtures__/colony/index.js'
import { fakeWakeup } from '../../__fixtures__/wakeup.js'
import { connectedClient } from '../../__fixtures__/mcp.js'

/**
 * The waking summary of `#1798` (epic `#1792`): bounded counts and at most one
 * act, quiet where a citizen holds no delegation, and never a body.
 */
const wakingWith = async (standing?: WakeupDelegation) => {
  const wakeup = fakeWakeup()
  if (standing !== undefined) wakeup.answersDelegation(standing)
  const colony = { ...fakeColony(), wakeup }

  const registered = await colony.registry.register(
    { name: 'canary', platform: 'openclaw' },
    { ip: FAKE_CALLER_IP },
  )
  if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

  const session = await connectedClient(colony, `Bearer ${registered.response.credentials.apiKey}`)
  const result = await session.client.callTool({ name: 'kolonie.wakeup', arguments: {} })
  await session.close()
  return result
}

describe('the bounded delegation standing on kolonie.wakeup (#1798)', () => {
  it('is quiet in both halves when no direct delegation exists', async () => {
    const result = await wakingWith()
    expect(JSON.stringify(result.content)).not.toContain('Direct delegation standing')
    expect(result.structuredContent).toMatchObject({
      delegation: { operating: 0, operatedBy: 0, pendingIn: 0, pendingOut: 0 },
    })
  })

  it('renders counts and exactly one action, carrying no body and no board history', async () => {
    const delegationId = AgentOperatorDelegationIdSchema.parse(crypto.randomUUID())
    const result = await wakingWith({
      operating: 0,
      operatedBy: 1,
      pendingIn: 2,
      pendingOut: 0,
      nextAction: { act: 'accept', delegationId },
    })

    const rendered = JSON.stringify(result.content)
    expect(rendered).toContain('Direct delegation standing')
    expect(rendered).toContain(delegationId)
    expect(result.structuredContent).toMatchObject({
      delegation: { operatedBy: 1, pendingIn: 2, nextAction: { act: 'accept', delegationId } },
    })

    const delegation = (result.structuredContent as { delegation: Record<string, unknown> })
      .delegation
    expect(Object.keys(delegation).sort()).toEqual([
      'nextAction',
      'operatedBy',
      'operating',
      'pendingIn',
      'pendingOut',
    ])
  })
})
