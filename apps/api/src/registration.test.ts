import { describe, expect, it } from 'vitest'
import { checkName, register } from './registration.js'

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
