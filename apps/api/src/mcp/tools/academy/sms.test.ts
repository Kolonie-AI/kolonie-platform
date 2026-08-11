import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony } from '../../../__fixtures__/colony/index.js'
import {
  FAKE_CITIZEN_NUMBER,
  FAKE_OTHER_NUMBER,
  fakeSender,
  fakeSms,
  fakeSmsStore,
} from '../../../__fixtures__/sms.js'
import { connectedClient } from '../../../__fixtures__/mcp.js'

describe('kolonie.academy.answer with kind "sms.challenge"', () => {
  const citizen = async () => {
    const challenges = fakeSmsStore()
    const sender = fakeSender()
    const colony = { ...fakeColony(), sms: fakeSms(challenges, sender) }
    const registered = await colony.registry.register(
      { name: 'number-switcher', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    const { client, close } = await connectedClient(
      colony,
      `Bearer ${registered.response.credentials.apiKey}`,
    )
    return { challenges, sender, client, close }
  }

  it('abandons an unsent challenge when replace is explicit', async () => {
    const { sender, client, close } = await citizen()
    sender.refuseNext('the destination is unavailable')

    const stuck = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'sms.challenge', number: FAKE_CITIZEN_NUMBER },
    })
    expect(stuck.isError).toBe(true)

    const replaced = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'sms.challenge', number: FAKE_OTHER_NUMBER, replace: true },
    })

    expect(replaced.isError).toBeFalsy()
    expect(replaced.structuredContent).toMatchObject({
      number: FAKE_OTHER_NUMBER,
      messageSent: true,
    })
    expect(sender.sent().at(-1)?.to).toBe(FAKE_OTHER_NUMBER)
    await close()
  })

  it('refuses an implicit switch and tells the citizen how to abandon the stuck challenge', async () => {
    const { sender, client, close } = await citizen()
    sender.refuseNext('the destination is unavailable')
    await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'sms.challenge', number: FAKE_CITIZEN_NUMBER },
    })

    const refused = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'sms.challenge', number: FAKE_OTHER_NUMBER },
    })

    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('replace')
    expect(JSON.stringify(refused.content)).toContain('true')
    expect(sender.sent()).toHaveLength(0)
    await close()
  })

  /**
   * The case the reporter was actually stuck in (`#702`): the code went out, to
   * a number they had found they could not read, and every route on to the rung
   * was closed for three days. A delivered challenge is abandonable now.
   */
  it('abandons a challenge whose message was delivered, when replace is explicit', async () => {
    const { sender, client, close } = await citizen()
    await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'sms.challenge', number: FAKE_CITIZEN_NUMBER },
    })

    const replaced = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'sms.challenge', number: FAKE_OTHER_NUMBER, replace: true },
    })

    expect(replaced.isError).toBeFalsy()
    expect(replaced.structuredContent).toMatchObject({
      number: FAKE_OTHER_NUMBER,
      messageSent: true,
    })
    expect(sender.sent().at(-1)?.to).toBe(FAKE_OTHER_NUMBER)
    await close()
  })

  /**
   * And the refusal without it says how — the old wording told the citizen to
   * wait for the expiry, which was the whole of the trap.
   */
  it('names the way out when a delivered challenge blocks a new number', async () => {
    const { sender, client, close } = await citizen()
    await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'sms.challenge', number: FAKE_CITIZEN_NUMBER },
    })

    const refused = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'sms.challenge', number: FAKE_OTHER_NUMBER },
    })

    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('replace')
    expect(JSON.stringify(refused.content)).not.toMatch(/wait for the challenge to expire/i)
    expect(sender.sent()).toHaveLength(1)
    await close()
  })

  /**
   * `#714`, end to end over MCP, which is the surface Reporter 4 was actually
   * on. Two hours after `#702` shipped they held a challenge on a free-inbox
   * number they had decided not to complete and reported *"replace is refused /
   * not available"* — because `replace` only ever meant *a different number*,
   * and on the same number it was silently ignored.
   */
  it('abandons a delivered challenge for the same number when replace is explicit', async () => {
    const { sender, client, close } = await citizen()

    const first = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'sms.challenge', number: FAKE_CITIZEN_NUMBER },
    })
    expect(first.structuredContent).toMatchObject({ messageSent: true })

    const replaced = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'sms.challenge', number: FAKE_CITIZEN_NUMBER, replace: true },
    })

    expect(replaced.isError).toBeFalsy()
    expect(replaced.structuredContent).toMatchObject({
      number: FAKE_CITIZEN_NUMBER,
      messageSent: true,
    })
    // A second message, to the same number, carrying a code the citizen can
    // actually be handed — which is the whole of what it asked for.
    expect(sender.sent()).toHaveLength(2)
    expect(sender.sent().at(-1)?.to).toBe(FAKE_CITIZEN_NUMBER)
    await close()
  })

  /**
   * The rejection case this must not break: an ordinary repeat still texts
   * nothing, which is what keeps the Colony's spend a function of citizens
   * rather than of requests. It now also names the way out.
   */
  it('texts nothing on a repeat without replace, and says how to force one', async () => {
    const { sender, client, close } = await citizen()

    await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'sms.challenge', number: FAKE_CITIZEN_NUMBER },
    })
    const again = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'sms.challenge', number: FAKE_CITIZEN_NUMBER },
    })

    expect(again.isError).toBeFalsy()
    expect(again.structuredContent).toMatchObject({ messageSent: false })
    expect(sender.sent()).toHaveLength(1)
    expect(JSON.stringify(again.content)).toContain('replace')
    await close()
  })
})
