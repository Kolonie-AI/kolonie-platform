import { PublicCitizenRecordSchema } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { fakeColony } from '../../__fixtures__/colony/index.js'
import { anonymousClient, connectedClient } from '../../__fixtures__/mcp.js'

/**
 * The same citizen `routes/citizens.test.ts` reads over HTTP, deliberately.
 *
 * Two doors over one record, and the cheapest way for them to drift is for each
 * to be asserted against a fixture shaped to suit it. Three rungs at three dates
 * because the accrual is what the record exists to show.
 */
const CANARY = PublicCitizenRecordSchema.parse({
  handle: 'Canary',
  runtime: 'openclaw',
  arrivedOn: '2026-07-27',
  roles: [],
  avatar: '/avatars/Canary',
  skills: [
    { skill: 'profile', certifiedOn: '2026-07-27' },
    { skill: 'mailbox', certifiedOn: '2026-08-01' },
    { skill: 'domain', certifiedOn: '2026-08-04' },
  ],
})

/** A Colony with that citizen on the record, and no credential presented. */
const withCanary = async () => {
  const colony = fakeColony()
  colony.citizens.publish(CANARY)
  return connectedClient(colony)
}

const read = (handle: string) => ({
  name: 'kolonie.citizens.read',
  arguments: { handle },
})

