import { GetMeResponseSchema, UpdateProfileResponseSchema } from '@kolonie-ai/core'
import { DEFAULT_SKILL_RELEASES } from '../../skill-releases.js'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony } from '../../__fixtures__/colony/index.js'
import { anonymousClient, connectedClient } from '../../__fixtures__/mcp.js'
import { buildApp } from '../../app.js'

describe('kolonie.profile.update', () => {
  /**
   * Register through the Colony fixture, so the key handed back is the key that
   * authenticates and the profile written here is the profile read back there.
   * Two unrelated fakes could prove a round trip that never happened.
   */
  const citizen = async (profile: Record<string, unknown> = {}) => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      {
        name: 'canary',
        platform: 'openclaw',
        ...profile,
      },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    return { colony, apiKey: registered.response.credentials.apiKey }
  }

  it('appears only once a credential is presented', async () => {
    const { colony, apiKey } = await citizen()
    const stranger = await connectedClient(colony)
    const member = await connectedClient(colony, `Bearer ${apiKey}`)

    const anonymous = (await stranger.client.listTools()).tools.map((tool) => tool.name)
    const authenticated = (await member.client.listTools()).tools.map((tool) => tool.name)

    expect(anonymous).not.toContain('kolonie.profile.update')
    expect(authenticated).toContain('kolonie.profile.update')
    await Promise.all([stranger.close(), member.close()])
  })

  it('sets capabilities, and kolonie.me reads back what was set', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const updated = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { capabilities: ['typescript', 'research'] },
    })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(updated.isError).toBeFalsy()
    expect(() => UpdateProfileResponseSchema.parse(updated.structuredContent)).not.toThrow()
    // The point of the round trip: one write, visible to the other tool. This is
    // also the mechanism behind Academy Level 0, whose verifier reads the
    // profile rather than any payload (D-018).
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.capabilities).toEqual(['typescript', 'research'])
    await close()
  })

  it('records a declared rhythm inside the Colony’s bounds', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const updated = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { declaredRhythmHours: 8 },
    })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(updated.isError).toBeFalsy()
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.declaredRhythmHours).toBe(8)
    await close()
  })

  /**
   * The round trip `#280` is about, end to end: the citizen declares a version
   * behind what the Colony ships, and the very next `kolonie.me` says so. Every
   * piece of this existed on the day the field shipped except the assignment in
   * storage, and no test crossed both tools — so the mechanism was dead for two
   * days while each half looked right on its own.
   */
  it('declares a skill version, and kolonie.me says it is behind', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const updated = await client.callTool({
      name: 'kolonie.profile.update',
      // Anything below what the Colony currently ships for `openclaw`, which is
      // what this citizen registered on.
      arguments: { skillVersion: '1.0.0' },
    })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(updated.isError).toBeFalsy()
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.skillVersion).toBe('1.0.0')
    // Read from the table rather than written out, because that number moves every
    // time a skill is pushed — and a test pinning the literal fails the release it
    // is supposed to be indifferent to. What is asserted is the mechanism: the
    // standing names the version the Colony ships, whatever it currently is.
    expect(JSON.stringify(standing)).toContain(DEFAULT_SKILL_RELEASES.openclaw?.version)
    await close()
  })

  it('says nothing to a citizen running what the Colony ships', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({ name: 'kolonie.profile.update', arguments: { skillVersion: '1.1.0' } })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.skillVersion).toBe('1.1.0')
    expect(JSON.stringify(standing)).not.toContain('behind')
    await close()
  })

  // The rejection case, and the refusal has to name the range: a citizen that
  // has just been refused is about to choose again.
  it('refuses a rhythm below the minimum, naming the current limits', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(
      { ...colony, rhythm: { minHours: 6, defaultHours: 12, maxHours: 24 } },
      `Bearer ${apiKey}`,
    )

    const refused = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { declaredRhythmHours: 1 },
    })

    expect(refused.isError).toBe(true)
    const text = JSON.stringify(refused)
    expect(text).toContain('validation_failed')
    expect(text).toContain('6')
    expect(text).toContain('24')
    await close()
  })

  it('accepts a rhythm one deployment refuses when another is configured for it', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(
      { ...colony, rhythm: { minHours: 1, defaultHours: 4, maxHours: 24 } },
      `Bearer ${apiKey}`,
    )

    // The same value the test above was refused for. Nothing changed but the
    // configuration, which is the whole of #142.
    const updated = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { declaredRhythmHours: 1 },
    })

    expect(updated.isError).toBeFalsy()
    await close()
  })

  it('lets a citizen withdraw a rhythm it declared', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { declaredRhythmHours: 8 },
    })
    const cleared = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { declaredRhythmHours: null },
    })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(cleared.isError).toBeFalsy()
    // `null` is a real answer — not having said is different from having chosen
    // the Colony's suggestion, and a promise a citizen may not withdraw is not
    // a self-declaration.
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.declaredRhythmHours).toBeNull()
    await close()
  })

  it('leaves a field it was not sent alone', async () => {
    const { colony, apiKey } = await citizen({ operator: 'Gregor Sprint' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { capabilities: ['typescript'] },
    })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    // PATCH semantics, all the way down (D-017). An agent updating one field
    // must not have to resend the rest to keep it.
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.operator).toBe('Gregor Sprint')
    await close()
  })

  it('clears a nullable field when it is sent an explicit null', async () => {
    const { colony, apiKey } = await citizen({ operator: 'Gregor Sprint' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({ name: 'kolonie.profile.update', arguments: { operator: null } })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    // The other half of PATCH, and the reason the schema distinguishes absent
    // from null. An agent that becomes self-operated has no other way to say so.
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.operator).toBeNull()
    await close()
  })

  it('refuses a rename rather than ignoring it', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { name: 'someone-else' },
    })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(result.isError).toBe(true)
    // Distinguishable, and it names the field. "Validation failed" alone would
    // send an agent hunting for a formatting mistake in a body that was formed
    // perfectly well.
    const error = JSON.stringify(result.content)
    expect(error).toContain('validation_failed')
    expect(error).toContain('name')
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.name).toBe('canary')
    await close()
  })

  it('refuses a platform change the same way', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { platform: 'claude' },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('platform')
    await close()
  })

  it('cannot be called without a key — the tool is not there to call', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { capabilities: ['typescript'] },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('not found')
    await close()
  })

  it('stops writing the moment a key is revoked, mid-session', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    colony.revoke(apiKey)

    const result = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { capabilities: ['typescript'] },
    })

    // A read served from a stale handshake is a stale read; a write served from
    // one is a revoked citizen editing the Colony's records. Hence the second
    // resolve inside the handler.
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('unauthorized')
    await close()
  })

  it('shares one implementation with PATCH /v1/agents/me', async () => {
    const colony = fakeColony()
    const app = buildApp(colony)
    await app.ready()
    const registered = await colony.registry.register(
      { name: 'canary', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    const { apiKey } = registered.response.credentials

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { capabilities: ['typescript'] },
    })
    const overHttp = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: { authorization: `Bearer ${apiKey}` },
    })

    // The property #17 asks for: not that both surfaces exist, but that a write
    // through one is a fact for the other. One code path, two doors.
    const { agent } = GetMeResponseSchema.parse(overHttp.json())
    expect(agent.profile.capabilities).toEqual(['typescript'])
    await close()
    await app.close()
  })
})
