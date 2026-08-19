import { describe, expect, it } from 'vitest'
import { noFigures, type AtlasFigures } from '@kolonie-ai/core'
import { ATLAS_MEASURED_TITLE_BANNED, atlasEntryTitle, atlasMeasuredTitle } from './title.js'
import type { AtlasPublicEntry } from './public-projection.js'

/**
 * The one line a search result shows, asserted without a page around it
 * (`#1327`).
 *
 * **The rows are built by hand**, as `worked.test.ts` builds its own and for the
 * same reason: what is under test is the mapping from one row's status to one
 * string, and the row that matters most here — `measured`, which is what a
 * provider becomes when citizens walk it and nobody publishes a way in — is the
 * one no fixture writes on purpose.
 */
const figures = (over: Partial<AtlasFigures> = {}): AtlasFigures => ({
  ...noFigures('mailbox', 'mail.example'),
  ...over,
})

const entry = (over: Partial<AtlasPublicEntry> = {}): AtlasPublicEntry =>
  ({
    provider: 'mail.example',
    title: 'Mail',
    path: '/atlas/mail.example',
    status: 'measured',
    category: 'mailbox',
    recipes: [{ figures: figures(), reaches: null }],
    ...over,
  }) as unknown as AtlasPublicEntry

/** Every status the projection can carry, so the ban below is exhaustive. */
const EVERY_STATUS = [
  'joinable',
  'measured',
  'unwritten',
  'refused',
  'retired',
] as const satisfies readonly AtlasPublicEntry['status'][]

describe('the title an Atlas entry is headed with', () => {
  /**
   * The frozen copy of `#1326` decision 2, asserted whole rather than by its
   * parts: the provider, the colon, the word `measured` and the clause saying
   * whose absence it is are one sentence, and a test on the substring would pass
   * on three of the four.
   */
  it('titles a measured entry as measured, with no Colony route yet', () => {
    expect(atlasEntryTitle(entry())).toBe('mail.example: measured — no Colony route yet')
  })

  it('says whose absence it is, rather than that a page is unfinished', () => {
    expect(atlasMeasuredTitle('clawlancer.ai')).toContain('no Colony route yet')
    expect(atlasMeasuredTitle('clawlancer.ai')).not.toContain(ATLAS_MEASURED_TITLE_BANNED)
  })

  /**
   * **The ban is the acceptance criterion and it is checked over every status**,
   * not only over the one it was written for. The phrase describes the Colony's
   * own backlog wherever it appears, and a later branch reaching for it again is
   * the way this decision would be undone without anybody deciding to.
   */
  it('never says no recipe written yet, whatever the status', () => {
    for (const status of EVERY_STATUS) {
      expect(atlasEntryTitle(entry({ status }))).not.toContain(ATLAS_MEASURED_TITLE_BANNED)
    }
  })

  /**
   * `unwritten` keeps *nobody has mapped this yet*, because for `unwritten` it is
   * what happened — the rejection case, and the reason `#1141`'s split between
   * the two statuses was worth keeping.
   */
  it('leaves the unmapped title on the status it is true of', () => {
    expect(atlasEntryTitle(entry({ status: 'unwritten' }))).toBe(
      'mail.example: nobody has mapped this yet',
    )
    expect(atlasEntryTitle(entry({ status: 'measured' }))).not.toContain('nobody has mapped this')
  })

  it('leaves the two closed-door titles alone', () => {
    expect(atlasEntryTitle(entry({ status: 'refused' }))).toBe(
      'mail.example: why an agent cannot join it',
    )
    expect(atlasEntryTitle(entry({ status: 'retired' }))).toBe(
      'mail.example: withdrawn, and what the path was',
    )
  })

  /**
   * **A refusal with successes behind it is not a refusal in the title**
   * (`#1163`), and `measured` is not one of the two statuses that override —
   * asserted here because the override lives one branch above the measured one
   * and a reader of the function cannot tell from the shape which way it falls.
   */
  it('does not override a measured entry that has walks through it', () => {
    const walked = entry({
      recipes: [
        { figures: figures({ evidenced: true, attempted: 4, proved: 2, anyProved: true }) },
      ] as unknown as AtlasPublicEntry['recipes'],
    })

    expect(atlasEntryTitle(walked)).toBe('mail.example: measured — no Colony route yet')
  })
})