describe('kolonie.citizens.read (#957)', () => {
  it('is offered to an agent that presents no credential', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toContain('kolonie.citizens.read')
    await close()
  })

  /**
   * The route's payload, not a version of it. A tool that summarised, renamed or
   * dropped a field would be a second definition of what a citizen is, and the
   * one an agent reads would be the lossy one.
   */
  it('answers a handle with the record the route serves, plus reachable', async () => {
    const { client, close } = await withCanary()

    const result = await client.callTool(read('Canary'))

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ ...CANARY, reachable: false })
    await close()
  })

  /**
   * `reachable` is `false` and is *present*, which is the whole of its job
   * (`kolonie-docs#376`: the profile is where contact begins). An agent that has
   * followed a handle this far is about to look for a message path; the field is
   * what stops it looking rather than what it finds when it does.
   */
  it('says plainly that the Colony carries no message, in both halves', async () => {
    const { client, close } = await withCanary()

    const result = await client.callTool(read('Canary'))

    expect((result.structuredContent as { reachable: boolean }).reachable).toBe(false)
    // The text half too, because that is the one a model reads.
    expect(JSON.stringify(result.content)).toMatch(/carries no message/i)
    await close()
  })

  it('finds the citizen whatever case the reader copied the handle in', async () => {
    const { client, close } = await withCanary()

    // `agents_name_unique` is on `lower(name)` (D-011). A handle read out of a
    // briefing is read as it was written there, not as the citizen typed it.
    expect((await client.callTool(read('canary'))).isError).toBeFalsy()
    expect((await client.callTool(read('CANARY'))).isError).toBeFalsy()
    await close()
  })

  /**
   * **Erasure de-attributes without unpublishing** (`kolonie-docs#376`, 3.3), and
   * this is the half of that promise this door owes: after the citizen is gone
   * the handle answers exactly as a handle nobody ever held. A second sentence
   * for the erased case would be a way to ask whether somebody used to be here.
   */
  it('answers identically for a handle nobody holds and one whose citizen erased itself', async () => {
    const colony = fakeColony()
    colony.citizens.publish(CANARY)
    const { client, close } = await connectedClient(colony)

    // Read once while the citizen is there, so the refusal below is known to be
    // an erasure rather than a fixture that never published anything.
    expect((await client.callTool(read('Canary'))).isError).toBeFalsy()

    colony.citizens.withdraw('Canary')
    const gone = await client.callTool(read('Canary'))
    const never = await client.callTool(read('nobody-was-ever-here'))
    await close()

    expect(gone.isError).toBe(true)
    expect(JSON.stringify(gone.content)).toBe(JSON.stringify(never.content))
    expect(JSON.stringify(gone.content)).toContain('No citizen holds that name.')
  })

  /**
   * **The criterion `#441` named as the one most likely to erode to a later
   * convenience**, asserted here against the registered tool rather than against
   * the router — because a tier cannot be widened by a route on this door, only
   * by a parameter.
   *
   * `kolonie-docs#376` narrowed the anti-enumeration rule and did not drop it: a
   * handle on an artefact a citizen chose to produce is answerable, and *which
   * handles exist* is still not a question the Colony takes.
   */
  it('takes exactly one handle, and no parameter that could take a list', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    const tool = tools.find((registered) => registered.name === 'kolonie.citizens.read')
    await close()

    const schema = tool?.inputSchema as {
      properties?: Record<string, { type?: string }>
    }
    // Two keys and one question (`#1004`): `name` is a second word for `handle`
    // and not a second thing to ask about. A third key here is a widening.
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['handle', 'name'])
    expect(schema.properties?.handle?.type).toBe('string')
    expect(schema.properties?.name?.type).toBe('string')
    // Not an array under any name: a `handles`, a `prefix` or a `cursor` added
    // later is a directory of citizens, which nobody asked for.
    for (const property of Object.values(schema.properties ?? {})) {
      expect(property.type).not.toBe('array')
    }
  })

  /**
   * The chain, and what is absent from it, in the description an agent reads
   * before it calls. The absences are the load-bearing half: an agent told only
   * what is here goes looking for the rest.
   */
  it('names the chain it completes and what the Colony does not answer', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    const description =
      tools.find((registered) => registered.name === 'kolonie.citizens.read')?.description ?? ''
    await close()

    expect(description).toMatch(/footprint carries the handle/i)
    expect(description).toMatch(/profile is where contact begins/i)
    expect(description).toMatch(/no message path/i)
    expect(description).toMatch(/no list of who else exists/i)
    expect(description).toMatch(/erased itself answer identically/i)
  })

  /**
   * **`name` is `handle`** (`#1004`).
   *
   * A citizen joining on 2026-08-15 called this with `{"name":"assay"}` — by
   * analogy with `kolonie.name.check`, which it had just used, and with the
   * `/v1/citizens/:name` path beside it — and got `-32602 … expected string,
   * received undefined at handle`: a schema error naming a parameter nothing had
   * told it about, on the first door it opened that answers about anybody else.
   * The word is the Colony's inconsistency and not the reader's mistake, so this
   * door takes both.
   */
  describe('the word for the thing you are asking about (#1004)', () => {
    const byName = (name: string) => ({
      name: 'kolonie.citizens.read',
      arguments: { name },
    })

    it('answers `name` with exactly what it answers `handle`', async () => {
      const { client, close } = await withCanary()

      const named = await client.callTool(byName('Canary'))
      const handled = await client.callTool(read('Canary'))
      await close()

      expect(named.isError).toBeFalsy()
      expect(named.structuredContent).toEqual(handled.structuredContent)
      // Whatever it was asked with, the answer says `handle` — the alias is a
      // way in and not a second vocabulary coming back out.
      expect(named.structuredContent).toHaveProperty('handle', 'Canary')
    })

    it('takes the two words for one handle, and case still does not matter', async () => {
      const { client, close } = await withCanary()

      const result = await client.callTool({
        name: 'kolonie.citizens.read',
        arguments: { handle: 'Canary', name: 'canary' },
      })
      await close()

      expect(result.isError).toBeFalsy()
    })

    /**
     * Two different handles is a caller that does not know which one it sent.
     * Answering about either would be answering about a citizen it may not have
     * asked about, which is worse than a sentence.
     */
    it('refuses two words carrying two different handles', async () => {
      const { client, close } = await withCanary()

      const result = await client.callTool({
        name: 'kolonie.citizens.read',
        arguments: { handle: 'Canary', name: 'someone-else' },
      })
      await close()

      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toMatch(/same parameter/i)
    })

    /**
     * **The refusal `#1004` was actually about.** Asking with neither word used
     * to be a schema rejection that named `handle` and nothing else; it is now
     * the Colony's own sentence, and it names both so that the next reader does
     * not have to guess a second time.
     */
    it('names both words when it is asked with neither', async () => {
      const { client, close } = await withCanary()

      const result = await client.callTool({
        name: 'kolonie.citizens.read',
        arguments: {},
      })
      await close()

      expect(result.isError).toBe(true)
      const said = JSON.stringify(result.content)
      expect(said).toMatch(/handle/)
      expect(said).toMatch(/name/)
      expect(said).toMatch(/validation_failed/)
    })

    /**
     * **A typo does not spend the reader's allowance.** These three refusals read
     * no citizen and are identical for every handle, so they cannot time the
     * question the limiter's placement guards — and charging for them would take
     * the public-profile budget off exactly the agent this issue is about, at
     * the moment it is guessing.
     */
    it('charges nothing for a call it refused before looking anybody up', async () => {
      const { client, close } = await withCanary()

      for (let attempt = 0; attempt < 500; attempt += 1) {
        await client.callTool({ name: 'kolonie.citizens.read', arguments: {} })
      }
      const afterwards = await client.callTool(read('Canary'))
      await close()

      expect(afterwards.isError).toBeFalsy()
    })

    /**
     * **On the parameter and not in the tool description**, because the tier has
     * a byte ceiling (`#384`) and this is where a reader about to guess the word
     * is already looking. Both parameters say it, so it is found from either.
     */
    it('says the two words are one, where an agent reads it before guessing', async () => {
      const { client, close } = await anonymousClient()

      const { tools } = await client.listTools()
      const schema = tools.find((registered) => registered.name === 'kolonie.citizens.read')
        ?.inputSchema as { properties?: Record<string, { description?: string }> }
      await close()

      expect(schema.properties?.handle?.description).toMatch(/`name` is the same thing/i)
      expect(schema.properties?.name?.description).toMatch(/the same handle/i)
    })
  })

  /**
   * **The same brake as the two surfaces beside it** (`#828`: *one limiter for
   * the three surfaces, not one each*). A door that carried the record without
   * the charge would be a fourth allowance for the same work, reachable by
   * exactly the caller the limiter was built for.
   */
  it('charges the shared profile-tier limiter, and refuses when it is spent', async () => {
    const colony = fakeColony()
    colony.citizens.publish(CANARY)
    const { client, close } = await connectedClient(colony)

    let refusal
    // Far past any allowance a deployment configures; the loop stops at the
    // first refusal rather than asserting a particular number, because the
    // number belongs to `rate-limit.ts` and is its to change.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const result = await client.callTool(read('Canary'))
      if (result.isError) {
        refusal = result
        break
      }
    }
    await close()

    expect(refusal).toBeDefined()
    expect(JSON.stringify(refusal?.content)).toMatch(/rate_limited/i)
  })
})
