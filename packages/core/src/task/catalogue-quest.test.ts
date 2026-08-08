import { describe, expect, it } from 'vitest'
import { CatalogueDeliverableSchema, RECIPE_STALE_AFTER_DAYS, isStale } from './catalogue-quest.js'

const walked = {
  kind: 'notion',
  provider: 'notion.so',
  title: 'A Notion workspace',
  category: 'knowledge-docs',
  status: 'joinable',
  steps: [{ actor: 'agent' as const, instruction: 'Sign up with the mailbox you proved.' }],
  proves: 'provider-mail' as const,
}

/**
 * A quest whose deliverable is a catalogue entry (`#525`).
 *
 * The catalogue grows only as fast as the maintainer writes entries, which
 * covers ten providers and not a thousand. The citizens are the ones who find
 * out, and until this existed that knowledge evaporated.
 */
describe('what a citizen hands in', () => {
  it('takes a walk somebody actually did', () => {
    expect(CatalogueDeliverableSchema.safeParse(walked).success).toBe(true)
  })

  /**
   * **A refusal is a valid deliverable**, and this is the assertion that says
   * so. *This provider cannot be joined honestly, and here is the wall* stops
   * every future agent trying; `#482` is such a finding and it arrived by
   * accident, because nothing was asking for one.
   */
  it('takes a finding that there is no honest way in', () => {
    const refusal = {
      kind: 'social',
      provider: 'walled.test',
      title: 'Walled — no honest route in',
      category: 'social-publishing',
      status: 'refused',
      refusal: 'Signup requires a phone number no citizen can hold.',
    }

    expect(CatalogueDeliverableSchema.safeParse(refusal).success).toBe(true)
  })

  /** The sentence is the whole value of the finding — it is what stops the next attempt. */
  it('refuses a finding that does not say what the wall was', () => {
    const result = CatalogueDeliverableSchema.safeParse({
      kind: 'social',
      provider: 'walled.test',
      title: 'Walled',
      category: 'social-publishing',
      status: 'refused',
    })

    expect(result.success).toBe(false)
  })

  it('refuses a recipe with no steps, and one that ends at a created account', () => {
    expect(CatalogueDeliverableSchema.safeParse({ ...walked, steps: [] }).success).toBe(false)
    expect(CatalogueDeliverableSchema.safeParse({ ...walked, proves: undefined }).success).toBe(
      false,
    )
  })

  /**
   * **What a citizen supplies is what a citizen walked.** `paid`, `referral` and
   * `contact` are curation and counterparty fields (`#548`) and are the
   * maintainer's; accepting them here would let a submission set them.
   */
  it('refuses a submission that tries to set the curation fields', () => {
    for (const extra of [{ paid: true }, { contact: 'us@example.test' }]) {
      expect(CatalogueDeliverableSchema.safeParse({ ...walked, ...extra }).success).toBe(false)
    }
  })
})

/**
 * **A recipe nobody has walked since March is a guess with a date on it**, and
 * the catalogue has to say which it is.
 */
describe('whether an entry is still trusted', () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  it('trusts one confirmed inside the window', () => {
    expect(isStale(daysAgo(RECIPE_STALE_AFTER_DAYS - 1))).toBe(false)
  })

  it('does not trust one confirmed longer ago than that', () => {
    expect(isStale(daysAgo(RECIPE_STALE_AFTER_DAYS + 1))).toBe(true)
  })

  /**
   * Never confirmed and confirmed long ago are one answer, because a reader can
   * act on neither. That is also what lets a failed walk mark an entry stale by
   * clearing the date rather than by setting a second flag.
   */
  it('treats never confirmed exactly as confirmed long ago', () => {
    expect(isStale(null)).toBe(true)
  })

  it('treats an unreadable date as unconfirmed rather than as current', () => {
    expect(isStale('not a date')).toBe(true)
  })
})
