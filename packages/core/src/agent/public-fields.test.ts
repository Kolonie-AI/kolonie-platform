import { describe, expect, it } from 'vitest'
import {
  PRIVATE_AGENT_COLUMNS,
  PUBLIC_CITIZEN_FIELDS,
  PUBLIC_DECLARED_FIELDS,
  PUBLIC_PROVED_FIELDS,
  PUBLIC_SOURCE_COLUMNS,
} from './public-fields.js'
import { MODERATED_PROFILE_FIELDS } from './profile-review.js'
import { PUBLIC_RECORD_NEVER_CARRIES, PublicCitizenRecordSchema } from './public-record.js'

/**
 * The lists that decide what *public* means (`#817`).
 *
 * These assertions are cheap and the thing they guard is not: a field that
 * reaches the public record without reaching the moderation list is a field
 * published without ever being read, and it would arrive in a diff that looks
 * like it is about something else.
 */
describe('the public field lists', () => {
  /**
   * The pair that must never drift, and the reason both lists exist.
   *
   * `#827` reads every field in `MODERATED_PROFILE_FIELDS` before publishing it.
   * If the public record grew a declared field that list did not know about,
   * nothing would ever look at it — so the two are the same list, asserted
   * rather than kept in step by hand.
   */
  it('publishes exactly the declared fields that are moderated', () => {
    expect([...PUBLIC_DECLARED_FIELDS]).toEqual([...MODERATED_PROFILE_FIELDS])
  })

  it('keeps proved and declared apart, with nothing in both', () => {
    const overlap = PUBLIC_PROVED_FIELDS.filter((field) =>
      (PUBLIC_DECLARED_FIELDS as readonly string[]).includes(field),
    )

    expect(overlap).toEqual([])
  })

  it('carries every field the record schema has, and no others', () => {
    const inSchema = Object.keys(PublicCitizenRecordSchema.shape).sort()

    expect([...PUBLIC_CITIZEN_FIELDS].sort()).toEqual(inSchema)
  })

  /**
   * The three refusals `kolonie-docs#319` argued separately. Asserted by name
   * because each is a field somebody will reasonably try to add, and the reason
   * it is refused is not obvious from the column name.
   */
  it('refuses the three fields that look publishable and are not', () => {
    for (const refused of ['disposition', 'goal', 'declaredRhythmMinutes']) {
      expect(PRIVATE_AGENT_COLUMNS).toContain(refused)
      expect(PUBLIC_CITIZEN_FIELDS).not.toContain(refused)
    }
  })

  /**
   * The URL is private even though the image is public. Publishing it is what
   * `#823` exists to prevent: a page rendering it announces every visitor to a
   * host the citizen chose.
   */
  it('keeps the citizen’s own avatar URL private while the image is public', () => {
    expect(PRIVATE_AGENT_COLUMNS).toContain('avatarUrl')
    expect(PUBLIC_CITIZEN_FIELDS).toContain('avatar')
    expect(PUBLIC_CITIZEN_FIELDS).not.toContain('avatarUrl')
    expect(PUBLIC_RECORD_NEVER_CARRIES).toContain('avatarUrl')
  })

  it('never carries a column it also calls private', () => {
    const both = PUBLIC_SOURCE_COLUMNS.filter((column) =>
      (PRIVATE_AGENT_COLUMNS as readonly string[]).includes(column),
    )

    expect(both).toEqual([])
  })

  it('holds the denylist and the allowlist to the same answer', () => {
    for (const refused of PUBLIC_RECORD_NEVER_CARRIES) {
      expect(PUBLIC_CITIZEN_FIELDS).not.toContain(refused)
    }
  })
})
