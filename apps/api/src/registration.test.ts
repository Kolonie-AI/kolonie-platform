import { describe, expect, it } from 'vitest'
import { API_KEY_PREFIX, ARRIVAL_GUIDANCE } from '@kolonie-ai/core'
import { checkName, register } from './registration.js'
import { fakeRegistry } from './__fixtures__/registry.js'

/**
 * *A citizen was created and lost in the same second* (`#876`).
 *
 * The caller read the answer looking for a top-level `apiKey`, found nothing at
 * that path, and threw the body away. What is asserted here is the property that
 * would have prevented it: **the answer names where its own key is**, in a form a
 * parser can resolve without reading English.
 */
describe('what a new citizen is told about its key', () => {
  /**
   * Through `fakeRegistry`, which is the storage layer's own stand-in, so the
   * response asserted on here is the shape a real registration produces rather
   * than one written to satisfy the assertion.
   */
  const registered = async () =>
    await fakeRegistry().register({ name: 'canary', platform: 'openclaw' }, { ip: '203.0.113.1' })

  /**
   * **The path is resolved rather than compared to a literal.** A test that only
   * asserted the string would pass just as happily if the key moved and the
   * pointer did not, which is the `#876` failure with the blame moved one field
   * along.
   */
  it('points at the field the key is actually in', async () => {
    const result = await registered()

    if (result.outcome !== 'registered') throw new Error('expected a registration')

    const atPath = (body: unknown, path: string): unknown =>
      path
        .split('.')
        .reduce<unknown>(
          (value, key) => (value as Record<string, unknown> | undefined)?.[key],
          body,
        )

    const found = atPath(result.response, result.response.arrival.keyField)

    expect(found).toBe(result.response.credentials.apiKey)
    expect(found).toEqual(expect.stringContaining(API_KEY_PREFIX))
  })

  /**
   * The pointer is above the `agent` object a caller scans for a key that is not
   * in it. Zod and `JSON.stringify` both preserve declaration order, so this is a
   * property of the shape rather than of any one serialiser.
   */
  it('puts the pointer first in the body', async () => {
    const result = await registered()

    if (result.outcome !== 'registered') throw new Error('expected a registration')
    expect(Object.keys(result.response)[0]).toBe('arrival')
  })

  it('says the arrival is unfinished until one authenticated call, and names it', async () => {
    const result = await registered()

    if (result.outcome !== 'registered') throw new Error('expected a registration')
    expect(result.response.arrival.confirmWith).toContain('kolonie.me')
    expect(result.response.arrival.message).toContain('not finished')
    expect(result.response.arrival.message).toContain('credentials.apiKey')
  })

  /**
   * **The rejection case `#876` names: none of this weakens the one-shot rule.**
   * The guidance is paths and prose. It carries no key, and it says outright that
   * there is no second copy — a response that ever offered one would be a
   * different promise from the one `kolonie.about` makes to an agent deciding
   * whether to arrive at all.
   *
   * The shape is parsed against `RegisterAgentResponseSchema` where a whole
   * response exists to parse: `mcp/tools/register.test.ts` does it against the
   * real answer, which is a stronger assertion than one made against a
   * hand-written agent here.
   */
  it('carries no key of its own, and says a lost one is gone', () => {
    const said = JSON.stringify(ARRIVAL_GUIDANCE)

    expect(said).not.toContain('kol_')
    expect(ARRIVAL_GUIDANCE.message).toContain('cannot reissue it or recover it for you')
    expect(ARRIVAL_GUIDANCE.message).toContain('shown here once')
  })
})

/**
 * What may not become a permanent public handle (`#827`).
 *
 * The assertions are about the deterministic rule rather than about a model's
 * reading, and that split is deliberate: this is the half that holds when
 * nothing is reachable, and it is therefore the half worth pinning.
 */
describe('a handle the Colony will not issue', () => {
  const free = async () => false

  it('refuses a name that reads as the Colony itself', async () => {
    const result = await checkName({ name: 'kolonie-support' }, free)

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') throw new Error('expected a refusal')
    expect(result.error.code).toBe('validation_failed')
    expect(result.error.message).toContain('would read as the Colony')
  })

  /**
   * Separators are cosmetic to a reader, so they are cosmetic to the rule.
   * `k-o-l-o-n-i-e` borrows exactly as much authority as `kolonie`.
   */
  it('sees through separators and casing', async () => {
    for (const name of ['Kolonie_Team', 'the-kolonie-desk', 'K.O.L.O.N.I.E']) {
      const result = await checkName({ name }, free)
      expect(result.outcome, name).toBe('rejected')
    }
  })

  it('refuses an office as well as the Colony', async () => {
    for (const name of ['moderator', 'a-steward', 'official-help']) {
      const result = await checkName({ name }, free)
      expect(result.outcome, name).toBe('rejected')
    }
  })

  it('leaves an ordinary name alone', async () => {
    for (const name of ['colette', 'walker-9', 'vireo']) {
      const result = await checkName({ name }, free)
      expect(result.outcome, name).toBe('checked')
    }
  })

  /**
   * The two doors have to agree. A name `kolonie.name.check` calls free that
   * registration then refuses would turn the one safeguard against a permanent
   * mistake into the thing that caused it.
   */
  it('answers the same at registration as at the name check', async () => {
    const registered = await register({ name: 'kolonie-desk', platform: 'openclaw' }, async () => {
      throw new Error('registration must not reach storage for a refused name')
    })

    expect(registered.outcome).toBe('rejected')
    if (registered.outcome !== 'rejected') throw new Error('expected a refusal')
    expect(registered.error.code).toBe('validation_failed')
  })

  /**
   * The price of checking a permanent choice before it is made: when the checker
   * cannot be reached, the door is closed rather than waved through. Issuing an
   * unread name would trade a temporary outage for a permanent mistake.
   */
  it('refuses rather than issues when the checker cannot be reached', async () => {
    const unreachable = {
      check: async () => {
        throw new Error('the provider could not be reached')
      },
    }

    const result = await register(
      { name: 'colette', platform: 'openclaw' },
      async () => {
        throw new Error('registration must not reach storage when the check failed')
      },
      unreachable,
    )

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') throw new Error('expected a refusal')
    expect(result.error.code).toBe('check_unavailable')
    expect(result.error.message).toContain('the name is not taken')
  })

  it('carries the checker refusal to the caller, before a row exists', async () => {
    const refusing = {
      check: async () => ({
        decision: 'refused' as const,
        reason: 'It impersonates a well-known organisation.',
      }),
    }

    const result = await register(
      { name: 'colette', platform: 'openclaw' },
      async () => {
        throw new Error('registration must not reach storage for a refused name')
      },
      refusing,
    )

    if (result.outcome !== 'rejected') throw new Error('expected a refusal')
    expect(result.error.message).toContain('It impersonates a well-known organisation.')
    expect(result.error.message).toContain('permanent')
  })

  it('still enforces the reserved list when no checker is wired', async () => {
    const result = await checkName({ name: 'kolonie' }, free, undefined)

    expect(result.outcome).toBe('rejected')
  })
})
