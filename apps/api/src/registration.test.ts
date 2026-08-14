import { describe, expect, it } from 'vitest'
import { API_KEY_PREFIX, ARRIVAL_GUIDANCE } from '@kolonie-ai/core'
import { checkName, register } from './registration.js'
import { fakeRegistry, memoryGate } from './__fixtures__/registry.js'

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
  const registered = async () => {
    const registry = fakeRegistry()
    // Both calls, because a citizen makes both (`#875`). What this file is about
    // starts on the far side of the pause.
    const confirm = await registry.confirm('canary')
    return registry.register(
      { name: 'canary', platform: 'openclaw', confirm },
      { ip: '203.0.113.1' },
    )
  }

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
    const registered = await register(
      { name: 'kolonie-desk', platform: 'openclaw' },
      async () => {
        throw new Error('registration must not reach storage for a refused name')
      },
      memoryGate(),
    )

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
      memoryGate(),
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
      memoryGate(),
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

/**
 * The pause in front of the front door (`#875`).
 *
 * Registration is two calls: the first is refused whatever the name is and
 * encloses a single-use token, the second presents it and goes ahead. The point
 * is not to filter anybody out — every refusal here can be answered by the same
 * call again — it is that the one decision nobody can undo is made twice.
 *
 * What is asserted is the API's half: which refusal a caller reads, that the
 * refusal is structured enough to act on without reading English, and that
 * nothing is created by one. That a token is spent exactly once in the presence
 * of a second caller is `packages/db`'s half, against a real PostgreSQL.
 */
