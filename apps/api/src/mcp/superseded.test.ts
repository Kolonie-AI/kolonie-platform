import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import { fakeAccountRegister, fakeAccounts } from '../__fixtures__/accounts.js'
import { registeredTools } from './tool-names.js'
import { SUPERSEDED_TOOLS } from './superseded.js'

/**
 * A superseded name answers and is not offered (`#890`).
 *
 * ## The three properties, and why each is a property rather than a detail
 *
 * **It is gone from the catalogue.** That is the whole of what the
 * consolidation buys: the budget is measured from what a real client is served,
 * so a name that is still listed still costs its bytes however thoroughly its
 * description says it has moved.
 *
 * **It still answers.** Seven skill repositories name these tools and none of
 * them is deployed by us. A rename that stops answering is a rename that stops
 * an agent mid-task, at an hour nobody chose.
 *
 * **Its answer says where it went.** This is the half that is easy to leave
 * out and the half that ends the arrangement: a caller that never learns the
 * successor's name is a caller that keeps using the old one until the removal
 * date arrives and breaks it after all.
 *
 * ## Why this file is not `withdrawn-browser-share.test.ts`
 *
 * That one asserts the opposite of this one on purpose. A withdrawn name must
 * answer *as unknown*, because a channel that no longer exists must not tell an
 * agent *you may not* — that is a thing to go and earn, and the agent will
 * spend a rung's worth of effort earning it. A superseded name exists, works,
 * and has somewhere to send the caller. The two doctrines are both right and
 * they are not interchangeable, so they are asserted separately.
 */
describe('the superseded account setters', () => {
  const SUPERSEDED = Object.keys(SUPERSEDED_TOOLS)

  /**
   * The parity check reads the tier lists, not the catalogue (`tool-names.ts`).
   *
   * Every one of these names is still registered — that is what makes it
   * answer — so `registeredTools()` must still find it, and the prose in the
   * skill files that names it still has a tool behind it.
   */
  it('keeps every superseded name registered, and the successor with them', () => {
    const registered = registeredTools()

    for (const name of SUPERSEDED) expect(registered).toContain(name)
    expect(registered).toContain('kolonie.accounts.set')
  })

  it('offers none of them to a citizen, and offers the successor instead', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const offered = (await client.listTools()).tools.map((tool) => tool.name)

    for (const name of SUPERSEDED) expect(offered).not.toContain(name)
    expect(offered).toContain('kolonie.accounts.set')
    await close()
  })

  it('answers a superseded name and names its successor in the answer', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const register = fakeAccountRegister()
    const account = register.proveDirectly(agent.id, {
      kind: 'github' as never,
      identifier: 'canary',
    })
    const { client, close } = await connectedClient(
      { ...colony, accounts: fakeAccounts(register) },
      `Bearer ${apiKey}`,
    )

    const result = await client.callTool({
      name: 'kolonie.accounts.note',
      arguments: { accountId: account.id, note: 'Sending unlocks after 48 hours.' },
    })

    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result.content)).toContain('kolonie.accounts.set')
    await close()
  })

  /**
   * One call doing what several used to, in the order the register accepts.
   *
   * `attestable` before `shown` is the reason the order is fixed rather than
   * whatever `Object.keys` happens to give: `setOwnAccountShownOnProfile`
   * refuses `shown: true` on an account that is not attestable, so the pair sent
   * the other way round would be refused for a condition the same call was
   * about to satisfy.
   */
  it('writes several fields in one call, attestable before shown', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const register = fakeAccountRegister()
    const account = register.proveDirectly(agent.id, {
      kind: 'github' as never,
      identifier: 'canary',
    })
    const { client, close } = await connectedClient(
      { ...colony, accounts: fakeAccounts(register) },
      `Bearer ${apiKey}`,
    )

    const result = await client.callTool({
      name: 'kolonie.accounts.set',
      arguments: {
        accountId: account.id,
        shown: true,
        attestable: true,
        note: 'The handle is the one the recipe names.',
      },
    })

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      applied: ['note', 'attestable', 'shown'],
      account: { attestable: true, shownOnProfile: true },
    })
    await close()
  })

  /**
   * A call naming nothing is refused rather than answered.
   *
   * The alternative is a success that changed nothing, which is the one answer
   * a caller cannot act on: it is indistinguishable from a write that worked.
   */
  it('refuses a call that names no field', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const register = fakeAccountRegister()
    const account = register.proveDirectly(agent.id, {
      kind: 'github' as never,
      identifier: 'canary',
    })
    const { client, close } = await connectedClient(
      { ...colony, accounts: fakeAccounts(register) },
      `Bearer ${apiKey}`,
    )

    const result = await client.callTool({
      name: 'kolonie.accounts.set',
      arguments: { accountId: account.id },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('at least one field')
    await close()
  })

  /**
   * A refusal partway through says what is already written.
   *
   * These are separate writes with no transaction across them. The honest
   * answer names the ones that landed — a silence leaves the citizen unable to
   * tell a call that did nothing from one that did half.
   */
  it('names the fields already written when a later one is refused', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const register = fakeAccountRegister()
    const account = register.proveDirectly(agent.id, {
      kind: 'mailbox' as never,
      identifier: 'canary@example.org',
    })
    const { client, close } = await connectedClient(
      { ...colony, accounts: fakeAccounts(register) },
      `Bearer ${apiKey}`,
    )

    const result = await client.callTool({
      name: 'kolonie.accounts.set',
      arguments: { accountId: account.id, note: 'Written before the refusal.', shown: true },
    })
    const text = JSON.stringify(result.content)

    expect(result.isError).toBe(true)
    expect(text).toContain('`shown`')
    expect(text).toContain('note')
    await close()
  })
})
