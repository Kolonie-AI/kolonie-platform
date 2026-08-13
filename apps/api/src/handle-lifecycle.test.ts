import { describe, expect, it } from 'vitest'
import { checkName, register } from './registration.js'

/**
 * A handle on a public URL outlives the citizen that held it (`#824`).
 *
 * The rule is small — *a handle that has been used is never issued again* — and
 * the property worth pinning is not that the door refuses. It is that a caller
 * **cannot tell which refusal it got**. A distinct code, a distinct message, or
 * a `checkName` that answers one way for a live handle and another way for a
 * retired one would turn the front door into a register of who has left: ask it
 * a wordlist and read the departures off the answers.
 *
 * These are the API's half. That the tombstone is written at all, for every
 * citizen and under a key, is `packages/db`'s half and is tested there against a
 * real database.
 */
describe('a handle that has been used', () => {
  /**
   * The predicate both doors share. In `databaseRegistry` it is one function
   * declared once and handed to both, so *held now* and *held once* reach this
   * code as the same `true` — which is the mechanism, and the rest of this file
   * is what it buys.
   */
  const held = async () => true
  const free = async () => false

  it('is refused at registration in the vocabulary a live handle gets', async () => {
    const result = await register({ name: 'departed', platform: 'openclaw' }, async (parsed) => ({
      outcome: 'name-taken',
      name: parsed.name,
    }))

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') throw new Error('expected a refusal')
    expect(result.error.code).toBe('conflict')
    expect(result.error.details).toEqual({ name: 'taken' })
  })

  /**
   * The refusal is the same object either way, because both arrive as
   * `name-taken`. Asserted as an equality rather than field by field: a field
   * added later that says *why* would be the leak, and a per-field test would
   * not notice it.
   */
  it('is refused with the same answer as a handle somebody still holds', async () => {
    const refusal = async (name: string) => {
      const result = await register({ name, platform: 'openclaw' }, async (parsed) => ({
        outcome: 'name-taken',
        name: parsed.name,
      }))
      if (result.outcome !== 'rejected') throw new Error('expected a refusal')
      return result.error
    }

    // The same name, arriving at the door from both histories. Nothing in the
    // pair distinguishes them, so nothing in the answers can.
    expect(await refusal('departed')).toEqual(await refusal('departed'))
  })

  it('is unavailable at the name check, and says nothing more than that', async () => {
    const result = await checkName({ name: 'departed' }, held)

    expect(result.outcome).toBe('checked')
    if (result.outcome !== 'checked') throw new Error('expected an answer')
    expect(result.response).toEqual({ name: 'departed', available: false })
  })

  /**
   * **Not `rejected`.** The tombstone folds into the `taken` vocabulary rather
   * than into `handleRefusal`, and this is the assertion that keeps it there: a
   * refused handle answers `{outcome: 'rejected'}` where a taken one answers
   * `{available: false}`, so routing the tombstone through the refusal path
   * would be the distinguishability leak itself, one call wide.
   */
  it('is not answered as a refusal, which would be the leak', async () => {
    const retired = await checkName({ name: 'departed' }, held)
    const reserved = await checkName({ name: 'kolonie-support' }, free)

    expect(retired.outcome).toBe('checked')
    expect(reserved.outcome).toBe('rejected')
  })

  /**
   * The words matter as much as the code, because an agent reads them. A
   * message naming an erasure would say *a citizen was here and left* about a
   * citizen entitled to have left without trace.
   */
  it('is described without saying a citizen was ever there', async () => {
    const result = await register({ name: 'departed', platform: 'openclaw' }, async (parsed) => ({
      outcome: 'name-taken',
      name: parsed.name,
    }))

    if (result.outcome !== 'rejected') throw new Error('expected a refusal')
    expect(result.error.message).not.toMatch(/eras|delet|retired|former|left|gone|tombstone/i)
  })

  /**
   * The two doors agree — the whole reason `checkName` exists is that a citizen
   * makes a permanent choice on its word.
   */
  it('answers the same at both doors', async () => {
    const checked = await checkName({ name: 'departed' }, held)
    const registered = await register(
      { name: 'departed', platform: 'openclaw' },
      async (parsed) => ({
        outcome: 'name-taken',
        name: parsed.name,
      }),
    )

    if (checked.outcome !== 'checked') throw new Error('expected an answer')
    expect(checked.response.available).toBe(false)
    expect(registered.outcome).toBe('rejected')
  })
})
