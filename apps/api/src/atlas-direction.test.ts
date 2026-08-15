import { beforeEach, describe, expect, it } from 'vitest'
import { fakeProviderRecipes, type FakeProviderRecipes } from './__fixtures__/provider-recipes.js'
import { readAtlas } from './provider-recipes.js'

/**
 * The send/receive axis, as a reader of the Atlas meets it (`#976`).
 *
 * **The defect this is written against is a false negative, not a missing
 * field.** A citizen sent to earn `phone` needs a number that can *receive*, and
 * the shelf answered it with a refusal every clause of which was about carrier
 * registration for *sending*. So what is under test is not that a direction can
 * be stored — that is a column — but that storing one changes what the wrong
 * reader is told, and changes nothing for the right one.
 */

let recipes: FakeProviderRecipes

beforeEach(() => {
  recipes = fakeProviderRecipes()
})

/** The shape of the row that caused this: refused for sending, untested for receiving. */
function refusedForSending(provider = 'agentphone.ai'): void {
  recipes.write({
    kind: 'phone',
    provider,
    category: 'telephony',
    status: 'refused',
    direction: 'outbound',
    refusal: 'A2P registration wants a registered brand, which a citizen is not.',
  })
}

describe('a verdict measured one way does not answer the other', () => {
  /** The acceptance criterion `#976` names in as many words. */
  it('does not suppress a provider refused for sending from a reader asking to receive', async () => {
    refusedForSending()

    const result = await readAtlas({ kind: 'phone', direction: 'inbound' }, recipes, false)
    if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

    const entry = result.response.entries.find((one) => one.provider === 'agentphone.ai')

    // Still on the shelf: an unwalked entry is where the next walk comes from.
    expect(entry).toBeDefined()
    expect(entry?.status).toBe('unwritten')
    expect(entry?.recipes[0]?.refusal).toBeNull()
  })

  it('answers the reader the verdict was measured for with the refusal intact', async () => {
    refusedForSending()

    const result = await readAtlas({ kind: 'phone', direction: 'outbound' }, recipes, false)
    if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

    const entry = result.response.entries.find((one) => one.provider === 'agentphone.ai')

    expect(entry?.status).toBe('refused')
    expect(entry?.recipes[0]?.refusal).toContain('A2P registration')
  })

  it('leaves the shelf as it stands when nobody asked for a direction', async () => {
    refusedForSending()

    const result = await readAtlas({ kind: 'phone' }, recipes, false)
    if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

    expect(result.response.entries[0]?.status).toBe('refused')
  })

  /**
   * The conservative reading, and the reason the backfill exists: a verdict
   * recorded before the axis did answers everybody, because reading it as
   * *inbound only* would hide a real refusal from half the citizens who need it.
   */
  it('lets an unscoped verdict answer whichever direction is asked for', async () => {
    recipes.write({
      kind: 'phone',
      provider: 'unscoped.example',
      category: 'telephony',
      status: 'refused',
      refusal: 'nobody wrote down which way this was measured',
    })

    const result = await readAtlas({ kind: 'phone', direction: 'inbound' }, recipes, false)
    if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

    expect(result.response.entries[0]?.status).toBe('refused')
  })

  /**
   * The other half of the title of `#976`: the wall was being written down, in a
   * caution, where no filter could see it. A caution measured against sending is
   * not a warning to a reader who came to receive.
   */
  it('withholds a caution measured against the other direction', async () => {
    recipes.write({
      kind: 'phone',
      provider: 'partly.example',
      category: 'telephony',
      status: 'measured',
      direction: 'outbound',
      caution: 'Which countries a number may message is console-only.',
    })

    const asked = await readAtlas({ kind: 'phone', direction: 'inbound' }, recipes, false)
    if (asked.outcome !== 'ok') throw new Error('expected the read to succeed')

    // The figures survive — they count attempts, and those are true either way.
    expect(asked.response.entries[0]?.status).toBe('measured')
    expect(asked.response.entries[0]?.recipes[0]?.caution).toBeNull()
  })

  it('refuses a direction that is not one of the three', async () => {
    const result = await readAtlas({ kind: 'phone', direction: 'sideways' }, recipes, false)

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.message).toContain('inbound')
  })
})
