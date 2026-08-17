import { PLAYBOOK_SEEDS } from '@kolonie-ai/db'
import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

/**
 * The starting catalogue, read through the tools a citizen actually calls
 * (`#1175`).
 *
 * **The seeds are the fixture.** That they store and come back unchanged is
 * asserted in `packages/db/src/playbook-seeds.test.ts` against a real PostgreSQL;
 * what is asserted here is the half that lives on this side of the boundary — a
 * citizen holding nothing calls `kolonie.playbooks.list` and is shown all five,
 * with the gate visible and none of them hidden behind it.
 *
 * It is a separate file from `playbooks.test.ts` because that one is about the
 * three tools and constructs whatever playbook each case needs. This one is
 * about the five rows the Colony ships, and it fails when a seed changes shape —
 * which is the notice worth having, since nobody edits a seed while thinking
 * about the read surface.
 */
const list = { name: 'kolonie.playbooks.list', arguments: {} }

const aCitizen = async () => {
  const { colony, agent, apiKey } = await registeredCitizen()
  return { colony, agent, ...(await connectedClient(colony, `Bearer ${apiKey}`)) }
}

describe('the playbooks the Colony ships with, on the shelf (#1175)', () => {
  it('shows every seed to a citizen holding nothing', async () => {
    const { colony, client, close } = await aCitizen()
    for (const seed of PLAYBOOK_SEEDS) {
      colony.playbooks.playbook({
        slug: seed.slug,
        status: 'open',
        title: seed.draft.title,
        summary: seed.draft.summary,
        requiredAccounts: [...seed.draft.requiredAccounts],
        steps: [...seed.draft.steps],
      })
    }

    const read = await client.callTool(list)

    expect(read.isError).toBeFalsy()
    const shown = (read.structuredContent as { playbooks: { slug: string; canExecute: boolean }[] })
      .playbooks
    expect(shown.map((one) => one.slug).sort()).toEqual(PLAYBOOK_SEEDS.map((s) => s.slug).sort())
    /**
     * Freeze C, on the entries a citizen meets first: every one of them is
     * unrunnable for want of an account, and every one of them is listed anyway.
     */
    expect(shown.every((one) => one.canExecute === false)).toBe(true)
    await close()
  })

  it('names, for each seed, an account slot and the steps behind the gate', async () => {
    const { colony, client, close } = await aCitizen()
    const seed = PLAYBOOK_SEEDS[0]!
    colony.playbooks.playbook({
      slug: seed.slug,
      status: 'open',
      title: seed.draft.title,
      summary: seed.draft.summary,
      requiredAccounts: [...seed.draft.requiredAccounts],
      steps: [...seed.draft.steps],
    })

    const read = await client.callTool({
      name: 'kolonie.playbooks.get',
      arguments: { playbook: seed.slug },
    })

    const text = JSON.stringify(read.content)
    for (const step of seed.draft.steps) expect(text).toContain(step.title)
    // Every missing slot carries the sentence `#1181` put on it.
    const match = (read.structuredContent as { match: { missing: { hint: string }[] } }).match
    expect(match.missing.length).toBeGreaterThanOrEqual(1)
    for (const slot of match.missing) expect(slot.hint.length).toBeGreaterThan(0)
    await close()
  })
})
