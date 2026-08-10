import { describe, expect, it } from 'vitest'
import { ENTRY_WALKS_TERMS, entryWalksProgress } from './catalogue-quest.js'
import { QuestDraftSchema } from './quest.js'
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

/**
 * A quest tests an entry at scale (`#602`).
 *
 * **The reframing this issue is: a quest is the wrong instrument for a first
 * entry and the right one for finding out whether one holds.** To get a recipe
 * into the catalogue through a quest, somebody must first decide to pay for one
 * — so the catalogue would grow only where money was spent in advance. What only
 * money can buy is twenty walks of something that already works.
 */
describe('a quest measured in walks (#602)', () => {
  const quest = {
    title: 'Does the Notion recipe hold at twenty walks?',
    description: 'Twenty agents walk a recipe one agent already walked.',
    instructions: 'Walk the published Notion recipe and report what happened, whatever happened.',
    slots: 20,
    expiresAt: '2026-12-01T00:00:00.000Z',
    reward: { lamports: 1_000_000, reputation: 1 },
    questions: [{ key: 'stopped-at', prompt: 'How far did you get, and where did it stop?' }],
  }

  it('names the entry it is about and the number of walks it buys', () => {
    expect(
      QuestDraftSchema.safeParse({
        ...quest,
        deliverable: 'entry-walks',
        catalogueProvider: 'notion.so',
        walksAsked: 20,
      }).success,
    ).toBe(true)
  })

  it('refuses one that names no entry, because there is nothing to walk', () => {
    expect(
      QuestDraftSchema.safeParse({ ...quest, deliverable: 'entry-walks', walksAsked: 20 }).success,
    ).toBe(false)
  })

  it('refuses one that buys no number of walks, because there is nothing to fill', () => {
    expect(
      QuestDraftSchema.safeParse({
        ...quest,
        deliverable: 'entry-walks',
        catalogueProvider: 'notion.so',
      }).success,
    ).toBe(false)
  })

  /** A count on a deliverable not measured in walks is a promise nothing honours. */
  it('refuses a walk count on a report quest', () => {
    expect(QuestDraftSchema.safeParse({ ...quest, walksAsked: 20 }).success).toBe(false)
  })

  it('leaves the two deliverables that came before it alone', () => {
    expect(QuestDraftSchema.safeParse(quest).success).toBe(true)
    expect(QuestDraftSchema.safeParse({ ...quest, deliverable: 'catalogue-entry' }).success).toBe(
      true,
    )
  })

  describe('what it is measured in', () => {
    /**
     * **Recorded walks and not submitted documents.** `#601` records a walk as a
     * by-product of an agent obtaining an account; nothing is written up.
     */
    it('counts down to done as walks arrive', () => {
      expect(entryWalksProgress({ asked: 20, recorded: 0 })).toEqual({
        done: false,
        remaining: 20,
      })
      expect(entryWalksProgress({ asked: 20, recorded: 19 })).toEqual({
        done: false,
        remaining: 1,
      })
      expect(entryWalksProgress({ asked: 20, recorded: 20 })).toEqual({ done: true, remaining: 0 })
    })

    /**
     * **A run where most agents failed is done and is paid.** Twenty attempting
     * and four getting through is the finding; a quest that only filled on
     * success would draw its figures from a population selected for having
     * succeeded.
     */
    it('is done on attempts, whatever the attempts found', () => {
      expect(entryWalksProgress({ asked: 20, recorded: 24 })).toEqual({ done: true, remaining: 0 })
    })
  })

  /**
   * The other half of *an attempt to withhold figures after a run*: there is no
   * way to ask. What the sponsor buys is stated in the quest's own terms, and
   * the terms say the figures are published either way.
   */
  it('says in its own terms that unflattering figures are published, and a failed run is paid', () => {
    expect(ENTRY_WALKS_TERMS).toContain('whether or not they flatter')
    expect(ENTRY_WALKS_TERMS).toContain('is paid')
    expect(ENTRY_WALKS_TERMS).toContain('no payment moves')
  })

  /**
   * **No position field is introduced, and this is what checks it** rather than
   * a paragraph asking the next person to remember. `#548` requires that none
   * exist anywhere in the Atlas; a quest that could buy one would be that rule
   * dying at the one moment money is involved.
   */
  it('introduces nothing a sponsor could pay to move', () => {
    const settable = Object.keys(QuestDraftSchema.shape)

    for (const forbidden of [/\bposition\b/i, /\brank\b/i, /sortOrder/i, /pinned/i, /featured/i]) {
      expect(settable.filter((name) => forbidden.test(name))).toEqual([])
    }
  })
})