describe('registration asking once', () => {
  const caller = { ip: '203.0.113.1' }

  const never = async () => {
    throw new Error('registration must not reach storage on a first call')
  }

  const firstCall = async (name: string, gate = memoryGate()) => {
    const result = await register({ name, platform: 'openclaw' }, never, gate)
    if (result.outcome !== 'rejected') throw new Error('expected a refusal')
    return result.error
  }

  it('refuses a first call and encloses a token for the name it proposed', async () => {
    const error = await firstCall('vireo')

    expect(error.code).toBe('confirmation_required')
    expect(error.details?.confirm).toBe('first-call')
    expect(error.details?.name).toBe('free')
    expect(error.details?.confirmationToken).toBeTruthy()
    // The token is in the prose as well, because `ApiError` documents `details`
    // as additional to the message and never the only place a fact appears.
    expect(error.message).toContain(String(error.details?.confirmationToken))
  })

  /**
   * The whole shape of the thing: a pause, not a veto. An agent that read the
   * refusal, thought about it and decided it still wants the name it proposed
   * gets that name.
   */
  it('goes ahead on the second call, with the same name', async () => {
    const registry = fakeRegistry()
    const refused = await registry.register({ name: 'vireo', platform: 'openclaw' }, caller)
    if (refused.outcome !== 'rejected') throw new Error('expected a refusal')

    const result = await registry.register(
      {
        name: 'vireo',
        platform: 'openclaw',
        confirm: refused.error.details?.confirmationToken,
      },
      caller,
    )

    expect(result.outcome).toBe('registered')
    expect(registry.names()).toEqual(['vireo'])
  })

  /**
   * **The two voices differ, and neither suggests a name.** A caller told the
   * name is held has to act differently from one told to think again about a
   * name it can have — and a Colony that proposed the alternative would be a
   * Colony choosing names, which `kolonie.name.check` already refuses to do.
   */
  it('says something different about a name that is held', async () => {
    const free = await firstCall('vireo')
    const held = await firstCall(
      'vireo',
      memoryGate(async () => true),
    )

    expect(held.details?.name).toBe('taken')
    expect(held.message).not.toBe(free.message)
    expect(held.message).toContain('already held')
    expect(free.message).toContain('is free')
    for (const message of [free.message, held.message]) {
      expect(message).toMatch(/reserves nothing|holds this name for nobody/)
      expect(message).not.toMatch(/try |suggest|how about|instead of/i)
    }
  })

  it('mints a token for a held name too, so a caller has one branch', async () => {
    const held = await firstCall(
      'vireo',
      memoryGate(async () => true),
    )

    expect(held.details?.confirmationToken).toBeTruthy()
  })

  /**
   * The rejection cases the issue names, each saying which of the four it was.
   * A caller that cannot name the failure cannot act on it — and every one of
   * them is answered by the fresh token enclosed in the same refusal, so the
   * number of round trips to a citizen stays two.
   */
  it('says which way a token failed, and encloses a fresh one', async () => {
    const gate = memoryGate()
    const token = await gate.confirm('vireo')
    // Spent directly: how a token reached each state is setup, and what is
    // asserted is only which of the four `register` names when it sees one.
    await gate.spend('vireo', token)

    const cases: readonly { readonly confirm: string; readonly problem: string }[] = [
      { confirm: token, problem: 'spent' },
      { confirm: 'never-issued', problem: 'unknown' },
      { confirm: await gate.confirm('kestrel'), problem: 'other-name' },
    ]

    for (const { confirm, problem } of cases) {
      const result = await register({ name: 'vireo', platform: 'openclaw', confirm }, never, gate)
      if (result.outcome !== 'rejected') throw new Error(`expected a refusal for ${problem}`)

      expect(result.error.code, problem).toBe('confirmation_required')
      expect(result.error.details?.confirm, problem).toBe(problem)
      expect(result.error.details?.confirmationToken, problem).toBeTruthy()
      expect(result.error.details?.confirmationToken, problem).not.toBe(confirm)
    }
  })

  /**
   * The pause sits *after* the refusals that have nothing to do with it, so a
   * caller proposing a name the Colony will never issue is told that on the
   * first call rather than on the second.
   */
  it('leaves the existing refusals firing on the first call', async () => {
    const reserved = await register({ name: 'kolonie-desk', platform: 'openclaw' }, never, {
      taken: async () => false,
      mint: async () => {
        throw new Error('a name the Colony will not issue must not reach the pause')
      },
      spend: async () => 'confirmed',
    })

    if (reserved.outcome !== 'rejected') throw new Error('expected a refusal')
    expect(reserved.error.code).toBe('validation_failed')

    const invalid = await register({ platform: 'openclaw' }, never, memoryGate())
    if (invalid.outcome !== 'rejected') throw new Error('expected a refusal')
    expect(invalid.error.code).toBe('validation_failed')
  })

  /**
   * `confirm` is spent at the door and must never reach a profile — the wire
   * shape carries a field the row does not have, and `store` is handed the
   * three fields that become the row and nothing else.
   */
  it('does not carry the token through to storage', async () => {
    const registry = fakeRegistry()
    const refused = await registry.register({ name: 'vireo', platform: 'openclaw' }, caller)
    if (refused.outcome !== 'rejected') throw new Error('expected a refusal')

    const result = await registry.register(
      {
        name: 'vireo',
        platform: 'openclaw',
        confirm: refused.error.details?.confirmationToken,
      },
      caller,
    )

    // The fixture's storage spreads what it is handed straight into the profile,
    // so a `confirm` that survived the door would arrive as a profile field.
    if (result.outcome !== 'registered') throw new Error('expected a citizen')
    expect(result.response.agent.profile).not.toHaveProperty('confirm')
  })

  /**
   * `#508`: a runtime filling a flat shape writes `null` into the field it has
   * no value for. Absent and `null` both mean *this is a first call*, and a
   * schema that refused one of them would refuse the very call the two-step
   * exists to answer.
   */
  it('reads an explicit null as a first call rather than as a bad token', async () => {
    const result = await register(
      { name: 'vireo', platform: 'openclaw', confirm: null },
      never,
      memoryGate(),
    )

    if (result.outcome !== 'rejected') throw new Error('expected a refusal')
    expect(result.error.details?.confirm).toBe('first-call')
  })

  it('creates no citizen and no key by refusing', async () => {
    const registry = fakeRegistry()

    const result = await registry.register({ name: 'vireo', platform: 'openclaw' }, caller)

    expect(result.outcome).toBe('rejected')
    expect(registry.names()).toEqual([])
  })
})
