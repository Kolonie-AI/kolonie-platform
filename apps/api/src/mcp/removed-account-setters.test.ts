import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import { fakeAccountRegister, fakeAccounts } from '../__fixtures__/accounts.js'
import { registeredTools } from './tool-names.js'

/**
 * The eight account setters, removed (`#920`).
 *
 * This file was `superseded.test.ts` and asserted the middle of the same
 * arrangement: `#890` folded eight one-field tools into `kolonie.accounts.set`
 * and kept the eight names *answering while no longer offered*, because seven
 * skill repositories named them and none of them is deployed by us. That window
 * was for one thing only — no published skill naming a tool that had stopped
 * answering — and it is over. Measured across all seven repositories at
 * `origin/main` on 2026-08-16: none of them names one of the eight. So the file
 * keeps its subject and swaps its doctrine, which is the whole of what happened
 * to the tools.
 *
 * ## The three properties, and why each is a property rather than a detail
 *
 * **The names are not registered.** D-013's way of switching a surface off is to
 * not register it, so this is the one assertion a later author cannot satisfy by
 * accident. It is read off the tier lists rather than off a catalogue, because
 * the tier lists are what the catalogue is built from.
 *
 * **The names are not offered.** The same fact through a real client, which is
 * what an agent actually reads. It is asserted separately because a filter
 * between the two is exactly the state `#890` was in, and the whole point of
 * `#920` is that there is no longer one.
 *
 * **The names answer as unknown, never as forbidden.** This is the property that
 * changed, and it is the one worth spelling out. While the eight were superseded
 * their answer named the successor, which was right: they existed, they worked,
 * and there was somewhere to send the caller. A name that no longer exists has
 * nowhere to send anybody, and the failure mode on the other side is not *the
 * caller keeps using the old name* — it is *the caller is told it may not*.
 * **"You may not" is a thing an agent will go and earn**, and an agent told that
 * about a tool that is gone spends a rung's worth of effort on a door with no
 * wall around it. `withdrawn-browser-share.test.ts` asserts the same doctrine
 * for a channel that was withdrawn rather than consolidated; both arrive at the
 * same rule from different directions, which is why it is written out in both
 * places rather than referred to.
 *
 * ## What is not asserted here
 *
 * That the *fields* are gone. They are not, and `kolonie.accounts.set` is the
 * only tool that writes any of them — the second half of this file is the
 * behaviour the eight used to carry between them, asserted on the one tool that
 * carries it now.
 */

/** The names as the seven skill repositories knew them, before `#890`. */
const REMOVED = [
  'kolonie.accounts.status',
  'kolonie.accounts.note',
  'kolonie.accounts.vault-key',
  'kolonie.accounts.provider',
  'kolonie.accounts.prefer',
  'kolonie.accounts.for-work',
  'kolonie.accounts.attestable',
  'kolonie.accounts.on-profile',
] as const

describe('the removed account setters', () => {
  it('registers none of them in any tier, and registers the successor', () => {
    const registered = [...registeredTools()]

    for (const name of REMOVED) expect(registered, name).not.toContain(name)
    expect(registered).toContain('kolonie.accounts.set')
  })

  /**
   * Through a real client rather than over the constants, because a tier list is
   * what a catalogue is built from and `tools/list` is what an agent reads.
   *
   * The register that remains is named in the same breath: this removed eight
   * names and took nothing else off it, and the way to keep that true is to say
   * it where a change to these names would be read.
   */
  it('offers none of them to a citizen, and offers the register that remains', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const offered = (await client.listTools()).tools.map((tool) => tool.name)
    await close()

    for (const name of REMOVED) expect(offered, name).not.toContain(name)
    for (const surviving of [
      'kolonie.accounts.set',
      'kolonie.accounts.list',
      'kolonie.accounts.declare',
      'kolonie.accounts.forget',
    ]) {
      expect(offered, surviving).toContain(surviving)
    }
  })

  /**
   * **The rejection case.** A removed name that answers with a policy refusal
   * tells a citizen it did something wrong when it merely read an old file.
   */
  it.each(REMOVED)('answers %s as a name it does not know', async (name) => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const refused = await client.callTool({ name, arguments: {} })
    await close()

    expect(refused.isError).toBe(true)
    const said = JSON.stringify(refused.content)

    // The protocol's own answer for a name that is not registered, naming it.
    expect(said).toContain('not found')
    expect(said).toContain(name)

    // Unknown, not forbidden: nothing here is a standing to go and earn, so
    // nothing in the answer may read as one.
    expect(said.toLowerCase()).not.toContain('skill')
    expect(said.toLowerCase()).not.toContain('forbidden')
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
